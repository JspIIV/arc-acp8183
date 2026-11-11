// Runs the exact calls the UI makes (same ABI, same encoders, same rules) against the real
// contracts on a throwaway local chain. Nothing is sent to a real network.
//
//   cd contracts && forge build && cd ../frontend && bun scripts/ui-calls-local.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient, createTestClient, createWalletClient, http, parseEventLogs, parseUnits, zeroAddress,
  type Abi, type Address, type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { ACP_ABI, BOND_HOOK_ABI, ERC20_ABI } from "../src/abis";
import {
  availableActions, deliverableHash, fundParams, reasonToBytes32, settlementGas, submitParams,
  type ActionId, type DisputeView,
} from "../src/lib/actions";
import type { ChainJob } from "../src/lib/chain";

const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const OUT = resolve(import.meta.dir, "../../contracts/out");
const U = (n: string) => parseUnits(n, 6);

const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });

function artifact(file: string): { abi: Abi; bytecode: { object: Hex } } {
  const p = resolve(OUT, file);
  if (!existsSync(p)) throw new Error(`missing ${p}. Run forge build in contracts/ first.`);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function waitForRpc() {
  for (let i = 0; i < 60; i++) {
    try { await pub.getChainId(); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("anvil did not start");
}

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error("FAILED: " + msg); }
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${String(a)}, expected ${String(b)})`);

async function main() {
  const anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "inherit" });
  try {
    await waitForRpc();
    // anvil unlocks its default accounts, so no keys are needed here.
    const accounts = (await pub.request({ method: "eth_accounts" })) as Address[];
    const [owner, client, provider, evaluator, treasury, arbiter, stranger] = accounts;
    const wallet = (account: Address) => createWalletClient({ account, chain, transport: http(RPC) });

    const send = async (from: Address, address: Address, abi: unknown, functionName: string, args: unknown[] = [], gas?: bigint) => {
      const hash = await wallet(from).writeContract({ address, abi: abi as Abi, functionName, args, gas, chain } as never);
      const r = await pub.waitForTransactionReceipt({ hash });
      assert(r.status === "success", `${functionName} reverted`);
      return r;
    };
    const read = <T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
      pub.readContract({ address, abi: abi as Abi, functionName, args }) as Promise<T>;

    async function deploy(a: { abi: Abi; bytecode: { object: Hex } }, args: unknown[]): Promise<Address> {
      const hash = await wallet(owner).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, chain });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;
    }
    const usdcArt = artifact("AgenticCommerce.t.sol/MockUSDC.json");
    const usdc = await deploy(usdcArt, []);
    const acp = await deploy(artifact("AgenticCommerce.sol/AgenticCommerce.json"), [usdc, treasury]);
    const hook = await deploy(artifact("BondHook.sol/BondHook.json"), [usdc, acp, zeroAddress, zeroAddress]);
    for (const a of [client, provider, evaluator]) await send(owner, usdc, usdcArt.abi, "mint", [a, U("1000")]);
    await send(owner, acp, ACP_ABI, "setHookWhitelist", [hook, true]);
    await send(owner, acp, ACP_ABI, "setPlatformFee", [200n, treasury]);
    await send(owner, acp, ACP_ABI, "setEvaluatorFee", [100n]);
    await send(owner, acp, ACP_ABI, "setDisputeConfig", [3600n, 3600n, U("1")]);
    await send(owner, acp, ACP_ABI, "addArbiter", [arbiter]);

    const now = async () => Number((await pub.getBlock()).timestamp);
    const warp = async (s: number) => { await testClient.increaseTime({ seconds: s }); await testClient.mine({ blocks: 1 }); };
    const getJob = (id: bigint) => read<ChainJob>(acp, ACP_ABI, "getJob", [id]).then((j) => ({ ...j, status: Number(j.status) }));
    const owed = (a: Address) => read<bigint>(acp, ACP_ABI, "owed", [a]);
    const balance = (a: Address) => read<bigint>(usdc, ERC20_ABI, "balanceOf", [a]);

    // The rule engine must offer the step the UI is about to send. This ties the rules to the chain.
    async function canDo(account: Address, id: bigint, action: ActionId) {
      const job = await getJob(id);
      const raw = job.status === 2 ? await read<{ state: number; challengeEndsAt: bigint; rulingDeadline: bigint; arbiter: string; deposit: bigint }>(acp, ACP_ABI, "getDispute", [id]) : null;
      const dispute: DisputeView | null = raw && { state: Number(raw.state), challengeEndsAt: BigInt(raw.challengeEndsAt), rulingDeadline: BigInt(raw.rulingDeadline), arbiter: raw.arbiter, deposit: BigInt(raw.deposit) };
      const ids = availableActions({ job, account, now: await now(), dispute }).map((a) => a.id);
      assert(ids.includes(action), `rules do not offer "${action}" to ${account.slice(0, 8)} (offered: ${ids.join(",") || "nothing"})`);
    }

    // Provider bond, like the Bond panel: approve then stake.
    await send(provider, usdc, ERC20_ABI, "approve", [hook, U("30")]);
    await send(provider, hook, BOND_HOOK_ABI, "stakeBond", [U("30")]);

    async function newJob(useHook: boolean, hours = 24): Promise<bigint> {
      const expiredAt = BigInt((await now()) + hours * 3600);
      const r = await send(client, acp, ACP_ABI, "createJob", [provider, evaluator, expiredAt, "UI call check", useHook ? hook : zeroAddress]);
      const ev = parseEventLogs({ abi: ACP_ABI as Abi, logs: r.logs, eventName: "JobCreated" })[0];
      return (ev.args as { jobId: bigint }).jobId;
    }
    async function toSubmitted(id: bigint, content: string) {
      await canDo(provider, id, "setBudget");
      await send(provider, acp, ACP_ABI, "setBudget", [id, U("10"), "0x"]);
      await canDo(client, id, "fund");
      await send(client, usdc, ERC20_ABI, "approve", [acp, U("10")]);
      await send(client, acp, ACP_ABI, "fund", [id, fundParams(U("10"))]);
      await canDo(provider, id, "submit");
      await send(provider, acp, ACP_ABI, "submit", [id, deliverableHash(content), submitParams("ipfs://example")]);
    }

    console.log("1. hooked job: approve and get paid");
    const j1 = await newJob(true);
    await toSubmitted(j1, "work one");
    await canDo(evaluator, j1, "complete");
    await send(evaluator, acp, ACP_ABI, "complete", [j1, reasonToBytes32("meets the brief"), "0x"], settlementGas(await getJob(j1)));
    eq((await getJob(j1)).status, 3, "job 1 completed");
    eq(await owed(provider), U("9.7"), "provider owed 9.7");
    const before = await balance(provider);
    await send(provider, acp, ACP_ABI, "withdraw");
    eq((await balance(provider)) - before, U("9.7"), "provider withdrew 9.7");

    console.log("2. rejection is challenged and overturned by the arbiter");
    const j2 = await newJob(true);
    await toSubmitted(j2, "work two");
    await canDo(evaluator, j2, "reject");
    await send(evaluator, acp, ACP_ABI, "reject", [j2, reasonToBytes32("not what I asked"), "0x"], settlementGas(await getJob(j2)));
    eq((await getJob(j2)).status, 2, "still submitted while the rejection can be challenged");
    await canDo(provider, j2, "challenge");
    await send(provider, usdc, ERC20_ABI, "approve", [acp, U("1")]);
    await send(provider, acp, ACP_ABI, "challengeRejection", [j2]);
    await canDo(arbiter, j2, "resolve");
    await send(arbiter, acp, ACP_ABI, "resolveDispute", [j2, false, reasonToBytes32("work is fine")], settlementGas(await getJob(j2)));
    eq((await getJob(j2)).status, 3, "job 2 completed after the overturn");

    console.log("3. rejection nobody challenges is finalized by a stranger");
    const j3 = await newJob(true);
    await toSubmitted(j3, "work three");
    await send(evaluator, acp, ACP_ABI, "reject", [j3, reasonToBytes32("bad"), "0x"], settlementGas(await getJob(j3)));
    await warp(3601);
    await canDo(stranger, j3, "finalize");
    await send(stranger, acp, ACP_ABI, "finalizeRejection", [j3], settlementGas(await getJob(j3)));
    eq((await getJob(j3)).status, 4, "job 3 rejected");
    eq(await owed(client), U("10"), "client owed the refund");
    eq(await read<bigint>(hook, BOND_HOOK_ABI, "slashOwed", [client]), U("5"), "client owed the slashed bond");

    console.log("4. funded job expires and anyone can refund the client");
    const j4 = await newJob(false, 1);
    await send(provider, acp, ACP_ABI, "setBudget", [j4, U("4"), "0x"]);
    await send(client, usdc, ERC20_ABI, "approve", [acp, U("4")]);
    await send(client, acp, ACP_ABI, "fund", [j4, fundParams(U("4"))]);
    await warp(3601);
    await canDo(stranger, j4, "claimRefund");
    await send(stranger, acp, ACP_ABI, "claimRefund", [j4]);
    eq((await getJob(j4)).status, 5, "job 4 expired");
    eq(await owed(client), U("14"), "client owed both refunds");

    console.log("5. client cancels an open job");
    const j5 = await newJob(false);
    await canDo(client, j5, "cancel");
    await send(client, acp, ACP_ABI, "reject", [j5, reasonToBytes32("cancelled by client"), "0x"]);
    eq((await getJob(j5)).status, 4, "job 5 cancelled");

    console.log("\nAll UI call checks passed.");
  } finally {
    anvil.kill();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
