import { formatUnits, parseUnits, type Address } from "viem";
import { ACP_ABI, BOND_ABI, ERC20_ABI, STATUS } from "./abi";
import type { Agent } from "./agent";
import {
  ClientAgent, EvaluatorAgent, MemoryStore, ProviderAgent,
  type Deployment, type Job, type Verdict,
} from "./roles";

const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`demo check failed: ${msg}`);
}

/** The task-specific part of the evaluator: a summary must be labelled and not trivially short. */
export function checkSummary(content: string): Verdict {
  if (!content.startsWith("SUMMARY:")) return { approved: false, reason: "missing SUMMARY label" };
  if (content.length < 40) return { approved: false, reason: "summary too short" };
  return { approved: true, reason: "meets the brief" };
}

export interface Cast {
  client: Agent;
  provider: Agent;
  evaluator: Agent;
  treasury: Address;
}

const FEE = { platformBps: 200n, evaluatorBps: 100n };
const BUDGET = parseUnits("10", 6);

export async function runDemo(d: Deployment, cast: Cast): Promise<void> {
  const store = new MemoryStore();
  const client = new ClientAgent(cast.client, d);
  const provider = new ProviderAgent(cast.provider, d, store);
  const evaluator = new EvaluatorAgent(cast.evaluator, d, store);
  const balance = (a: Address) => cast.client.read<bigint>(d.usdc, ERC20_ABI, "balanceOf", [a]);

  console.log("\n== Provider posts a bond (50% of a budget is needed per job)");
  await provider.stakeBond(parseUnits("20", 6));

  // ---------------------------------------------------------------- Scenario A
  console.log("\n== Scenario A: good work is approved and paid");
  const before = {
    provider: await balance(cast.provider.address), evaluator: await balance(cast.evaluator.address),
    treasury: await balance(cast.treasury),
  };
  const jobA = await client.createJob(cast.provider.address, cast.evaluator.address, "Summarise the Arc docs", 86_400n);
  await provider.setBudget(jobA, BUDGET);
  await client.fund(jobA, cast.evaluator.address);
  console.log(`job ${jobA} funded with ${usdc(BUDGET)}`);

  await provider.submit(jobA, "SUMMARY: Arc is a stablecoin-native chain where USDC pays gas and settlement is deterministic.");
  const verdictA = await evaluator.review(jobA, checkSummary);
  console.log(`evaluator verdict: ${verdictA.approved ? "approved" : "rejected"} (${verdictA.reason})`);
  assert(verdictA.approved, "scenario A should be approved");

  for (const a of [cast.provider, cast.evaluator]) await a.write(d.acp, ACP_ABI, "withdraw");
  // The treasury is a plain address in this demo, so its share stays credited in the contract.
  const treasuryOwed = await cast.client.read<bigint>(d.acp, ACP_ABI, "owed", [cast.treasury]);

  const platform = (BUDGET * FEE.platformBps) / 10_000n;
  const evalFee = (BUDGET * FEE.evaluatorBps) / 10_000n;
  const providerPay = BUDGET - platform - evalFee;
  const gotProvider = (await balance(cast.provider.address)) - before.provider;
  const gotEvaluator = (await balance(cast.evaluator.address)) - before.evaluator;
  console.log(`provider received ${usdc(gotProvider)}, evaluator ${usdc(gotEvaluator)}, treasury credited ${usdc(treasuryOwed)}`);
  assert(gotProvider === providerPay, "provider payout");
  assert(gotEvaluator === evalFee, "evaluator fee");
  assert(treasuryOwed === platform, "treasury fee");
  assert((await cast.client.read<bigint>(d.hook, BOND_ABI, "bondLocked", [cast.provider.address])) === 0n, "bond released");

  // ---------------------------------------------------------------- Scenario B
  console.log("\n== Scenario B: bad work is rejected, client is refunded, bond is slashed");
  const clientBefore = await balance(cast.client.address);
  const jobB = await client.createJob(cast.provider.address, cast.evaluator.address, "Summarise the Arc docs", 86_400n);
  await provider.setBudget(jobB, BUDGET);
  await client.fund(jobB, cast.evaluator.address);
  await provider.submit(jobB, "lol");

  const verdictB = await evaluator.review(jobB, checkSummary);
  console.log(`evaluator verdict: ${verdictB.approved ? "approved" : "rejected"} (${verdictB.reason})`);
  assert(!verdictB.approved, "scenario B should be rejected");

  await cast.client.write(d.acp, ACP_ABI, "withdraw");
  await cast.client.write(d.hook, BOND_ABI, "withdrawSlash");
  const clientAfter = await balance(cast.client.address);
  const bondShare = BUDGET / 2n;
  console.log(`client net change: ${usdc(clientAfter - clientBefore)} (budget refunded plus ${usdc(bondShare)} slashed bond)`);
  assert(clientAfter - clientBefore === bondShare, "client keeps the slashed bond and gets the budget back");

  // ---------------------------------------------------------------- Final state
  console.log("\n== Final job states");
  for (const id of [jobA, jobB]) {
    const job = await cast.client.read<Job>(d.acp, ACP_ABI, "getJob", [id]);
    console.log(`job ${id}: ${STATUS[job.status]}`);
  }
  console.log("\nAll checks passed.");
}
