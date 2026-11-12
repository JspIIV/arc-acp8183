import { describe, expect, test } from "bun:test";
import { renderMarkdown, summarize, usdcText, type JobRecord, type RunRecord } from "../src/activity";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b1";
const C = "0x00000000000000000000000000000000000000c1";
const job = (over: Partial<JobRecord>): JobRecord => ({
  id: "1", kind: "approve", client: A, provider: B, evaluator: C, budget: "50000", workMs: 0, reviewMs: 0,
  finalStatus: "Completed", txs: [], ...over,
});
const run = (jobs: JobRecord[]): RunRecord => ({
  startedAt: "2026-11-12T00:00:00Z", platformBps: 200, evaluatorBps: 100,
  contracts: { acp: "0xacp", hook: "0xhook", chainId: 5042002 }, jobs,
});

describe("summarize", () => {
  const jobs = [
    job({ id: "1" }),
    job({ id: "2", budget: "100000" }),
    job({ id: "3", kind: "reject", finalStatus: "Rejected", provider: "0x00000000000000000000000000000000000000B2" }),
    job({ id: "4", kind: "expire", finalStatus: "Expired", budget: "20000" }),
  ];
  const s = summarize([run(jobs)]);

  test("counts jobs and outcomes", () => {
    expect(s.totalJobs).toBe(4);
    expect(s.byStatus).toEqual({ Completed: 2, Rejected: 1, Expired: 1 });
  });
  test("splits the money", () => {
    expect(s.escrowed).toBe(50000n + 100000n + 50000n + 20000n);
    // 97% of 150000 goes to providers, 3% to fees
    expect(s.paidToProviders).toBe(145500n);
    expect(s.feesCredited).toBe(4500n);
    expect(s.refundedToClients).toBe(50000n + 20000n);
    expect(s.slashedBonds).toBe(25000n);
  });
  test("counts distinct addresses once, ignoring case", () => {
    expect(s.uniqueByRole).toEqual({ clients: 1, providers: 2, evaluators: 1 });
    expect(s.uniqueAddresses).toBe(4);
  });
  test("reports the spread of budgets", () => {
    expect(s.budgets).toEqual({ min: 20000n, max: 100000n, distinct: 3 });
  });
  test("flags a job that did not end as planned", () => {
    const bad = summarize([run([job({ id: "9", finalStatus: "Submitted" })])]);
    expect(bad.unexpected).toEqual(["job 9: planned Completed, found Submitted"]);
  });
  test("decision time comes from block timestamps", () => {
    const t = summarize([run([job({ submittedAt: 100, decidedAt: 108 }), job({ id: "2", submittedAt: 200, decidedAt: 230 })])]);
    expect(t.decisionSeconds).toEqual({ min: 8, median: 30, max: 30 });
  });
});

describe("rendering", () => {
  test("formats micro-USDC without trailing zeros", () => {
    expect([usdcText(50000n), usdcText(1_000_000n), usdcText(1_500_000n), usdcText(0n)]).toEqual(["0.05", "1", "1.5", "0"]);
  });
  test("the markdown carries the four numbers and a link per transaction", () => {
    const j = job({ txs: [{ fn: "createJob", hash: "0x" + "ab".repeat(32), block: "1", from: A }] });
    const md = renderMarkdown([run([j])], "https://explorer.example");
    expect(md).toContain("| Settled jobs | 1 |");
    expect(md).toContain("1 approved, 0 rejected, 0 expired");
    expect(md).toContain("https://explorer.example/tx/0x" + "ab".repeat(32));
  });
});
