// Runs the client, provider and evaluator agents in a loop on Arc Testnet and keeps a record
// of every job and transaction. Real transactions, test money only, our own agents only.
//
//   cd agents
//   bun run testnet:keys          # makes/keeps the seven agent keys, prints their addresses
//   bun run loop:testnet          # --jobs 26 (default) --seed 42
//
// Output: docs/testnet/activity.json (the record) and docs/testnet-activity.md (the numbers).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACP_ABI, BOND_ABI, ERC20_ABI, REPUTATION_ABI, STATUS } from "./abi";
import { Agent, type Pub, type Wallet } from "./agent";
import { renderMarkdown, summarize, usdcText, type FinalStatus, type JobKind, type JobRecord, type RunRecord, type TxRecord } from "./activity";
import { checkSummary } from "./demo";
import { arcTestnet, D, IDENTITY, REPUTATION, explorerTx } from "./networks";
import { ClientAgent, EvaluatorAgent, MemoryStore, ProviderAgent, type Job } from "./roles";

const DOCS = resolve(import.meta.dir, "../../docs");
const JSON_PATH = resolve(DOCS, "testnet/activity.json");
const MD_PATH = resolve(DOCS, "testnet-activity.md");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdc = (v: bigint) => `${usdcText(v)} USDC`;
const u = (x: string) => parseUnits(x, 6);

/** An agent that reports every confirmed transaction to whoever is listening. */
class RecAgent extends Agent {
  static sink: ((t: TxRecord) => void) | null = null;
  override async write(to: Address, abi: Parameters<Agent["write"]>[1], fn: string, args: readonly unknown[] = [], gas?: bigint) {
    const r = await super.write(to, abi, fn, args, gas);
    RecAgent.sink?.({ fn, hash: r.transactionHash, block: r.blockNumber.toString(), from: this.address });
    return r;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec { kind: JobKind; budget: bigint; ci: number; pi: number; ei: number; workMs: number; reviewMs: number; topic: string; bad: string }

const BUDGETS = ["0.02", "0.03", "0.05", "0.05", "0.05", "0.08", "0.10"].map(u);
const TOPICS = [
  "how USDC pays gas on Arc", "what an ERC-8004 agent identity is", "why escrow needs an independent evaluator",
  "how a provider bond is slashed", "what a dispute window protects against", "how CCTP moves USDC between chains",
  "why settlement is pull based", "what the ERC-8183 job states are", "how reputation is recorded after a job",
];
const BAD = ["lol", "SUMMARY: ok", "no label here, just some words that are long enough to pass a length check"];

function plan(n: number, rnd: () => number): Spec[] {
  const rejects = Math.max(2, Math.round(n * 0.15)), expires = Math.max(1, Math.round(n * 0.08));
  const kinds: JobKind[] = [
    ...Array<JobKind>(rejects).fill("reject"), ...Array<JobKind>(expires).fill("expire"),
    ...Array<JobKind>(Math.max(0, n - rejects - expires)).fill("approve"),
  ];
  return kinds.map((kind, i) => ({
    kind,
    budget: BUDGETS[Math.floor(rnd() * BUDGETS.length)]!,
    ci: i % 2, pi: i % 3, ei: Math.floor(rnd() * 2),
    workMs: Math.floor(rnd() * 12_000), reviewMs: Math.floor(rnd() * 6_000),
    topic: TOPICS[Math.floor(rnd() * TOPICS.length)]!,
    bad: BAD[Math.floor(rnd() * BAD.length)]!,
  }));
}

function load(envName: string, name: string, pub: Pub): RecAgent {
  const key = process.env[envName];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${envName} is missing. Run \`bun run testnet:keys\`.`);
  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(undefined, { retryCount: 8, retryDelay: 400 }) }) as Wallet;
  return new RecAgent(name, wallet, pub);
}

async function main(): Promise<void> {
  const arg = (flag: string, dflt: number) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? Number(process.argv[i + 1]) : dflt;
  };
  const total = arg("--jobs", 26);
  const seed = arg("--seed", Date.now() % 100_000);
  const rnd = mulberry32(seed);

  const pub = createPublicClient({ chain: arcTestnet, pollingInterval: 600, transport: http(undefined, { retryCount: 8, retryDelay: 400 }) }) as Pub;
  const clients = [load("AGENT_CLIENT_KEY", "client", pub), load("AGENT_CLIENT_2_KEY", "client2", pub)];
  const providers = [load("AGENT_PROVIDER_KEY", "provider", pub), load("AGENT_PROVIDER_2_KEY", "provider2", pub), load("AGENT_PROVIDER_3_KEY", "provider3", pub)];
  const evaluators = [load("AGENT_EVALUATOR_KEY", "evaluator", pub), load("AGENT_EVALUATOR_2_KEY", "evaluator2", pub)];
  const everyone = [...clients, ...providers, ...evaluators];
  const read = <T>(to: Address, abi: Parameters<Agent["read"]>[1], fn: string, args: readonly unknown[] = []) =>
    pub.readContract({ address: to, abi, functionName: fn, args }) as Promise<T>;
  const balance = (a: Address) => read<bigint>(D.usdc, ERC20_ABI, "balanceOf", [a]);
  const owedOf = (a: Address) => read<bigint>(D.acp, ACP_ABI, "owed", [a]);
  const chainNow = async () => Number((await pub.getBlock()).timestamp);
  const stampOf = async (block: string | bigint) => Number((await pub.getBlock({ blockNumber: BigInt(block) })).timestamp);

  const store = new MemoryStore();
  const cRole = clients.map((a) => new ClientAgent(a, D));
  const pRole = providers.map((a) => new ProviderAgent(a, D, store));
  const eRole = evaluators.map((a) => new EvaluatorAgent(a, D, store));

  console.log(`== Loop: ${total} jobs, seed ${seed}`);
  const platformBps = Number(await read<bigint>(D.acp, ACP_ABI, "platformFeeBps"));
  const evaluatorBps = Number(await read<bigint>(D.acp, ACP_ABI, "evaluatorFeeBps"));
  const window = await read<bigint>(D.acp, ACP_ABI, "disputeWindow");
  const arbiters = await read<readonly Address[]>(D.acp, ACP_ABI, "arbiters");
  const party = new Set(everyone.map((a) => a.address.toLowerCase()));
  if (!(window > 0n && arbiters.some((a) => !party.has(a.toLowerCase())))) console.log("note: rejections here are final at once (no dispute window or no eligible arbiter)");
  console.log(`fees ${platformBps}/${evaluatorBps} bps, dispute window ${window}s`);

  const run: RunRecord & { other?: TxRecord[] } = {
    startedAt: new Date().toISOString(), platformBps, evaluatorBps,
    contracts: { acp: D.acp, hook: D.hook, chainId: arcTestnet.id }, jobs: [], other: [],
  };
  let current: JobRecord | null = null;
  RecAgent.sink = (t) => (current ? current.txs : run.other!).push(t);

  // ------------------------------------------------------------------ Funding
  console.log("\n== Balances");
  const TARGET = { client: u("0.8"), provider: u("0.5"), evaluator: u("0.15") };
  const roleOf = (a: Agent) => (clients.includes(a as RecAgent) ? "client" : providers.includes(a as RecAgent) ? "provider" : "evaluator") as keyof typeof TARGET;
  const donors = [providers[0]!, evaluators[0]!, clients[0]!];
  for (const a of everyone) {
    let have = await balance(a.address);
    const want = TARGET[roleOf(a)];
    for (const d of donors) {
      if (have >= want) break;
      if (d === a) continue;
      const spare = (await balance(d.address)) - TARGET[roleOf(d)] - u("0.1");
      const give = spare < want - have ? spare : want - have;
      if (give > 0n) { await d.write(D.usdc, ERC20_ABI, "transfer", [a.address, give]); have += give; }
    }
    console.log(`${a.name.padEnd(10)} ${a.address} ${usdc(await balance(a.address))}`);
    if ((await balance(a.address)) < want) throw new Error(`${a.name} is short of test USDC; fund ${a.address}`);
  }

  // ------------------------------------------------------------------ Provider setup
  const agentIds = new Map<string, bigint>();
  for (let i = 0; i < providers.length; i++) {
    const free = await read<bigint>(D.hook, BOND_ABI, "freeBond", [providers[i]!.address]);
    if (free < u("0.1")) await pRole[i]!.stakeBond(u("0.2"));
    agentIds.set(providers[i]!.address, await pRole[i]!.ensureAgentId(IDENTITY, "https://github.com/JspIIV/arc-acp8183"));
  }
  console.log(`providers ready: ${[...agentIds.values()].map(String).join(", ")}`);

  const save = () => {
    mkdirSync(resolve(DOCS, "testnet"), { recursive: true });
    const all: RunRecord[] = existsSync(JSON_PATH) ? (JSON.parse(readFileSync(JSON_PATH, "utf8")) as { runs: RunRecord[] }).runs : [];
    const others = all.filter((r) => r.startedAt !== run.startedAt);
    writeFileSync(JSON_PATH, JSON.stringify({ runs: [...others, run] }, null, 2) + "\n");
  };

  // ------------------------------------------------------------------ Jobs
  const specs = plan(total, rnd);
  const proposals: Array<{ rec: JobRecord; ci: number; endsAt: bigint }> = [];
  const expiring: Array<{ rec: JobRecord; ci: number; at: bigint }> = [];
  const sweep = async () => {
    current = null;
    for (const a of everyone) {
      if ((await owedOf(a.address)) > 0n) await a.write(D.acp, ACP_ABI, "withdraw");
      if (clients.includes(a as RecAgent) && (await read<bigint>(D.hook, BOND_ABI, "slashOwed", [a.address])) > 0n) await a.write(D.hook, BOND_ABI, "withdrawSlash");
    }
  };
  const rebalance = async () => {
    current = null;
    for (const c of clients) {
      if ((await balance(c.address)) >= u("0.25")) continue;
      const rich = (await Promise.all(providers.map(async (p) => ({ p, b: await balance(p.address) })))).sort((x, y) => Number(y.b - x.b))[0]!;
      const give = rich.b - u("0.45") > u("0.5") ? u("0.5") : rich.b - u("0.45");
      if (give > 0n) { await rich.p.write(D.usdc, ERC20_ABI, "transfer", [c.address, give]); console.log(`  moved ${usdc(give)} from ${rich.p.name} back to ${c.name}`); }
    }
  };

  let failures = 0;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!;
    const c = clients[s.ci]!, p = providers[s.pi]!, e = evaluators[s.ei]!;
    const rec: JobRecord = {
      id: "0", kind: s.kind, client: c.address, provider: p.address, evaluator: e.address,
      budget: s.budget.toString(), workMs: s.workMs, reviewMs: s.reviewMs, txs: [],
    };
    current = rec;
    try {
      const ttl = s.kind === "expire" ? 90n : 3600n;
      const id = await cRole[s.ci]!.createJob(p.address, e.address, `Summarise ${s.topic}`, ttl);
      rec.id = id.toString();
      await pRole[s.pi]!.setBudget(id, s.budget);
      await cRole[s.ci]!.fund(id, e.address);
      rec.createdAt = await stampOf(rec.txs.find((t) => t.fn === "createJob")!.block);

      if (s.kind === "expire") {
        const job = await read<Job>(D.acp, ACP_ABI, "getJob", [id]);
        expiring.push({ rec, ci: s.ci, at: job.expiredAt });
      } else {
        await sleep(s.workMs);
        const good = `SUMMARY: A short note on ${s.topic}, written by ${p.name} for job ${id}.`;
        const sub = await pRole[s.pi]!.submit(id, s.kind === "approve" ? good : s.bad);
        rec.submittedAt = await stampOf(sub.blockNumber);
        await sleep(s.reviewMs);
        const res = await eRole[s.ei]!.review(id, checkSummary, sub.blockNumber);
        rec.decidedAt = await stampOf(res.blockNumber);
        if (s.kind === "reject") {
          const status = STATUS[(await read<Job>(D.acp, ACP_ABI, "getJob", [id])).status];
          if (status === "Submitted") {
            const d = await read<{ challengeEndsAt: bigint }>(D.acp, ACP_ABI, "getDispute", [id]);
            proposals.push({ rec, ci: s.ci, endsAt: d.challengeEndsAt });
          }
        }
      }
      console.log(`[${i + 1}/${specs.length}] ${s.kind.padEnd(7)} job ${rec.id} ${usdc(s.budget)} ${p.name}/${e.name}`);
      failures = 0;
    } catch (err) {
      failures++;
      console.log(`[${i + 1}/${specs.length}] ${s.kind} FAILED: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      if (failures >= 3) throw new Error("three failures in a row, stopping");
    }
    run.jobs.push(rec);
    save();
    if ((i + 1) % 5 === 0) { await sweep(); await rebalance(); }
  }

  // ------------------------------------------------------------------ Settle what is waiting
  for (const x of proposals) {
    for (;;) {
      const left = Number(x.endsAt) - (await chainNow());
      if (left < 0) break;
      console.log(`waiting ${left}s for the challenge window of job ${x.rec.id}`);
      await sleep(Math.min(30_000, left * 1000 + 1500));
    }
    current = x.rec;
    await clients[x.ci]!.write(D.acp, ACP_ABI, "finalizeRejection", [BigInt(x.rec.id)], 600_000n);
    x.rec.settledAt = await chainNow();
    console.log(`finalized rejection of job ${x.rec.id}`);
    save();
  }
  for (const x of expiring) {
    for (;;) {
      const left = Number(x.at) - (await chainNow());
      if (left < 0) break;
      console.log(`waiting ${left}s for job ${x.rec.id} to expire`);
      await sleep(Math.min(30_000, left * 1000 + 1500));
    }
    current = x.rec;
    await clients[x.ci]!.write(D.acp, ACP_ABI, "claimRefund", [BigInt(x.rec.id)]);
    x.rec.settledAt = await chainNow();
    console.log(`refund claimed for expired job ${x.rec.id}`);
    save();
  }
  await sweep();
  await rebalance();

  // ------------------------------------------------------------------ Read the truth back from the chain
  console.log("\n== Checking every job on chain");
  for (const rec of run.jobs) {
    if (rec.id === "0") continue;
    rec.finalStatus = STATUS[(await read<Job>(D.acp, ACP_ABI, "getJob", [BigInt(rec.id)])).status] as FinalStatus;
  }
  run.finishedAt = new Date().toISOString();
  save();

  const repLines: string[] = ["## Provider reputation (ERC-8004 ReputationRegistry, entries written by the bond hook)", ""];
  for (const p of providers) {
    const id = agentIds.get(p.address)!;
    const [count, value] = await read<readonly [bigint, bigint, number]>(REPUTATION, REPUTATION_ABI, "getSummary", [id, [D.hook], "", ""]);
    repLines.push(`- ${p.address} (agentId ${id}): ${count} entries, average ${value}`);
  }
  const all = (JSON.parse(readFileSync(JSON_PATH, "utf8")) as { runs: RunRecord[] }).runs;
  writeFileSync(MD_PATH, renderMarkdown(all, arcTestnet.blockExplorers.default.url, repLines));

  const s = summarize([run]);
  console.log(`\njobs ${s.totalJobs} | ${JSON.stringify(s.byStatus)} | escrowed ${usdc(s.escrowed)} | paid to providers ${usdc(s.paidToProviders)} | refunded ${usdc(s.refundedToClients)} | slashed bonds ${usdc(s.slashedBonds)} | unique addresses ${s.uniqueAddresses}`);
  if (s.unexpected.length) console.log("did not end as planned:\n" + s.unexpected.join("\n"));
  console.log(`\nrecord: ${JSON_PATH}\nsummary: ${MD_PATH}`);
  console.log(`example: ${explorerTx(run.jobs.find((j) => j.txs.length)?.txs[0]?.hash ?? "")}`);
  for (const a of everyone) console.log(`${a.name.padEnd(10)} ${formatUnits(await balance(a.address), 6)} USDC`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
