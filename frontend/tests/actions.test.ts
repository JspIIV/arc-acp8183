import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, keccak256, stringToBytes } from "viem";
import {
  availableActions, deliverableHash, fundParams, parseUsdcInput, reasonToBytes32, settlementGas, submitParams,
  type DisputeView,
} from "../src/lib/actions";
import type { ChainJob } from "../src/lib/chain";

const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const EVALUATOR = "0x3333333333333333333333333333333333333333";
const ARBITER = "0x4444444444444444444444444444444444444444";
const STRANGER = "0x5555555555555555555555555555555555555555";
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW = 1_000_000;

const job = (over: Partial<ChainJob> = {}): ChainJob => ({
  id: 1n, client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, description: "d",
  budget: 10_000_000n, expiredAt: BigInt(NOW + 3600), status: 0, hook: ZERO, ...over,
});
const ids = (j: ChainJob, account: string | null, dispute: DisputeView | null = null, now = NOW) =>
  availableActions({ job: j, account, now, dispute }).map((a) => a.id);

describe("open job", () => {
  test("provider sets the budget, client funds or cancels", () => {
    expect(ids(job(), PROVIDER)).toEqual(["setBudget"]);
    expect(ids(job(), CLIENT)).toEqual(["fund", "cancel"]);
  });
  test("client cannot fund before a budget exists", () => {
    expect(ids(job({ budget: 0n }), CLIENT)).toEqual(["cancel"]);
  });
  test("client cannot fund without a provider", () => {
    expect(ids(job({ provider: ZERO }), CLIENT)).toEqual(["cancel"]);
  });
  test("nobody acts on an expired open job", () => {
    const j = job({ expiredAt: BigInt(NOW - 1) });
    expect(ids(j, CLIENT)).toEqual([]);
    expect(ids(j, PROVIDER)).toEqual([]);
  });
  test("a stranger or no wallet gets nothing", () => {
    expect(ids(job(), STRANGER)).toEqual([]);
    expect(ids(job(), null)).toEqual([]);
  });
  test("addresses compare regardless of case", () => {
    expect(ids(job(), PROVIDER.toUpperCase().replace("0X", "0x"))).toEqual(["setBudget"]);
  });
});

describe("funded job", () => {
  const j = job({ status: 1 });
  test("provider submits, evaluator may reject, client has nothing", () => {
    expect(ids(j, PROVIDER)).toEqual(["submit"]);
    expect(ids(j, EVALUATOR)).toEqual(["reject"]);
    expect(ids(j, CLIENT)).toEqual([]);
  });
  test("after expiry anyone can refund the client", () => {
    const e = job({ status: 1, expiredAt: BigInt(NOW - 1) });
    expect(ids(e, STRANGER)).toEqual(["claimRefund"]);
    expect(ids(e, PROVIDER)).toEqual(["claimRefund"]);
  });
});

describe("submitted job", () => {
  const j = job({ status: 2 });
  test("evaluator approves or rejects", () => {
    expect(ids(j, EVALUATOR)).toEqual(["complete", "reject"]);
    expect(ids(j, PROVIDER)).toEqual([]);
  });
  test("after a proposed rejection the evaluator can still approve but not reject again", () => {
    const d: DisputeView = { state: 1, challengeEndsAt: BigInt(NOW + 100), rulingDeadline: 0n, arbiter: ZERO, deposit: 0n };
    expect(ids(j, EVALUATOR, d)).toEqual(["complete"]);
    expect(ids(j, PROVIDER, d)).toEqual(["challenge"]);
    expect(ids(j, STRANGER, d)).toEqual([]);
  });
  test("once the challenge window closes anyone can finalize", () => {
    const d: DisputeView = { state: 1, challengeEndsAt: BigInt(NOW - 1), rulingDeadline: 0n, arbiter: ZERO, deposit: 0n };
    expect(ids(j, STRANGER, d)).toEqual(["finalize"]);
    expect(ids(j, PROVIDER, d)).toEqual(["finalize"]);
  });
  test("a challenged job belongs to the arbiter until the deadline", () => {
    const d: DisputeView = { state: 2, challengeEndsAt: 0n, rulingDeadline: BigInt(NOW + 100), arbiter: ARBITER, deposit: 1n };
    expect(ids(j, ARBITER, d)).toEqual(["resolve"]);
    expect(ids(j, EVALUATOR, d)).toEqual([]);
    expect(ids(j, STRANGER, d)).toEqual([]);
  });
  test("after the arbiter deadline anyone can settle", () => {
    const d: DisputeView = { state: 2, challengeEndsAt: 0n, rulingDeadline: BigInt(NOW - 1), arbiter: ARBITER, deposit: 1n };
    expect(ids(j, STRANGER, d)).toEqual(["arbiterTimeout"]);
    expect(ids(j, ARBITER, d)).toEqual(["arbiterTimeout"]);
  });
  test("expiry always leaves the refund escape hatch", () => {
    const d: DisputeView = { state: 2, challengeEndsAt: 0n, rulingDeadline: BigInt(NOW + 100), arbiter: ARBITER, deposit: 1n };
    const e = job({ status: 2, expiredAt: BigInt(NOW - 1) });
    expect(ids(e, STRANGER, d)).toContain("claimRefund");
  });
});

describe("settled jobs", () => {
  test.each([3, 4, 5])("status %i offers nothing", (status) => {
    for (const who of [CLIENT, PROVIDER, EVALUATOR, STRANGER]) expect(ids(job({ status }), who)).toEqual([]);
  });
});

describe("encoders", () => {
  test("deliverable hash is keccak256 of the utf8 content", () => {
    expect(deliverableHash("hello")).toBe(keccak256(stringToBytes("hello")));
  });
  test("submit params carry no sub-agent and the uri", () => {
    const [agent, cost, uri] = decodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "string" }], submitParams("ipfs://cid"),
    );
    expect(agent).toBe(ZERO);
    expect(cost).toBe(0n);
    expect(uri).toBe("ipfs://cid");
  });
  test("fund params carry the expected budget", () => {
    const [b] = decodeAbiParameters([{ type: "uint256" }], fundParams(7_500_000n));
    expect(b).toBe(7_500_000n);
  });
  test("reason fits in bytes32 and long text is cut", () => {
    expect(reasonToBytes32("ok").length).toBe(66);
    expect(reasonToBytes32("x".repeat(100)).length).toBe(66);
  });
  test("usdc input parsing", () => {
    expect(parseUsdcInput("10")).toBe(10_000_000n);
    expect(parseUsdcInput("0.5")).toBe(500_000n);
    expect(parseUsdcInput("1.2345678")).toBeNull();
    expect(parseUsdcInput("-1")).toBeNull();
    expect(parseUsdcInput("")).toBeNull();
    expect(parseUsdcInput("abc")).toBeNull();
  });
  test("hooked jobs get an explicit settlement gas limit", () => {
    expect(settlementGas(job())).toBeUndefined();
    expect(settlementGas(job({ hook: "0x6666666666666666666666666666666666666666" }))).toBe(600_000n);
  });
});
