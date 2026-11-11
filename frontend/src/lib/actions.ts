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
