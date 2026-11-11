// Which step a wallet can take on a job right now, and how each call's arguments
// are encoded. Pure functions, so the rules can be tested without a wallet or a chain.
// The rules mirror the contract: the contract still has the final say.

import { encodeAbiParameters, keccak256, parseUnits, stringToBytes, stringToHex, zeroAddress } from "viem";
import { norm, type ChainJob } from "./chain";

export type ActionId =
  | "setBudget" | "fund" | "cancel"
  | "submit"
  | "complete" | "reject"
  | "challenge" | "finalize" | "resolve" | "arbiterTimeout"
  | "claimRefund";

export interface DisputeView {
  state: number;            // 0 none, 1 proposed, 2 challenged, 3 resolved
  challengeEndsAt: bigint;
  rulingDeadline: bigint;
  arbiter: string;
  deposit: bigint;
}

export interface ActionContext {
  job: ChainJob;
  account: string | null;
  now: number;                       // unix seconds
  dispute: DisputeView | null;       // null when the contract has no dispute support
}

export interface AvailableAction {
  id: ActionId;
  label: string;
  /** Who this is for, shown when the connected wallet is not that party. */
  who: "client" | "provider" | "evaluator" | "arbiter" | "anyone";
}

const OPEN = 0, FUNDED = 1, SUBMITTED = 2;
const PROPOSED = 1, CHALLENGED = 2;

export function availableActions(ctx: ActionContext): AvailableAction[] {
  const { job, now, dispute } = ctx;
  const me = ctx.account ? norm(ctx.account) : null;
  const is = (addr: string) => me !== null && norm(addr) === me;
  const isClient = is(job.client), isProvider = is(job.provider), isEvaluator = is(job.evaluator);
  const expired = BigInt(now) >= job.expiredAt;
  const out: AvailableAction[] = [];

  if (job.status === OPEN && !expired) {
    if (isProvider) out.push({ id: "setBudget", label: "Set budget", who: "provider" });
    if (isClient && job.budget > 0n && norm(job.provider) !== norm(zeroAddress)) {
      out.push({ id: "fund", label: "Fund escrow", who: "client" });
    }
    if (isClient) out.push({ id: "cancel", label: "Cancel job", who: "client" });
  }

  if (job.status === FUNDED && !expired) {
    if (isProvider) out.push({ id: "submit", label: "Submit work", who: "provider" });
    if (isEvaluator) out.push({ id: "reject", label: "Reject", who: "evaluator" });
  }

  if (job.status === SUBMITTED) {
    const dState = dispute?.state ?? 0;
    if (isEvaluator && dState !== CHALLENGED) {
      out.push({ id: "complete", label: "Approve and release payment", who: "evaluator" });
      if (dState !== PROPOSED) out.push({ id: "reject", label: "Reject", who: "evaluator" });
    }
    if (dispute && dState === PROPOSED) {
      if (BigInt(now) < dispute.challengeEndsAt) {
        if (isProvider) out.push({ id: "challenge", label: "Challenge the rejection", who: "provider" });
      } else {
        out.push({ id: "finalize", label: "Finalize the rejection", who: "anyone" });
      }
    }
    if (dispute && dState === CHALLENGED) {
      if (BigInt(now) <= dispute.rulingDeadline) {
        if (me !== null && norm(dispute.arbiter) === me) out.push({ id: "resolve", label: "Rule on the challenge", who: "arbiter" });
      } else {
        out.push({ id: "arbiterTimeout", label: "Settle: arbiter did not rule", who: "anyone" });
      }
    }
  }

  if ((job.status === FUNDED || job.status === SUBMITTED) && expired) {
    out.push({ id: "claimRefund", label: "Refund the client (job expired)", who: "anyone" });
  }
  return out;
}

// ── Encoders ────────────────────────────────────────────────────────────────

/** A short text becomes a bytes32 reason; longer text is cut to 32 bytes. */
export function reasonToBytes32(text: string): `0x${string}` {
  return stringToHex(text.slice(0, 32), { size: 32 });
}

/** The on-chain deliverable is the hash of the delivered content. */
export function deliverableHash(content: string): `0x${string}` {
  return keccak256(stringToBytes(content));
}

/** optParams for submit: no sub-agent, plus where the delivered content can be found. */
export function submitParams(uri: string): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "string" }],
    [zeroAddress, 0n, uri],
  );
}

/** optParams for fund: the budget the client agreed to, so a late change reverts. */
export function fundParams(expectedBudget: bigint): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }], [expectedBudget]);
}

/** USDC text input to base units (6 decimals). Returns null if the text is not a valid amount. */
export function parseUsdcInput(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  return parseUnits(t, 6);
}

/** Gas to set explicitly on settlement calls of hooked jobs; estimates can come in too low. */
export function settlementGas(job: ChainJob): bigint | undefined {
  return norm(job.hook) === norm(zeroAddress) ? undefined : 600_000n;
}

/** What happens to a rejection once the evaluator sends it. Mirrors AgenticCommerce.reject. */
export type RejectOutcome =
  | { kind: "final"; reason: "unsubmitted" | "disputes-off" | "no-arbiter" }
  | { kind: "proposal"; windowSeconds: bigint };

/**
 * A rejection of submitted work is only a proposal when disputes are on and at least one
 * registered arbiter is not a party to the job. Otherwise it is final at once, which can
 * look like a broken dispute flow from the outside, so the screen says so before the click.
 */
export function rejectOutcome(job: ChainJob, disputeWindow: bigint, arbiters: readonly string[]): RejectOutcome {
  if (job.status !== SUBMITTED) return { kind: "final", reason: "unsubmitted" };
  if (disputeWindow === 0n) return { kind: "final", reason: "disputes-off" };
  const parties = new Set([norm(job.client), norm(job.provider), norm(job.evaluator)]);
  const eligible = arbiters.some((a) => !parties.has(norm(a)));
  return eligible ? { kind: "proposal", windowSeconds: disputeWindow } : { kind: "final", reason: "no-arbiter" };
}

export function rejectOutcomeText(o: RejectOutcome): string {
  if (o.kind === "proposal") {
    const mins = Number(o.windowSeconds) / 60;
    const span = mins >= 120 ? `${(mins / 60).toFixed(1)} hours` : mins >= 1 ? `${Math.round(mins)} minutes` : `${o.windowSeconds} seconds`;
    return `This rejection will be a proposal first. The provider has ${span} to challenge it. If they do not, anyone can finalize it and the client is refunded.`;
  }
  if (o.reason === "unsubmitted") return "No work was submitted yet, so this rejection is final at once and the client is refunded.";
  if (o.reason === "disputes-off") return "Disputes are switched off on this contract, so this rejection is final at once. The client is refunded and the provider cannot challenge it.";
  return "No eligible arbiter: none is registered, or every registered arbiter is a party to this job. This rejection is final at once and cannot be challenged.";
}
