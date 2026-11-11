// Pure data model for the board. Everything here is derived from what is on
// chain (jobs read from the ACP contract, bond balances read from the hook,
// and decoded contract events). Nothing in this file invents data.

export const JOB_STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
export type JobStatusName = (typeof JOB_STATUS)[number];

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC_UNIT = 1_000_000;

export interface ChainJob {
  id:          bigint;
  client:      string;
  provider:    string;
  evaluator:   string;
  description: string;
  budget:      bigint;
  expiredAt:   bigint;
  status:      number;
  hook:        string;
}

export type Role = "client" | "provider" | "evaluator" | "mixed";

export interface BondInfo { balance: bigint; locked: bigint }

export interface ChainAgent {
  id:          string;   // lower-case address
  name:        string;   // shortened address
  role:        Role;
  roles:       Role[];
  jobs:        number;
  live:        number;   // jobs that are Open, Funded or Submitted
  volume:      number;   // USDC budget of jobs where the address is client or provider
  bond:        number | null;
  bondLocked:  number | null;
}

export interface Deal {
  id:        number;
  partyA:    string;     // client
  partyB:    string;     // provider
  evaluator: string;
  status:    JobStatusName;
  budget:    number;     // USDC
  color:     string;
  live:      boolean;
}

export type LedgerKind = "created" | "funded" | "submitted" | "completed" | "rejected" | "dispute" | "expired";

export interface LedgerEntry {
  id:     string;
  kind:   LedgerKind;
  jobId:  number;
  text:   string;
  block:  bigint;
  ts:     number | null;   // unix ms, null until the block time is known
  txHash: string | null;
}

export interface DecodedLog {
  name:        string;
  args:        Record<string, unknown>;
  blockNumber: bigint;
  logIndex:    number;
  txHash:      string | null;
}

export const norm = (a: string) => a.toLowerCase();

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export const usdc = (v: bigint | number): number => Number(v) / USDC_UNIT;

export const STATUS_COLOR_BY_JOB: Record<JobStatusName, string> = {
  Open:      "#85b1ed",
  Funded:    "#85b1ed",
  Submitted: "#f59e0b",
  Completed: "#8dd89f",
  Rejected:  "#e86d7a",
  Expired:   "#64748b",
};

export function statusName(s: number): JobStatusName {
  return JOB_STATUS[s] ?? "Open";
}

/** USDC currently held by the contract for jobs that are funded or submitted. */
export function lockedEscrow(jobs: ChainJob[]): number {
  let total = 0n;
  for (const j of jobs) if (j.status === 1 || j.status === 2) total += j.budget;
  return usdc(total);
}

function primaryRole(roles: Set<Role>): Role {
  if (roles.size > 1) return "mixed";
  return [...roles][0] ?? "client";
}

export function buildAgents(jobs: ChainJob[], bonds: Map<string, BondInfo>): ChainAgent[] {
  const map = new Map<string, { roles: Set<Role>; jobs: number; live: number; volume: bigint }>();
  const touch = (addr: string, role: Role, j: ChainJob, counts: boolean) => {
    if (!addr || norm(addr) === ZERO) return;
    const id = norm(addr);
    const e = map.get(id) ?? { roles: new Set<Role>(), jobs: 0, live: 0, volume: 0n };
    e.roles.add(role);
    e.jobs += 1;
    if (j.status <= 2) e.live += 1;
    if (counts) e.volume += j.budget;
    map.set(id, e);
  };
  for (const j of jobs) {
    touch(j.client, "client", j, true);
    touch(j.provider, "provider", j, true);
    // A client that names itself as evaluator is still one participant on the board.
    if (norm(j.evaluator) !== norm(j.client) && norm(j.evaluator) !== norm(j.provider)) {
      touch(j.evaluator, "evaluator", j, false);
    }
  }
  const out: ChainAgent[] = [];
  for (const [id, e] of map) {
    const b = bonds.get(id);
    out.push({
      id,
      name: shortAddr(id),
      role: primaryRole(e.roles),
      roles: [...e.roles],
      jobs: e.jobs,
      live: e.live,
      volume: usdc(e.volume),
      bond: b ? usdc(b.balance) : null,
      bondLocked: b ? usdc(b.locked) : null,
    });
  }
  return out.sort((a, b) => b.live - a.live || b.jobs - a.jobs || b.volume - a.volume || (a.id < b.id ? -1 : 1));
}

export function buildDeals(jobs: ChainJob[]): Deal[] {
  const out: Deal[] = [];
  for (const j of jobs) {
    if (norm(j.provider) === ZERO) continue;   // provider not set yet, nothing to draw
    const status = statusName(j.status);
    out.push({
      id: Number(j.id),
      partyA: norm(j.client),
      partyB: norm(j.provider),
      evaluator: norm(j.evaluator),
      status,
      budget: usdc(j.budget),
      color: STATUS_COLOR_BY_JOB[status],
      live: j.status <= 2,
    });
  }
  return out;
}

/** An address is "awaiting review" while a job it takes part in is submitted and undecided. */
export function awaitingReview(jobs: ChainJob[], id: string): boolean {
  const a = norm(id);
  return jobs.some(
    (j) => j.status === 2 && (norm(j.client) === a || norm(j.provider) === a || norm(j.evaluator) === a),
  );
}

const LEDGER_KIND: Record<string, LedgerKind> = {
  JobCreated: "created",
  JobFunded: "funded",
  JobSubmitted: "submitted",
  JobCompleted: "completed",
  JobRejected: "rejected",
  RejectionProposed: "dispute",
  RejectionChallenged: "dispute",
  DisputeResolved: "dispute",
  DisputeTimedOut: "dispute",
  JobExpired: "expired",
};

function jobIdOf(args: Record<string, unknown>): number | null {
  const v = args.jobId;
  return typeof v === "bigint" ? Number(v) : null;
}

function describe(name: string, args: Record<string, unknown>, id: number): string {
  switch (name) {
    case "JobCreated":
      return `Job #${id} created: ${shortAddr(String(args.client))} hires ${shortAddr(String(args.provider))}`;
    case "JobFunded":
      return `Job #${id} funded with ${usdc(args.amount as bigint).toFixed(2)} USDC`;
    case "JobSubmitted":
      return `Job #${id} delivered by ${shortAddr(String(args.provider))}`;
    case "JobCompleted":
      return `Job #${id} approved by ${shortAddr(String(args.evaluator))}`;
    case "JobRejected":
      return `Job #${id} rejected by ${shortAddr(String(args.rejector))}`;
    case "RejectionProposed":
      return `Job #${id} rejection proposed, challenge window open`;
    case "RejectionChallenged":
      return `Job #${id} rejection challenged by ${shortAddr(String(args.provider))}`;
    case "DisputeResolved":
      return `Job #${id} dispute ruled: rejection ${args.rejectionUpheld ? "upheld" : "overturned"}`;
    case "DisputeTimedOut":
      return `Job #${id} arbiter did not rule in time, rejection stands`;
    case "JobExpired":
      return `Job #${id} expired`;
    default:
      return `Job #${id} ${name}`;
  }
}

export function buildLedger(logs: DecodedLog[], blockTimes: Map<bigint, number>): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const l of logs) {
    const kind = LEDGER_KIND[l.name];
    const id = jobIdOf(l.args);
    if (!kind || id === null) continue;
    const t = blockTimes.get(l.blockNumber);
    out.push({
      id: `${l.blockNumber}-${l.logIndex}`,
      kind,
      jobId: id,
      text: describe(l.name, l.args, id),
      block: l.blockNumber,
      ts: t === undefined ? null : t * 1000,
      txHash: l.txHash,
    });
  }
  return out.sort((a, b) => (a.block === b.block ? (a.id < b.id ? 1 : -1) : a.block < b.block ? 1 : -1));
}
