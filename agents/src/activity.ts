// The record a testnet run leaves behind, and the numbers computed from it.
// Everything here is pure so the arithmetic can be tested without a chain.

export type JobKind = "approve" | "reject" | "expire";
export type FinalStatus = "Completed" | "Rejected" | "Expired" | "Open" | "Funded" | "Submitted";

export interface TxRecord {
  fn: string;
  hash: string;
  block: string;       // block number as a decimal string
  from: string;
}

export interface JobRecord {
  id: string;          // job id as a decimal string
  kind: JobKind;
  client: string;
  provider: string;
  evaluator: string;
  budget: string;      // micro-USDC, decimal string
  workMs: number;      // how long the provider "worked" before submitting
  reviewMs: number;    // how long the evaluator took before deciding
  createdAt?: number;  // unix seconds, from block timestamps
  submittedAt?: number;
  decidedAt?: number;
  settledAt?: number;
  finalStatus?: FinalStatus;
  txs: TxRecord[];
}

export interface RunRecord {
  startedAt: string;
  finishedAt?: string;
  platformBps: number;
  evaluatorBps: number;
  contracts: { acp: string; hook: string; chainId: number };
  jobs: JobRecord[];
  /** Transactions that belong to no single job: withdrawals and top-ups. */
  other?: TxRecord[];
}

export interface Summary {
  totalJobs: number;
  byStatus: Record<string, number>;
  /** Sum of budgets locked in escrow, micro-USDC. */
  escrowed: bigint;
  paidToProviders: bigint;
  feesCredited: bigint;
  refundedToClients: bigint;
  slashedBonds: bigint;
  uniqueAddresses: number;
  uniqueByRole: { clients: number; providers: number; evaluators: number };
  budgets: { min: bigint; max: bigint; distinct: number };
  /** Seconds from submit to decision, over decided jobs. */
  decisionSeconds: { min: number; median: number; max: number } | null;
  /** Jobs whose recorded final status differs from what the plan expected. */
  unexpected: string[];
}

const EXPECTED: Record<JobKind, FinalStatus> = { approve: "Completed", reject: "Rejected", expire: "Expired" };

export function summarize(runs: RunRecord[]): Summary {
  const jobs = runs.flatMap((r) => r.jobs.map((j) => ({ j, run: r })));
  const byStatus: Record<string, number> = {};
  let escrowed = 0n, paid = 0n, fees = 0n, refunded = 0n, slashed = 0n;
  const budgets: bigint[] = [];
  const unexpected: string[] = [];
  const secs: number[] = [];

  for (const { j, run } of jobs) {
    const status = j.finalStatus ?? "Funded";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (status !== EXPECTED[j.kind]) unexpected.push(`job ${j.id}: planned ${EXPECTED[j.kind]}, found ${status}`);
    const b = BigInt(j.budget);
    budgets.push(b);
    escrowed += b;
    const platform = (b * BigInt(run.platformBps)) / 10_000n;
    const evalFee = (b * BigInt(run.evaluatorBps)) / 10_000n;
    if (status === "Completed") { paid += b - platform - evalFee; fees += platform + evalFee; }
    if (status === "Rejected") { refunded += b; slashed += b / 2n; }
    if (status === "Expired") refunded += b;
    if (j.submittedAt && j.decidedAt && j.decidedAt >= j.submittedAt) secs.push(j.decidedAt - j.submittedAt);
  }

  const set = (pick: (j: JobRecord) => string) => new Set(jobs.map(({ j }) => pick(j).toLowerCase()));
  const clients = set((j) => j.client), providers = set((j) => j.provider), evaluators = set((j) => j.evaluator);
  const all = new Set([...clients, ...providers, ...evaluators]);
  secs.sort((a, b) => a - b);

  return {
    totalJobs: jobs.length,
    byStatus,
    escrowed, paidToProviders: paid, feesCredited: fees, refundedToClients: refunded, slashedBonds: slashed,
    uniqueAddresses: all.size,
    uniqueByRole: { clients: clients.size, providers: providers.size, evaluators: evaluators.size },
    budgets: {
      min: budgets.length ? budgets.reduce((a, b) => (a < b ? a : b)) : 0n,
      max: budgets.length ? budgets.reduce((a, b) => (a > b ? a : b)) : 0n,
      distinct: new Set(budgets.map(String)).size,
    },
    decisionSeconds: secs.length ? { min: secs[0]!, median: secs[Math.floor(secs.length / 2)]!, max: secs[secs.length - 1]! } : null,
    unexpected,
  };
}

export const usdcText = (v: bigint): string => {
  const whole = v / 1_000_000n, frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/** Markdown for docs/: the four headline numbers, the totals behind them, and one row per job with links. */
export function renderMarkdown(runs: RunRecord[], explorer: string, extra: string[] = []): string {
  const s = summarize(runs);
  const last = runs[runs.length - 1];
  const rows = runs.flatMap((r) => r.jobs).sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
  const link = (t: TxRecord | undefined) => (t ? `[${t.hash.slice(0, 10)}](${explorer}/tx/${t.hash})` : "");
  const pick = (j: JobRecord, ...fns: string[]) => j.txs.filter((t) => fns.includes(t.fn)).pop();
  const get = (k: string) => s.byStatus[k] ?? 0;
  const out: string[] = [];
  out.push("# Testnet activity", "");
  out.push(`Generated from \`docs/testnet/activity.json\`. Contract: AgenticCommerce \`${last?.contracts.acp}\` on Arc Testnet (chain ${last?.contracts.chainId}).`);
  out.push("Every address below is controlled by this project's own agents. This is test money and our own traffic, not outside usage.", "");
  out.push("## The four numbers", "");
  out.push("| | |", "|---|---|");
  out.push(`| Settled jobs | ${s.totalJobs} |`);
  out.push(`| By outcome | ${get("Completed")} approved, ${get("Rejected")} rejected, ${get("Expired")} expired |`);
  out.push(`| USDC through escrow | ${usdcText(s.escrowed)} (budgets locked) |`);
  out.push(`| Unique addresses | ${s.uniqueAddresses} (${s.uniqueByRole.clients} clients, ${s.uniqueByRole.providers} providers, ${s.uniqueByRole.evaluators} evaluators) |`, "");
  out.push("## Where the USDC went", "");
  out.push(`- Paid to providers: ${usdcText(s.paidToProviders)}`);
  out.push(`- Fees credited (platform plus evaluator): ${usdcText(s.feesCredited)}`);
  out.push(`- Refunded to clients: ${usdcText(s.refundedToClients)}`);
  out.push(`- Provider bonds slashed to clients: ${usdcText(s.slashedBonds)}`);
  out.push(`- Budgets from ${usdcText(s.budgets.min)} to ${usdcText(s.budgets.max)} USDC, ${s.budgets.distinct} different amounts`);
  if (s.decisionSeconds) out.push(`- Submit to decision: ${s.decisionSeconds.min}s fastest, ${s.decisionSeconds.median}s median, ${s.decisionSeconds.max}s slowest`);
  if (s.unexpected.length) out.push("", "Jobs that did not end as planned:", ...s.unexpected.map((u) => `- ${u}`));
  if (extra.length) out.push("", ...extra);
  out.push("", "## Jobs", "");
  out.push("| Job | Outcome | Budget | Provider | Create | Fund | Submit | Decision | Settle |", "|---|---|---|---|---|---|---|---|---|");
  for (const j of rows) {
    const decision = pick(j, "complete", "reject");
    const settle = pick(j, "finalizeRejection", "claimRefund");
    out.push(`| ${j.id} | ${j.finalStatus ?? "?"} | ${usdcText(BigInt(j.budget))} | \`${j.provider.slice(0, 8)}\` | ${link(pick(j, "createJob"))} | ${link(pick(j, "fund"))} | ${link(pick(j, "submit"))} | ${link(decision)} | ${link(settle)} |`);
  }
  out.push("");
  return out.join("\n");
}
