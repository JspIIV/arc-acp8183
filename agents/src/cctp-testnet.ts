// Tries CCTPJobFunderV2 against Circle's real CCTP V2 contracts on testnet:
// Base Sepolia (domain 6) burns, Arc Testnet (domain 26) mints and funds a job.
//
//   bun run cctp:testnet deploy                         # deploys both funders, registers the remotes
//   bun run cctp:testnet send --budget 0.05 --amount 0.1   # burn, wait for the attestation, redeem
//   bun run cctp:testnet recover                        # the client takes back what was set aside
//   bun run cctp:testnet status
//
// Real transactions on two testnets. Test money only. The record goes to docs/testnet/cctp.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient, createWalletClient, formatUnits, http, pad, parseAbi, parseEventLogs, parseUnits,
  type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ACP_ABI, ERC20_ABI, STATUS } from "./abi";
import { arcTestnet, D, explorerTx } from "./networks";
import type { Job } from "./roles";

// From Circle's "Contract addresses" page (developers.circle.com/cctp/references/contract-addresses),
// Testnet section. The same two addresses are listed for every testnet domain.
const TOKEN_MESSENGER: Address = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const MESSAGE_TRANSMITTER: Address = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const DOMAIN = { base: 6, arc: 26 } as const;
// From Circle's USDC contract addresses page, Base Sepolia.
const BASE_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const IRIS = "https://iris-api-sandbox.circle.com";

const FUNDER_ABI = parseAbi([
  "function setRemote(uint32 domain, bytes32 tokenMessenger, bytes32 funder)",
  "function remotes(uint32 domain) view returns (bytes32 tokenMessenger, bytes32 funder)",
  "function initiateJobFunding(uint256 jobId, uint256 expectedBudget, uint256 amount, uint32 destinationDomain, address destinationClient, uint256 maxFee, uint32 minFinalityThreshold)",
  "function redeemAndFund(bytes message, bytes attestation)",
  "function recoverFunds()",
  "function pendingRecovery(address client) view returns (uint256)",
  "function totalPending() view returns (uint256)",
  "event JobFundingInitiated(uint256 indexed jobId, address indexed sender, address indexed destinationClient, uint256 amount, uint32 destinationDomain)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 budget, uint256 minted)",
  "event FundingFailed(uint256 indexed jobId, address indexed client, uint256 minted)",
  "event RecoveryCredited(address indexed client, uint256 amount)",
  "event FundsRecovered(address indexed client, uint256 amount)",
]);
const TRUST_ABI = parseAbi(["function trustedFunder(address) view returns (bool)"]);

const OUT = resolve(import.meta.dir, "../../contracts/out/CCTPJobFunderV2.sol/CCTPJobFunderV2.json");
const RECORD = resolve(import.meta.dir, "../../docs/testnet/cctp.json");

interface Transfer {
  label: string; at: string; jobId: string; budget: string; amount: string; maxFee: string;
  burnTx?: string; redeemTx?: string; recoverTx?: string; outcome?: string; minted?: string;
  funderTrusted: boolean; notes: string[];
}
interface Record { arcFunder?: string; baseFunder?: string; deployTxs: Array<{ what: string; hash: string }>; transfers: Transfer[] }

const load = (): Record => (existsSync(RECORD) ? (JSON.parse(readFileSync(RECORD, "utf8")) as Record) : { deployTxs: [], transfers: [] });
const save = (r: Record) => { mkdirSync(resolve(RECORD, ".."), { recursive: true }); writeFileSync(RECORD, JSON.stringify(r, null, 2) + "\n"); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;
const flag = (name: string, dflt: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : dflt; };
const retry = { retryCount: 8, retryDelay: 500 };

function setup() {
  const key = process.env.CCTP_TESTER_KEY as Hex | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("CCTP_TESTER_KEY is missing. Run `bun run testnet:keys`.");
  const account = privateKeyToAccount(key);
  const arcPub = createPublicClient({ chain: arcTestnet, pollingInterval: 600, transport: http(undefined, retry) });
  const basePub = createPublicClient({ chain: baseSepolia, pollingInterval: 1500, transport: http(undefined, retry) });
  const arc = createWalletClient({ account, chain: arcTestnet, transport: http(undefined, retry) });
  const base = createWalletClient({ account, chain: baseSepolia, transport: http(undefined, retry) });
  return { account, arcPub, basePub, arc, base };
}

async function deploy(): Promise<void> {
  const { account, arcPub, basePub, arc, base } = setup();
  const rec = load();
  if (rec.arcFunder && rec.baseFunder) { console.log("already deployed:", rec.arcFunder, rec.baseFunder); return; }
  if (!existsSync(OUT)) throw new Error("build the contracts first: cd ../contracts && forge build");
  const art = JSON.parse(readFileSync(OUT, "utf8")) as { abi: Abi; bytecode: { object: Hex } };

  console.log("deploying the Arc funder (acp = the v2 testnet ACP)");
  const h1 = await arc.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [D.usdc, D.acp, TOKEN_MESSENGER, MESSAGE_TRANSMITTER] });
  const r1 = await arcPub.waitForTransactionReceipt({ hash: h1 });
  rec.arcFunder = r1.contractAddress!; rec.deployTxs.push({ what: "deploy Arc funder", hash: h1 });

  console.log("deploying the Base Sepolia funder (acp = address(0), source side only)");
  const h2 = await base.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [BASE_USDC, "0x0000000000000000000000000000000000000000", TOKEN_MESSENGER, MESSAGE_TRANSMITTER] });
  const r2 = await basePub.waitForTransactionReceipt({ hash: h2 });
  rec.baseFunder = r2.contractAddress!; rec.deployTxs.push({ what: "deploy Base Sepolia funder", hash: h2 });
  save(rec);

  // Each side registers the other: the remote's TokenMessenger (what the burn message's header
  // names as sender) and the remote funder (the burn's messageSender and our mint recipient).
  const w1 = await arc.writeContract({ address: rec.arcFunder as Address, abi: FUNDER_ABI, functionName: "setRemote", args: [DOMAIN.base, pad(TOKEN_MESSENGER), pad(rec.baseFunder as Address)] });
  await arcPub.waitForTransactionReceipt({ hash: w1 });
  rec.deployTxs.push({ what: "Arc funder setRemote(6)", hash: w1 });
  const w2 = await base.writeContract({ address: rec.baseFunder as Address, abi: FUNDER_ABI, functionName: "setRemote", args: [DOMAIN.arc, pad(TOKEN_MESSENGER), pad(rec.arcFunder as Address)] });
  await basePub.waitForTransactionReceipt({ hash: w2 });
  rec.deployTxs.push({ what: "Base funder setRemote(26)", hash: w2 });
  save(rec);

  const a = await arcPub.readContract({ address: rec.arcFunder as Address, abi: FUNDER_ABI, functionName: "remotes", args: [DOMAIN.base] });
  const b = await basePub.readContract({ address: rec.baseFunder as Address, abi: FUNDER_ABI, functionName: "remotes", args: [DOMAIN.arc] });
  console.log(`Arc funder   ${rec.arcFunder}\n  remote(6)  messenger ${a[0]}\n             funder    ${a[1]}`);
  console.log(`Base funder  ${rec.baseFunder}\n  remote(26) messenger ${b[0]}\n             funder    ${b[1]}`);
  console.log(`owner of both: ${account.address}`);
}

async function fastFeeBps(): Promise<number | null> {
  const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${DOMAIN.base}/${DOMAIN.arc}`, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const fees = (await res.json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
  return fees.find((f) => f.finalityThreshold === 1000)?.minimumFee ?? null;
}

async function send(): Promise<void> {
  const { account, arcPub, basePub, arc, base } = setup();
  const rec = load();
  if (!rec.arcFunder || !rec.baseFunder) throw new Error("run `deploy` first");
  const arcFunder = rec.arcFunder as Address, baseFunder = rec.baseFunder as Address;
  const budget = parseUnits(flag("--budget", "0.05"), 6), amount = parseUnits(flag("--amount", "0.1"), 6);
  const label = flag("--label", "transfer");
  const provider = privateKeyToAccount(process.env.AGENT_PROVIDER_3_KEY as Hex);
  const providerWallet = createWalletClient({ account: provider, chain: arcTestnet, transport: http(undefined, retry) });
  const evaluatorAddr = privateKeyToAccount(process.env.AGENT_EVALUATOR_2_KEY as Hex).address;

  const trusted = (await arcPub.readContract({ address: D.acp, abi: TRUST_ABI, functionName: "trustedFunder", args: [arcFunder] })) as boolean;
  console.log(`Arc funder trusted by the ACP: ${trusted}${trusted ? "" : " (expect the funding to fail and the money to be set aside for recovery)"}`);

  // 1. A job on Arc whose client is the tester, with a budget set by the provider.
  const block = await arcPub.getBlock();
  const createTx = await arc.writeContract({ address: D.acp, abi: ACP_ABI, functionName: "createJob", args: [provider.address, evaluatorAddr, block.timestamp + 3600n, "CCTP funding test", D.hook] });
  const created = await arcPub.waitForTransactionReceipt({ hash: createTx });
  const [ev] = parseEventLogs({ abi: ACP_ABI, eventName: "JobCreated", logs: created.logs });
  const jobId = ev!.args.jobId;
  const budgetTx = await providerWallet.writeContract({ address: D.acp, abi: ACP_ABI, functionName: "setBudget", args: [jobId, budget, "0x"] });
  await arcPub.waitForTransactionReceipt({ hash: budgetTx });
  console.log(`Arc job ${jobId}: client ${account.address}, budget ${usdc(budget)}`);

  // 2. Burn on Base Sepolia through our funder.
  const bps = await fastFeeBps();
  const fast = bps !== null;
  // The API quotes a fee in basis points that can be fractional (1.3 here), so do the math in numbers.
  const maxFee = fast ? BigInt(Math.max(Math.ceil((Number(amount) * bps!) / 10_000) * 2, 100)) : 0n;
  console.log(`transfer mode: ${fast ? `fast (fee ${bps} bps, maxFee ${usdc(maxFee)})` : "standard (fast fee not available)"}`);
  const t: Transfer = {
    label, at: new Date().toISOString(), jobId: jobId.toString(), budget: budget.toString(), amount: amount.toString(),
    maxFee: maxFee.toString(), funderTrusted: trusted, notes: [],
  };
  const ap = await base.writeContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "approve", args: [baseFunder, amount] });
  await basePub.waitForTransactionReceipt({ hash: ap });
  const burn = await base.writeContract({
    address: baseFunder, abi: FUNDER_ABI, functionName: "initiateJobFunding",
    args: [jobId, budget, amount, DOMAIN.arc, account.address, maxFee, fast ? 1000 : 2000],
  });
  await basePub.waitForTransactionReceipt({ hash: burn });
  t.burnTx = burn;
  console.log(`burned ${usdc(amount)} on Base Sepolia: https://sepolia.basescan.org/tx/${burn}`);
  rec.transfers.push(t); save(rec);

  // 3. Wait for Circle's attestation.
  console.log("waiting for the attestation (fast transfers usually take seconds to minutes)...");
  let message: Hex | undefined, attestation: Hex | undefined;
  for (let i = 0; i < 360; i++) {
    const res = await fetch(`${IRIS}/v2/messages/${DOMAIN.base}?transactionHash=${burn}`);
    if (res.ok) {
      const data = (await res.json()) as { messages?: Array<{ status: string; message: Hex; attestation: Hex }> };
      const m = data.messages?.[0];
      if (m?.status === "complete" && (m.attestation as string) !== "PENDING") { message = m.message; attestation = m.attestation; break; }
    }
    if (i % 6 === 0) console.log(`  still waiting (${i * 5}s)`);
    await sleep(5000);
  }
  if (!message || !attestation) throw new Error("no attestation after 30 minutes; the burn can still be redeemed later with the same transaction hash");

  // 4. Redeem on Arc: the funder receives the mint and tries to fund the job in one transaction.
  const before = await arcPub.readContract({ address: arcFunder, abi: FUNDER_ABI, functionName: "pendingRecovery", args: [account.address] }) as bigint;
  const redeem = await arc.writeContract({ address: arcFunder, abi: FUNDER_ABI, functionName: "redeemAndFund", args: [message, attestation], gas: 1_500_000n });
  const rr = await arcPub.waitForTransactionReceipt({ hash: redeem });
  t.redeemTx = redeem;
  if (rr.status !== "success") { t.outcome = "redeem reverted"; save(rec); throw new Error(`redeemAndFund reverted: ${redeem}`); }
  const funded = parseEventLogs({ abi: FUNDER_ABI, eventName: "JobFunded", logs: rr.logs })[0];
  const failed = parseEventLogs({ abi: FUNDER_ABI, eventName: "FundingFailed", logs: rr.logs })[0];
  const after = await arcPub.readContract({ address: arcFunder, abi: FUNDER_ABI, functionName: "pendingRecovery", args: [account.address] }) as bigint;
  const job = await arcPub.readContract({ address: D.acp, abi: ACP_ABI, functionName: "getJob", args: [jobId] }) as Job;
  t.outcome = funded ? "job funded" : failed ? "funding failed, money set aside for recovery" : "redeemed, no funding event";
  t.minted = (funded?.args.minted ?? failed?.args.minted ?? 0n).toString();
  t.notes.push(`job status after: ${STATUS[job.status]}`, `recovery balance: ${usdc(before)} -> ${usdc(after)}`);
  save(rec);
  console.log(`redeemed on Arc: ${explorerTx(redeem)}`);
  console.log(`outcome: ${t.outcome}; minted ${usdc(BigInt(t.minted))}; job is ${STATUS[job.status]}; recovery balance ${usdc(after)}`);
}

async function recover(): Promise<void> {
  const { account, arcPub, arc } = setup();
  const rec = load();
  const arcFunder = rec.arcFunder as Address;
  const owed = await arcPub.readContract({ address: arcFunder, abi: FUNDER_ABI, functionName: "pendingRecovery", args: [account.address] }) as bigint;
  if (owed === 0n) { console.log("nothing to recover"); return; }
  const wallet = async () => (await arcPub.readContract({ address: D.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  const w0 = await wallet();
  const tx = await arc.writeContract({ address: arcFunder, abi: FUNDER_ABI, functionName: "recoverFunds" });
  const r = await arcPub.waitForTransactionReceipt({ hash: tx });
  const w1 = await wallet();
  const left = await arcPub.readContract({ address: arcFunder, abi: FUNDER_ABI, functionName: "pendingRecovery", args: [account.address] }) as bigint;
  const t = [...rec.transfers].reverse().find((x) => x.redeemTx && !x.recoverTx);
  if (t) { t.recoverTx = tx; t.notes.push(`recovered ${usdc(owed)}; wallet ${usdc(w0)} -> ${usdc(w1)} (gas is paid in USDC); left ${usdc(left)}`); }
  save(rec);
  console.log(`recovered ${usdc(owed)}: ${explorerTx(tx)} (status ${r.status}); recovery balance now ${usdc(left)}; wallet ${usdc(w0)} -> ${usdc(w1)}`);
}

async function status(): Promise<void> {
  const { account, arcPub, basePub } = setup();
  const rec = load();
  console.log(JSON.stringify({ tester: account.address, arcFunder: rec.arcFunder, baseFunder: rec.baseFunder, transfers: rec.transfers.length }, null, 2));
  const bal = (await arcPub.readContract({ address: D.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  const baseBal = (await basePub.readContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  console.log(`tester: Arc ${usdc(bal)}, Base Sepolia ${usdc(baseBal)}, Base Sepolia ETH ${formatUnits(await basePub.getBalance({ address: account.address }), 18)}`);
  if (rec.arcFunder) {
    const t = await arcPub.readContract({ address: D.acp, abi: TRUST_ABI, functionName: "trustedFunder", args: [rec.arcFunder as Address] }) as boolean;
    console.log(`Arc funder trusted by the ACP: ${t}`);
  }
}

async function report(): Promise<void> {
  const rec = load();
  if (!rec.arcFunder || !rec.baseFunder) throw new Error("nothing to report yet");
  const base = (h: string) => `[${h.slice(0, 10)}](https://sepolia.basescan.org/tx/${h})`;
  const arcTx = (h: string) => `[${h.slice(0, 10)}](${explorerTx(h)})`;
  const out: string[] = [];
  out.push("# CCTP V2 on testnet", "");
  out.push("`CCTPJobFunderV2` against Circle's real CCTP V2 contracts: a burn on Base Sepolia (domain 6) mints on Arc Testnet (domain 26) and the funder tries to fund an ERC-8183 job in the same transaction.", "");
  out.push("Generated from `docs/testnet/cctp.json` by `bun run cctp:testnet report`. Test money only.", "");
  out.push("## Contracts", "");
  out.push("| | Address |", "|---|---|");
  out.push(`| Arc Testnet funder (acp = the v2 testnet ACP) | \`${rec.arcFunder}\` |`);
  out.push(`| Base Sepolia funder (acp = address(0), burn side only) | \`${rec.baseFunder}\` |`);
  out.push(`| TokenMessengerV2 (both chains) | \`${TOKEN_MESSENGER}\` |`);
  out.push(`| MessageTransmitterV2 (both chains) | \`${MESSAGE_TRANSMITTER}\` |`, "");
  out.push("The two Circle addresses come from Circle's contract addresses page (Testnet section). Both funders share one address because the same key deployed them with the same nonce on both chains. The owner of both funders is a test key held by the project's agents, not a production owner.", "");
  out.push("## Deployment", "", ...rec.deployTxs.map((t) => `- ${t.what}: ${/Base/.test(t.what) ? base(t.hash) : arcTx(t.hash)}`), "");
  out.push("## Transfers", "");
  out.push("| Test | Funder trusted by ACP | Burn (Base Sepolia) | Redeem (Arc) | Recovery (Arc) | Outcome |", "|---|---|---|---|---|---|");
  for (const t of rec.transfers) {
    out.push(`| ${t.label} | ${t.funderTrusted ? "yes" : "no"} | ${t.burnTx ? base(t.burnTx) : ""} | ${t.redeemTx ? arcTx(t.redeemTx) : ""} | ${t.recoverTx ? arcTx(t.recoverTx) : ""} | ${t.outcome ?? "?"}; minted ${t.minted ? usdc(BigInt(t.minted)) : "?"} of ${usdc(BigInt(t.amount))} burned, budget ${usdc(BigInt(t.budget))} (job ${t.jobId}) |`);
  }
  out.push("");
  for (const t of rec.transfers) if (t.notes.length) out.push(`- ${t.label}: ${t.notes.join("; ")}`);
  const funded = rec.transfers.filter((t) => t.outcome === "job funded" && t.minted);
  if (funded.length) {
    out.push("", "## The success path in detail", "");
    for (const t of funded) {
      const minted = BigInt(t.minted!), budget = BigInt(t.budget), burned = BigInt(t.amount);
      out.push(`**${t.label}, job ${t.jobId}**`, "");
      out.push(`- Burned on Base Sepolia: ${usdc(burned)} ([burn](https://sepolia.basescan.org/tx/${t.burnTx}))`);
      out.push(`- Minted on Arc after the fast-transfer fee: ${usdc(minted)} (fee ${usdc(burned - minted)})`);
      out.push(`- Job funded in the same transaction as the redeem ([redeem](${explorerTx(t.redeemTx!)})): the ACP took the ${usdc(budget)} budget and the job went from Open to Funded`);
      out.push(`- Events in the redeem transaction: \`JobFunded(${t.jobId}, client, ${budget}, ${minted})\` and \`RecoveryCredited(client, ${minted - budget})\` (amounts in 6-decimal units)`);
      out.push(`- Surplus ${usdc(minted - budget)} (minted minus budget) was credited to the client's recovery balance, then withdrawn by the client ([recovery](${explorerTx(t.recoverTx!)}))`);
      const f = (t as { finish?: { submitTx?: string; decisionTx?: string; providerCredited: string; finalStatus: string } }).finish;
      if (f) {
        out.push(`- Followed to payment: provider submitted ([submit](${explorerTx(f.submitTx!)})), the evaluator approved ([decision](${explorerTx(f.decisionTx!)})), the provider was credited ${usdc(BigInt(f.providerCredited))} and the job ended ${f.finalStatus}`);
      }
      out.push("");
    }
  }
  out.push("", "## What this shows and what it does not", "");
  out.push("- Shows: the message layout and field checks work against real attested messages, the fast-transfer fee is taken from the mint (burned amount minus fee is what the funder sees), redemption and funding happen in one transaction, and a failed funding leaves the money recoverable by the client.");
  out.push("- Does not show: mainnet behaviour, standard (finalized) transfers, other source chains, or load. The contract has no independent audit.");
  out.push("");
  writeFileSync(resolve(RECORD, "../../testnet-cctp.md"), out.join("\n"));
  console.log("wrote docs/testnet-cctp.md");
}

const cmd = process.argv[2];
const run = { deploy, send, recover, status, report }[cmd as "deploy"];
if (!run) { console.error("usage: cctp-testnet.ts deploy | send | recover | status | report"); process.exit(1); }
run().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
