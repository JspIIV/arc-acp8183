import { describe, expect, test } from "bun:test";
import {
  awaitingReview, buildAgents, buildDeals, buildLedger, lockedEscrow,
  type BondInfo, type ChainJob, type DecodedLog,
} from "../src/lib/chain";

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000c";
const ZERO = "0x0000000000000000000000000000000000000000";

function job(id: number, status: number, o: Partial<ChainJob> = {}): ChainJob {
  return {
    id: BigInt(id), client: A, provider: B, evaluator: C, description: `job ${id}`,
    budget: 10_000_000n, expiredAt: 2_000_000_000n, status, hook: ZERO, ...o,
  };
}

describe("lockedEscrow", () => {
  test("counts only funded and submitted jobs", () => {
    const jobs = [job(1, 0), job(2, 1), job(3, 2), job(4, 3), job(5, 4), job(6, 5)];
    expect(lockedEscrow(jobs)).toBe(20);
  });
  test("is zero with no jobs", () => expect(lockedEscrow([])).toBe(0));
});

describe("buildAgents", () => {
  test("derives one entry per address with roles and counts", () => {
    const agents = buildAgents([job(1, 3), job(2, 1)], new Map());
    expect(agents.map((a) => a.id).sort()).toEqual([A, B, C]);
    const a = agents.find((x) => x.id === A)!;
    expect(a.role).toBe("client");
    expect(a.jobs).toBe(2);
    expect(a.live).toBe(1);
    expect(a.volume).toBe(20);
    const c = agents.find((x) => x.id === C)!;
    expect(c.role).toBe("evaluator");
    expect(c.volume).toBe(0);
  });

  test("an address with two roles is multi-role", () => {
    const agents = buildAgents([job(1, 3), job(2, 3, { client: B, provider: A })], new Map());
    expect(agents.find((x) => x.id === A)!.role).toBe("mixed");
  });

  test("a client that evaluates its own job is not counted twice", () => {
    const agents = buildAgents([job(1, 3, { evaluator: A })], new Map());
    expect(agents.find((x) => x.id === A)!.jobs).toBe(1);
  });

  test("ignores the zero address and normalises case", () => {
    const upper = "0x000000000000000000000000000000000000000A";
    const agents = buildAgents([job(1, 0, { provider: ZERO, client: upper })], new Map());
    expect(agents.some((x) => x.id === ZERO)).toBe(false);
    expect(agents.find((x) => x.id === A)).toBeDefined();
  });

  test("attaches bond info only where it was read", () => {
    const bonds = new Map<string, BondInfo>([[B, { balance: 20_000_000n, locked: 5_000_000n }]]);
    const agents = buildAgents([job(1, 2)], bonds);
    const b = agents.find((x) => x.id === B)!;
    expect(b.bond).toBe(20);
    expect(b.bondLocked).toBe(5);
    expect(agents.find((x) => x.id === A)!.bond).toBeNull();
  });

  test("orders by live jobs first", () => {
    const agents = buildAgents([job(1, 3, { client: C, provider: B }), job(2, 1)], new Map());
    expect(agents[0].live).toBeGreaterThanOrEqual(agents[agents.length - 1].live);
  });
});

describe("buildDeals", () => {
  test("skips jobs whose provider is not set", () => {
    const deals = buildDeals([job(1, 0, { provider: ZERO }), job(2, 1)]);
    expect(deals.map((d) => d.id)).toEqual([2]);
  });
  test("marks only open, funded and submitted jobs as live", () => {
    const deals = buildDeals([job(1, 0), job(2, 3), job(3, 4), job(4, 5)]);
    expect(deals.map((d) => d.live)).toEqual([true, false, false, false]);
    expect(deals[1].color).toBe("#8dd89f");
  });
});

describe("awaitingReview", () => {
  test("is true for every party of a submitted job", () => {
    const jobs = [job(1, 2)];
    for (const addr of [A, B, C]) expect(awaitingReview(jobs, addr)).toBe(true);
  });
  test("is false once the job is settled", () => {
    expect(awaitingReview([job(1, 3)], A)).toBe(false);
  });
  test("is false for an unrelated address", () => {
    expect(awaitingReview([job(1, 2)], "0x00000000000000000000000000000000000000ff")).toBe(false);
  });
});

describe("buildLedger", () => {
  const log = (name: string, args: Record<string, unknown>, blockNumber: bigint, logIndex = 0): DecodedLog =>
    ({ name, args, blockNumber, logIndex, txHash: `0x${blockNumber.toString(16)}` });

  test("sorts newest first and attaches block times", () => {
    const l = buildLedger(
      [
        log("JobCreated", { jobId: 1n, client: A, provider: B }, 100n),
        log("JobFunded", { jobId: 1n, amount: 10_000_000n }, 105n),
      ],
      new Map([[105n, 1_700_000_000]]),
    );
    expect(l.map((e) => e.kind)).toEqual(["funded", "created"]);
    expect(l[0].ts).toBe(1_700_000_000_000);
    expect(l[1].ts).toBeNull();
    expect(l[0].text).toContain("10.00 USDC");
  });

  test("drops events it does not display or that carry no job id", () => {
    const l = buildLedger(
      [log("Withdrawn", { recipient: A, amount: 1n }, 1n), log("JobCompleted", { evaluator: C }, 2n)],
      new Map(),
    );
    expect(l).toEqual([]);
  });

  test("describes dispute events", () => {
    const l = buildLedger([log("DisputeResolved", { jobId: 3n, rejectionUpheld: false }, 9n)], new Map());
    expect(l[0].kind).toBe("dispute");
    expect(l[0].text).toContain("overturned");
  });
});
