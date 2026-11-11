// Runs the reference agents against the v2 contracts on Arc Testnet. Real transactions,
// test money only.
//
//   cd agents
//   bun run testnet:keys     # once: makes three agent keys, prints their addresses
//   (fund the three addresses with test USDC; gas on Arc is paid in USDC)
//   bun run demo:testnet     # add --skip-reject to skip the slow rejection scenario
import {
  createPublicClient, createWalletClient, defineChain, formatUnits, http, parseEventLogs, parseUnits,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACP_ABI, BOND_ABI, ERC20_ABI, REPUTATION_ABI, STATUS } from "./abi";
import { Agent, type Pub, type Wallet } from "./agent";
import { checkSummary } from "./demo";
import { ClientAgent, EvaluatorAgent, MemoryStore, ProviderAgent, type Deployment, type Job, type ReviewResult } from "./roles";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" } },
});

// Public addresses of the v2 rehearsal deployment (see ../README.md).
const D: Deployment = {
  usdc: "0x3600000000000000000000000000000000000000",
  acp: "0x557dC9bc9f401b319A1606D039B4FE1B5AC27971",
  hook: "0x7BD7eFe65c9787761502398fd272385A356c9AfE",
};
const IDENTITY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION: Address = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

const BUDGET = parseUnits("1", 6);
const BOND = parseUnits("1", 6);          // the hook needs 50% of a budget free; 1 USDC covers two jobs
const MIN_BALANCE = { client: parseUnits("2", 6), provider: parseUnits("2", 6), evaluator: parseUnits("0.5", 6) };

const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;
const link = (tx: Hex) => `${arcTestnet.blockExplorers.default.url}/tx/${tx}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`check failed: ${msg}`);
}

function loadAgent(envName: string, name: string, pub: Pub): Agent {
  const key = process.env[envName];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${envName} is missing. Run \`bun run testnet:keys\` first.`);
  }
  const account = privateKeyToAccount(key as Hex);
  return new Agent(name, createWalletClient({ account, chain: arcTestnet, transport: http() }) as Wallet, pub);
}

async function main(): Promise<void> {
  const skipReject = process.argv.includes("--skip-reject");
  const pub = createPublicClient({ chain: arcTestnet, transport: http() }) as Pub;
  const client = loadAgent("AGENT_CLIENT_KEY", "client", pub);
  const provider = loadAgent("AGENT_PROVIDER_KEY", "provider", pub);
  const evaluator = loadAgent("AGENT_EVALUATOR_KEY", "evaluator", pub);
  const read = <T>(to: Address, abi: Parameters<Agent["read"]>[1], fn: string, args: readonly unknown[] = []) =>
    client.read<T>(to, abi, fn, args);
  const balance = (a: Address) => read<bigint>(D.usdc, ERC20_ABI, "balanceOf", [a]);

  // ------------------------------------------------------------------ Preflight
  console.log("== Preflight");
  assert((await pub.getChainId()) === arcTestnet.id, "connected to Arc Testnet");
  for (const [label, addr] of [["AgenticCommerce", D.acp], ["BondHook", D.hook]] as const) {
    assert(((await pub.getCode({ address: addr })) ?? "0x") !== "0x", `${label} has code at ${addr}`);
  }
  const platformBps = await read<bigint>(D.acp, ACP_ABI, "platformFeeBps");
  const evaluatorBps = await read<bigint>(D.acp, ACP_ABI, "evaluatorFeeBps");
  const window = await read<bigint>(D.acp, ACP_ABI, "disputeWindow");
  const arbiters = await read<readonly Address[]>(D.acp, ACP_ABI, "arbiters");
  const hookOk = await read<boolean>(D.acp, ACP_ABI, "hookWhitelist", [D.hook]);
  const treasury = await read<Address>(D.acp, ACP_ABI, "treasury");
  console.log(`fees: platform ${platformBps} bps, evaluator ${evaluatorBps} bps | dispute window ${window}s | arbiters ${arbiters.length} | hook whitelisted ${hookOk}`);
  assert(hookOk, "the bond hook is whitelisted on the contract");
  const parties = new Set([client.address, provider.address, evaluator.address].map((a) => a.toLowerCase()));
  const rejectIsProposal = window > 0n && arbiters.some((a) => !parties.has(a.toLowerCase()));
  console.log(`a rejection here will be ${rejectIsProposal ? `a proposal (provider may challenge for ${window}s)` : "final at once (disputes off or no eligible arbiter)"}`);

  const need: Array<[Agent, bigint]> = [[client, MIN_BALANCE.client], [provider, MIN_BALANCE.provider], [evaluator, MIN_BALANCE.evaluator]];
  const short = [];
  for (const [a, min] of need) {
    const have = await balance(a.address);
    console.log(`${a.name.padEnd(9)} ${a.address}  ${usdc(have)}`);
    if (have < min) short.push(`${a.name} ${a.address} needs at least ${usdc(min)}`);
  }
  if (short.length) {
    console.log(`\nNot enough test USDC (gas on Arc is paid in USDC):\n- ${short.join("\n- ")}`);
    process.exit(2);
  }

  const store = new MemoryStore();
  const clientRole = new ClientAgent(client, D);
  const providerRole = new ProviderAgent(provider, D, store);
  const evaluatorRole = new EvaluatorAgent(evaluator, D, store);

  // ------------------------------------------------------------------ Provider setup
  console.log("\n== Provider: bond and ERC-8004 identity");
  const free = await read<bigint>(D.hook, BOND_ABI, "freeBond", [provider.address]);
  if (free < BUDGET) {
    await providerRole.stakeBond(BOND);
    console.log(`staked ${usdc(BOND)} bond`);
  } else console.log(`free bond already ${usdc(free)}`);
  const agentId = await providerRole.ensureAgentId(IDENTITY, "https://github.com/JspIIV/arc-acp8183");
  console.log(`agentId ${agentId} linked to the bond hook`);

  const summary = async () => {
    const [count, value] = await read<readonly [bigint, bigint, number]>(REPUTATION, REPUTATION_ABI, "getSummary", [agentId, [D.hook], "", ""]);
    return { count, value };
  };
  const repBefore = await summary();
  console.log(`reputation before: ${repBefore.count} entries, sum ${repBefore.value}`);

  const feedbackIn = (res: ReviewResult) => ({
    feedback: parseEventLogs({ abi: REPUTATION_ABI, eventName: "NewFeedback", logs: res.logs }),
    skipped: parseEventLogs({ abi: BOND_ABI, eventName: "ReputationSkipped", logs: res.logs }),
    failed: parseEventLogs({ abi: BOND_ABI, eventName: "ReputationFailed", logs: res.logs }),
  });

  // ------------------------------------------------------------------ Scenario A
  console.log("\n== Scenario A: good work is approved and paid");
  const before = { provider: await balance(provider.address), evaluator: await balance(evaluator.address) };
  const jobA = await clientRole.createJob(provider.address, evaluator.address, "Summarise the Arc docs", 86_400n);
  await providerRole.setBudget(jobA, BUDGET);
  await clientRole.fund(jobA, evaluator.address);
  const subA = await providerRole.submit(jobA, "SUMMARY: Arc is a stablecoin-native chain where USDC pays gas and settlement is deterministic.");
  const resA = await evaluatorRole.review(jobA, checkSummary, subA.blockNumber);
  console.log(`job ${jobA}: ${resA.approved ? "approved" : "rejected"} (${resA.reason})\n  ${link(resA.txHash)}`);
  assert(resA.approved, "scenario A is approved");

  const repA = feedbackIn(resA);
  assert(repA.skipped.length === 0 && repA.failed.length === 0, "no reputation skip or failure event");
  assert(repA.feedback.length === 1, "one NewFeedback event in the settlement transaction");
  const afterA = await summary();
  console.log(`reputation: ${afterA.count} entries, sum ${afterA.value} (was ${repBefore.count} / ${repBefore.value})`);
  assert(afterA.count === repBefore.count + 1n, "reputation entry count went up by one");

  await provider.write(D.acp, ACP_ABI, "withdraw");
  await evaluator.write(D.acp, ACP_ABI, "withdraw");
  const platform = (BUDGET * platformBps) / 10_000n;
  const evalFee = (BUDGET * evaluatorBps) / 10_000n;
  const gotProvider = (await balance(provider.address)) - before.provider;
  const gotEvaluator = (await balance(evaluator.address)) - before.evaluator;
  console.log(`provider +${usdc(gotProvider)}, evaluator +${usdc(gotEvaluator)}, treasury credited ${usdc(platform)} (${treasury})`);
  assert(gotProvider === BUDGET - platform - evalFee, "provider payout");
  assert(gotEvaluator === evalFee, "evaluator fee");

  // ------------------------------------------------------------------ Scenario B
  if (skipReject) {
    console.log("\nSkipping scenario B (--skip-reject).");
  } else {
    console.log("\n== Scenario B: bad work is rejected, client is refunded, bond is slashed");
    const clientBefore = await balance(client.address);
    const jobB = await clientRole.createJob(provider.address, evaluator.address, "Summarise the Arc docs", 86_400n);
    await providerRole.setBudget(jobB, BUDGET);
    await clientRole.fund(jobB, evaluator.address);
    const subB = await providerRole.submit(jobB, "lol");
    const resB = await evaluatorRole.review(jobB, checkSummary, subB.blockNumber);
    console.log(`job ${jobB}: ${resB.approved ? "approved" : "rejected"} (${resB.reason})\n  ${link(resB.txHash)}`);
    assert(!resB.approved, "scenario B is rejected");

    let status = STATUS[(await read<Job>(D.acp, ACP_ABI, "getJob", [jobB])).status];
    if (status === "Submitted") {
      const dispute = await read<{ challengeEndsAt: bigint }>(D.acp, ACP_ABI, "getDispute", [jobB]);
      console.log("the rejection is a proposal; waiting for the challenge window to close");
      for (;;) {
        const now = (await pub.getBlock()).timestamp;
        if (now > dispute.challengeEndsAt) break;
        console.log(`  ${dispute.challengeEndsAt - now}s left`);
        await sleep(Math.min(30_000, Number(dispute.challengeEndsAt - now) * 1000 + 1500));
      }
      const fin = await client.write(D.acp, ACP_ABI, "finalizeRejection", [jobB], 600_000n);
      console.log(`finalized by the client\n  ${link(fin.transactionHash)}`);
      status = STATUS[(await read<Job>(D.acp, ACP_ABI, "getJob", [jobB])).status];
    }
    assert(status === "Rejected", "job B ends Rejected");

    await client.write(D.acp, ACP_ABI, "withdraw");
    await client.write(D.hook, BOND_ABI, "withdrawSlash");
    const gain = (await balance(client.address)) - clientBefore;
    console.log(`client net change ${usdc(gain)} (budget refunded plus ${usdc(BUDGET / 2n)} slashed bond)`);
    assert(gain === BUDGET / 2n, "client keeps the slashed bond and gets the budget back");
    const afterB = await summary();
    console.log(`reputation: ${afterB.count} entries, sum ${afterB.value}`);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
