// Takes the job that a CCTP transfer funded all the way to payment: the provider submits work,
// the evaluator approves, both withdraw. Shows that money which arrived from another chain ends
// up where an ordinary job's money does. Reads and updates docs/testnet/cctp.json.
//
//   bun run cctp:finish
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatUnits, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACP_ABI, STATUS } from "./abi";
import { Agent, type Pub, type Wallet } from "./agent";
import { checkSummary } from "./demo";
import { arcTestnet, D, explorerTx } from "./networks";
import { EvaluatorAgent, MemoryStore, ProviderAgent, type Job } from "./roles";

const FILE = resolve(import.meta.dir, "../../docs/testnet/cctp.json");
const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;

class Rec extends Agent {
  readonly hashes: Array<{ fn: string; hash: Hex }> = [];
  override async write(to: Address, abi: Abi, fn: string, args: readonly unknown[] = [], gas?: bigint) {
    const r = await super.write(to, abi, fn, args, gas);
    this.hashes.push({ fn, hash: r.transactionHash });
    return r;
  }
}

const pub = createPublicClient({ chain: arcTestnet, transport: http(undefined, { retryCount: 6, retryDelay: 400 }), pollingInterval: 700 }) as Pub;
const mk = (envName: string, name: string) =>
  new Rec(name, createWalletClient({ account: privateKeyToAccount(process.env[envName] as Hex), chain: arcTestnet, transport: http() }) as Wallet, pub);

const rec = JSON.parse(readFileSync(FILE, "utf8"));
const t = [...rec.transfers].reverse().find((x: { outcome?: string; finish?: unknown }) => x.outcome?.startsWith("job funded") && !x.finish);
if (!t) throw new Error("no funded transfer without a finish yet");
const jobId = BigInt(t.jobId);

const provider = mk("AGENT_PROVIDER_3_KEY", "provider3");
const evaluator = mk("AGENT_EVALUATOR_2_KEY", "evaluator2");
const store = new MemoryStore();
const job = await provider.read<Job>(D.acp, ACP_ABI, "getJob", [jobId]);
if (STATUS[job.status] !== "Funded") throw new Error(`job ${jobId} is ${STATUS[job.status]}, expected Funded`);
console.log(`job ${jobId} is Funded with ${usdc(job.budget)} that arrived from Base Sepolia`);

const owed = (a: Address) => provider.read<bigint>(D.acp, ACP_ABI, "owed", [a]);
const before = await owed(provider.address);

const sub = await new ProviderAgent(provider, D, store).submit(jobId, "SUMMARY: Arc is a stablecoin-native chain where USDC pays gas and settlement is deterministic.");
const verdict = await new EvaluatorAgent(evaluator, D, store).review(jobId, checkSummary, sub.blockNumber);
const credit = (await owed(provider.address)) - before;
console.log(`evaluator: ${verdict.approved ? "approved" : "rejected"} (${verdict.reason}); provider credited ${usdc(credit)}`);
await provider.write(D.acp, ACP_ABI, "withdraw");
await evaluator.write(D.acp, ACP_ABI, "withdraw");
const final = STATUS[(await provider.read<Job>(D.acp, ACP_ABI, "getJob", [jobId])).status];
console.log(`job ${jobId} is now ${final}`);

t.finish = {
  submitTx: provider.hashes.find((h) => h.fn === "submit")?.hash,
  decisionTx: verdict.txHash,
  verdict: verdict.reason,
  providerCredited: credit.toString(),
  finalStatus: final,
};
writeFileSync(FILE, JSON.stringify(rec, null, 2) + "\n");
console.log(`submit ${explorerTx(t.finish.submitTx!)}\ndecision ${explorerTx(verdict.txHash)}`);
