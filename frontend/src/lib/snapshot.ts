// Reads the board's data from an Arc RPC client. Kept free of React and of app
// config so it can run in tests and scripts against any ACP deployment.

import { decodeEventLog, type Abi, type Address, type PublicClient } from "viem";
import { ACP_ABI, BOND_HOOK_ABI } from "../abis";
import { norm, type BondInfo, type ChainJob, type DecodedLog } from "./chain";

const ZERO = "0x0000000000000000000000000000000000000000";
export const EVENT_LOOKBACK_BLOCKS = 20_000n;
const LOG_CHUNK = 5_000n;          // a 5,000-block range worked and 10,000 failed on the Arc mainnet RPC when measured
const PARALLEL_RANGES = 3;
const MAX_BACKFILL_RANGES = 30;    // ranges of old history read per refresh, kept small so the public RPC is not hammered

interface LogCache { logs: DecodedLog[]; from: bigint; to: bigint; floor: bigint }
const caches = new Map<string, LogCache>();
const MAX_JOBS = 100;
const MAX_BLOCK_TIMES = 30;

export interface OnchainSnapshot {
  jobs:        ChainJob[];
  jobCount:    number;
  bonds:       Map<string, BondInfo>;
  logs:        DecodedLog[];
  blockTimes:  Map<bigint, number>;
  head:        bigint;
  eventsFrom:  bigint;        // oldest block scanned so far
  eventsFloor: bigint;        // oldest block the scan will go back to
  eventsComplete: boolean;
  eventsFromDeploy: boolean;  // true when the floor is the deployment block, so history is complete
  eventsError: string | null;
  fetchedAt:   number;
}

type RawJob = {
  id: bigint; client: string; provider: string; evaluator: string;
  description: string; budget: bigint; expiredAt: bigint; status: number | bigint; hook: string;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

export interface SnapshotOptions { deployBlock?: bigint | null }

export async function fetchSnapshot(
  client: PublicClient, acpAddress: Address, hookAddress: Address, opts: SnapshotOptions = {},
): Promise<OnchainSnapshot> {
  const acp = { address: acpAddress, abi: ACP_ABI as Abi } as const;

  const head = await client.getBlockNumber();
  const count = Number(await client.readContract({ ...acp, functionName: "jobCount" }) as bigint);

  // Jobs: newest MAX_JOBS ids, read in small parallel batches.
  const firstId = Math.max(1, count - MAX_JOBS + 1);
  const ids: number[] = [];
  for (let i = firstId; i <= count; i++) ids.push(i);
  const jobs: ChainJob[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(
      ids.slice(i, i + 10).map(async (id) => {
        const r = await client.readContract({ ...acp, functionName: "getJob", args: [BigInt(id)] }) as RawJob;
        return { ...r, status: Number(r.status) } as ChainJob;
      }),
    );
    jobs.push(...batch);
  }

  // Bonds: only for providers, and only if a bond hook is configured. A failed
  // read (for example a hook without these getters) leaves the bond unknown.
  const bonds = new Map<string, BondInfo>();
  if (norm(hookAddress) !== ZERO) {
    const providers = [...new Set(jobs.map((j) => norm(j.provider)).filter((p) => p !== ZERO))];
    await Promise.all(providers.map(async (p) => {
      try {
        const hook = { address: hookAddress, abi: BOND_HOOK_ABI as Abi } as const;
        const [balance, locked] = await Promise.all([
          client.readContract({ ...hook, functionName: "bondBalance", args: [p] }) as Promise<bigint>,
          client.readContract({ ...hook, functionName: "bondLocked", args: [p] }) as Promise<bigint>,
        ]);
        bonds.set(p, { balance, locked });
      } catch { /* bond stays unknown */ }
    }));
  }

  // Events: scanned in fixed-size ranges and remembered between refreshes. New blocks
  // are scanned forward from the last block seen. Older history is filled in backwards,
  // newest first, a bounded number of ranges per refresh, down to the floor (the
  // deployment block when known, otherwise a recent window). Never from block 0.
  const key = `${acpAddress.toLowerCase()}:${opts.deployBlock ?? "recent"}`;
  const cache = caches.get(key) ?? {
    logs: [], from: head + 1n, to: head,
    floor: opts.deployBlock != null ? opts.deployBlock : head > EVENT_LOOKBACK_BLOCKS ? head - EVENT_LOOKBACK_BLOCKS : 0n,
  };
  const floor = cache.floor;
  let eventsError: string | null = null;

  const scan = async (ranges: Array<[bigint, bigint]>, onGroupDone: (r: Array<[bigint, bigint]>, found: DecodedLog[]) => void) => {
    for (let i = 0; i < ranges.length; i += PARALLEL_RANGES) {
      const group = ranges.slice(i, i + PARALLEL_RANGES);
      const parts = await Promise.all(
        group.map(([fromBlock, toBlock]) => client.getLogs({ address: acpAddress, fromBlock, toBlock })),
      );
      const found: DecodedLog[] = [];
      for (const part of parts) {
        for (const l of part) {
          try {
            const ev = decodeEventLog({ abi: ACP_ABI as Abi, data: l.data, topics: l.topics, strict: false });
            found.push({
              name: String(ev.eventName),
              args: (ev.args ?? {}) as Record<string, unknown>,
              blockNumber: l.blockNumber ?? 0n,
              logIndex: l.logIndex ?? 0,
              txHash: l.transactionHash ?? null,
            });
          } catch { /* not one of ours */ }
        }
      }
      onGroupDone(group, found);
    }
  };

  try {
    // Forward: everything after the newest block already scanned.
    const fwd: Array<[bigint, bigint]> = [];
    for (let a = cache.to + 1n; a <= head; a += LOG_CHUNK) fwd.push([a, a + LOG_CHUNK - 1n > head ? head : a + LOG_CHUNK - 1n]);
    await scan(fwd, (g, found) => { cache.logs.push(...found); cache.to = g[g.length - 1][1]; });

    // Backward: older history, bounded work per refresh.
    const back: Array<[bigint, bigint]> = [];
    for (let b = cache.from - 1n; b >= floor && back.length < MAX_BACKFILL_RANGES; b -= LOG_CHUNK) {
      const a = b - LOG_CHUNK + 1n < floor ? floor : b - LOG_CHUNK + 1n;
      back.push([a, b]);
    }
    await scan(back, (g, found) => { cache.logs.push(...found); cache.from = g[g.length - 1][0]; });
  } catch (e) {
    eventsError = errMsg(e);
  }
  caches.set(key, cache);
  const logs = [...cache.logs];
  const eventsFrom = cache.from;
  const eventsComplete = cache.from <= floor;

  // Block times for the newest events only.
  const blockTimes = new Map<bigint, number>();
  const blocks = [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) => (a < b ? 1 : -1)).slice(0, MAX_BLOCK_TIMES);
  await Promise.all(blocks.map(async (blockNumber) => {
    try {
      const b = await client.getBlock({ blockNumber });
      blockTimes.set(blockNumber, Number(b.timestamp));
    } catch { /* time stays unknown */ }
  }));

  return { jobs, jobCount: count, bonds, logs, blockTimes, head, eventsFrom, eventsFloor: floor, eventsFromDeploy: opts.deployBlock != null, eventsComplete, eventsError, fetchedAt: Date.now() };
}
