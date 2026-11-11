// Manual check: reads the board's data from a live deployment and prints a summary.
// Usage: bun scripts/probe-snapshot.ts <rpcUrl> <acpAddress> [bondHookAddress] [deployBlock]
import { createPublicClient, http, type Address } from "viem";
import { fetchSnapshot } from "../src/lib/snapshot";
import { buildAgents, buildDeals, buildLedger, lockedEscrow } from "../src/lib/chain";

const [rpc, acp, hook, deploy] = process.argv.slice(2);
if (!rpc || !acp) { console.error("usage: bun scripts/probe-snapshot.ts <rpcUrl> <acp> [hook]"); process.exit(1); }

const client = createPublicClient({ transport: http(rpc) });
const t0 = Date.now();
const hookAddr = (hook ?? "0x0000000000000000000000000000000000000000") as Address;
const deployBlock = deploy ? BigInt(deploy) : null;
// Refresh the way the app does: keep going while old history is still being read.
let snap = await fetchSnapshot(client, acp as Address, hookAddr, { deployBlock });
for (let i = 1; !snap.eventsComplete && i < 40; i++) {
  console.log(`refresh ${i}: scanned down to block ${snap.eventsFrom} (floor ${snap.eventsFloor}), ${snap.logs.length} logs`);
  await Bun.sleep(4000);
  snap = await fetchSnapshot(client, acp as Address, hookAddr, { deployBlock });
  if (snap.eventsError) { console.log("stopped:", snap.eventsError); break; }
}
const agents = buildAgents(snap.jobs, snap.bonds);
const deals = buildDeals(snap.jobs);
const ledger = buildLedger(snap.logs, snap.blockTimes);
console.log(JSON.stringify({
  ms: Date.now() - t0, head: snap.head.toString(), eventsFrom: snap.eventsFrom.toString(),
  jobCount: snap.jobCount, eventsComplete: snap.eventsComplete, jobsRead: snap.jobs.length, agents: agents.length, deals: deals.length,
  escrowUsdc: lockedEscrow(snap.jobs), logs: snap.logs.length, ledger: ledger.length, eventsError: snap.eventsError,
}, null, 2));
for (const a of agents) console.log(a.id, a.role, `jobs=${a.jobs}`, `bond=${a.bond}`);
for (const l of ledger.slice(0, 8)) console.log(l.block.toString(), l.kind, l.text);
