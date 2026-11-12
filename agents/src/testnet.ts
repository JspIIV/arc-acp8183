// Runs the reference agents against the v2 contracts on Arc Testnet. Real transactions,
// test money only.
//
//   cd agents
//   bun run testnet:keys     # once: makes three agent keys, prints their addresses
//   (fund the three addresses with test USDC; gas on Arc is paid in USDC)
//   bun run demo:testnet     # add --skip-reject to skip the slow rejection scenario
import {
  createPublicClient, createWalletClient, formatUnits, http, parseEventLogs, parseUnits,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACP_ABI, BOND_ABI, ERC20_ABI, REPUTATION_ABI, STATUS } from "./abi";
import { Agent, type Pub, type Wallet } from "./agent";
import { checkSummary } from "./demo";
import { ClientAgent, EvaluatorAgent, MemoryStore, ProviderAgent, type Job, type ReviewResult } from "./roles";
import { arcTestnet, D, IDENTITY, REPUTATION } from "./networks";

const GAS_ALLOWANCE = parseUnits("0.2", 6);
const BUDGET = parseUnits("0.5", 6);
const BOND = parseUnits("0.5", 6);        // the hook locks 50% of a budget per job; the bond is freed after each job
const GAS_MARGIN = parseUnits("0.3", 6);  // gas on Arc is paid in USDC
// The client funds scenario A, then scenario B before B's refund comes back.
const MIN_BALANCE = { client: BUDGET * 2n + GAS_MARGIN, provider: GAS_MARGIN, evaluator: GAS_MARGIN };

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

  const freeBond = await read<bigint>(D.hook, BOND_ABI, "freeBond", [provider.address]);
  const needsBond = freeBond < BUDGET / 2n;
  const need: Array<[Agent, bigint]> = [
    [client, MIN_BALANCE.client],
    [provider, MIN_BALANCE.provider + (needsBond ? BOND : 0n)],
    [evaluator, MIN_BALANCE.evaluator],
  ];
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
  if (needsBond) {
    await providerRole.stakeBond(BOND);
    console.log(`staked ${usdc(BOND)} bond`);
  } else console.log(`free bond already ${usdc(freeBond)}`);
  const agentId = await providerRole.ensureAgentId(IDENTITY, "https://github.com/JspIIV/arc-acp8183");
  console.log(`agentId ${agentId} linked to the bond hook`);

  const summary = async () => {
    const [count, value] = await read<readonly [bigint, bigint, number]>(REPUTATION, REPUTATION_ABI, "getSummary", [agentId, [D.hook], "", ""]);
    return { count, value };
  };
  const repBefore = await summary();
  console.log(`reputation before: ${repBefore.count} entries, average ${repBefore.value}`);

  const feedbackIn = (res: ReviewResult) => ({
    feedback: parseEventLogs({ abi: REPUTATION_ABI, eventName: "NewFeedback", logs: res.logs }),
    skipped: parseEventLogs({ abi: BOND_ABI, eventName: "ReputationSkipped", logs: res.logs }),
    failed: parseEventLogs({ abi: BOND_ABI, eventName: "ReputationFailed", logs: res.logs }),
  });

  // ------------------------------------------------------------------ Scenario A
  console.log("\n== Scenario A: good work is approved and paid");
  const owedOf = (a: Address) => read<bigint>(D.acp, ACP_ABI, "owed", [a]);
  const owedBefore = { provider: await owedOf(provider.address), evaluator: await owedOf(evaluator.address), treasury: await owedOf(treasury) };
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
  console.log(`reputation: ${afterA.count} entries, average ${afterA.value} (was ${repBefore.count} / ${repBefore.value})`);
  assert(afterA.count === repBefore.count + 1n, "reputation entry count went up by one");

  const platform = (BUDGET * platformBps) / 10_000n;
  const evalFee = (BUDGET * evaluatorBps) / 10_000n;
  const creditedProvider = (await owedOf(provider.address)) - owedBefore.provider;
  const creditedEvaluator = (await owedOf(evaluator.address)) - owedBefore.evaluator;
  const creditedTreasury = (await owedOf(treasury)) - owedBefore.treasury;
  console.log(`credited in the contract: provider ${usdc(creditedProvider)}, evaluator ${usdc(creditedEvaluator)}, treasury ${usdc(creditedTreasury)} (${treasury})`);
  assert(creditedProvider === BUDGET - platform - evalFee, "provider credit");
  assert(creditedEvaluator === evalFee, "evaluator fee credit");
  assert(creditedTreasury === platform, "treasury fee credit");

  // Gas on Arc is paid in USDC, so a wallet's balance rises by the payout minus the withdraw's own gas.
  const walletBefore = { provider: await balance(provider.address), evaluator: await balance(evaluator.address) };
  await provider.write(D.acp, ACP_ABI, "withdraw");
  await evaluator.write(D.acp, ACP_ABI, "withdraw");
  const gotProvider = (await balance(provider.address)) - walletBefore.provider;
  const gotEvaluator = (await balance(evaluator.address)) - walletBefore.evaluator;
  console.log(`withdrawn: provider +${usdc(gotProvider)}, evaluator +${usdc(gotEvaluator)} (after paying gas in USDC)`);
  assert(gotProvider <= creditedProvider && gotProvider > creditedProvider - GAS_ALLOWANCE, "provider received the payout minus gas");
  assert(gotEvaluator <= creditedEvaluator && gotEvaluator > creditedEvaluator - GAS_ALLOWANCE, "evaluator received the fee minus gas");

  // ------------------------------------------------------------------ Scenario B
  if (skipReject) {
    console.log("\nSkipping scenario B (--skip-reject).");
  } else {
    console.log("\n== Scenario B: bad work is rejected, client is refunded, bond is slashed");
    const slashOwedOf = (a: Address) => read<bigint>(D.hook, BOND_ABI, "slashOwed", [a]);
    const owedClientBefore = await owedOf(client.address), slashBefore = await slashOwedOf(client.address);
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

    const refund = (await owedOf(client.address)) - owedClientBefore;
    const slashed = (await slashOwedOf(client.address)) - slashBefore;
    console.log(`credited to the client: refund ${usdc(refund)}, slashed bond ${usdc(slashed)}`);
    assert(refund === BUDGET, "client is owed the full budget");
    assert(slashed === BUDGET / 2n, "client is owed half the budget as slashed bond");
    const clientWallet = await balance(client.address);
    await client.write(D.acp, ACP_ABI, "withdraw");
    await client.write(D.hook, BOND_ABI, "withdrawSlash");
    const gain = (await balance(client.address)) - clientWallet;
    console.log(`withdrawn: client +${usdc(gain)} (after paying gas in USDC)`);
    assert(gain <= refund + slashed && gain > refund + slashed - GAS_ALLOWANCE, "client received refund and slashed bond minus gas");
    const afterB = await summary();
    console.log(`reputation: ${afterB.count} entries, average ${afterB.value}`);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
