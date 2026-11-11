// What the connected wallet can do with one job, right now. The rules live in lib/actions.ts;
// this component only draws the forms and sends the calls.

import { useState } from "react";
import { useReadContract } from "wagmi";
import type { Abi } from "viem";
import { ACP_ABI, ERC20_ABI } from "../abis";
import { ACP_ADDRESS, ARC_CHAIN_ID, NETWORK_LABEL, USDC_ADDRESS, WRITES_ENABLED } from "../config";
import { useArcWorld } from "../context/ArcWorldContext";
import { norm, type ChainJob } from "../lib/chain";
import {
  availableActions, deliverableHash, fundParams, parseUsdcInput, reasonToBytes32, rejectOutcome, rejectOutcomeText,
  settlementGas, submitParams, type ActionId, type DisputeView,
} from "../lib/actions";
import { useNow, useTx } from "../hooks/useTx";
import { Btn, C, Field, Hint, Input, Section, TextArea } from "./ui";

const usdc = (v: bigint) => (Number(v) / 1e6).toFixed(2);
const ABI = ACP_ABI as Abi;

export function JobActionsPanel({ job }: { job: ChainJob }) {
  const { submissions } = useArcWorld();
  const { run, busy, address, isConnected, wrongChain } = useTx();
  const now = useNow();
  const [budgetText, setBudgetText] = useState("");
  const [content, setContent] = useState("");
  const [uri, setUri] = useState("");
  const [reason, setReason] = useState("");
  const [check, setCheck] = useState("");

  const disputeQ = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "getDispute", args: [job.id], chainId: ARC_CHAIN_ID,
    query: { enabled: job.status === 2, refetchInterval: 15_000, retry: false },
  });
  const depositQ = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "disputeDeposit", chainId: ARC_CHAIN_ID,
    query: { enabled: job.status === 2, retry: false },
  });
  const windowQ = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "disputeWindow", chainId: ARC_CHAIN_ID,
    query: { enabled: job.status === 2, refetchInterval: 30_000, retry: false },
  });
  const arbitersQ = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "arbiters", chainId: ARC_CHAIN_ID,
    query: { enabled: job.status === 2, refetchInterval: 30_000, retry: false },
  });
  const allowanceQ = useReadContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", ACP_ADDRESS], chainId: ARC_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  if (!WRITES_ENABLED) {
    return <Hint>This board is on {NETWORK_LABEL}. Actions from this screen are limited to Arc Testnet, so here it only shows what is on chain.</Hint>;
  }

  const raw = disputeQ.data as { state: number; challengeEndsAt: bigint; rulingDeadline: bigint; arbiter: string; deposit: bigint } | undefined;
  const dispute: DisputeView | null = raw
    ? { state: Number(raw.state), challengeEndsAt: BigInt(raw.challengeEndsAt), rulingDeadline: BigInt(raw.rulingDeadline), arbiter: raw.arbiter, deposit: BigInt(raw.deposit) }
    : null;
  const actions = availableActions({ job, account: address ?? null, now, dispute });
  const has = (id: ActionId) => actions.some((a) => a.id === id);
  const allowance = (allowanceQ.data as bigint | undefined) ?? 0n;
  const deposit = (depositQ.data as bigint | undefined) ?? 0n;
  const submission = submissions.get(job.id.toString());
  // Only explain the outcome once both reads succeeded; a contract without disputes just settles.
  const outcome = job.status === 1 ? rejectOutcome(job, 0n, []) : windowQ.data !== undefined && arbitersQ.data !== undefined
    ? rejectOutcome(job, BigInt(windowQ.data as bigint), arbitersQ.data as readonly string[])
    : windowQ.isError ? rejectOutcome(job, 0n, []) : null;
  const send = (label: string, functionName: string, args: unknown[], gas?: bigint) =>
    run(label, { address: ACP_ADDRESS, abi: ABI, functionName, args, gas });
  const approve = (label: string, amount: bigint) =>
    run(label, { address: USDC_ADDRESS, abi: ERC20_ABI as Abi, functionName: "approve", args: [ACP_ADDRESS, amount] });

  const roles = [
    address && norm(address) === norm(job.client) ? "client" : null,
    address && norm(address) === norm(job.provider) ? "provider" : null,
    address && norm(address) === norm(job.evaluator) ? "evaluator" : null,
  ].filter(Boolean).join(", ");
  const budget = parseUsdcInput(budgetText);
  const needReason = reason.trim().length === 0;

  return (
    <div style={{ marginTop: 14 }}>
      {!isConnected && <Hint tone="warn">Connect a wallet to act on this job.</Hint>}
      {isConnected && <div style={{ fontSize: 10, color: C.dim, marginBottom: 8 }}>You are: {roles || "not a party to this job"}</div>}
      {wrongChain && <Hint tone="warn">Your wallet is on another network. The next action will ask it to switch to {NETWORK_LABEL}.</Hint>}
      {isConnected && actions.length === 0 && <Hint>Nothing for your wallet to do on this job right now.</Hint>}

      {has("setBudget") && (
        <Section title="Set the budget">
          <Field label="BUDGET (USDC)"><Input inputMode="decimal" value={budgetText} onChange={(e) => setBudgetText(e.target.value)} placeholder="10.00" /></Field>
          <Btn busy={busy === "Set budget"} disabled={!budget} onClick={() => send("Set budget", "setBudget", [job.id, budget, "0x"])}>Set budget</Btn>
        </Section>
      )}

      {has("fund") && (
        <Section title="Fund the escrow">
          <Hint>The provider set the budget to {usdc(job.budget)} USDC. Funding locks that amount until the evaluator decides, or until the job expires.</Hint>
          {allowance < job.budget ? (
            <Btn busy={busy === "Approve USDC"} onClick={() => approve("Approve USDC", job.budget)}>Approve {usdc(job.budget)} USDC</Btn>
          ) : (
            <Btn busy={busy === "Fund escrow"} onClick={() => send("Fund escrow", "fund", [job.id, fundParams(job.budget)])}>Fund {usdc(job.budget)} USDC</Btn>
          )}
        </Section>
      )}

      {has("submit") && (
        <Section title="Submit your work">
          {norm(job.hook) !== "0x0000000000000000000000000000000000000000" && (
            <Hint tone="warn">This job requires a bond. The call reverts unless you have enough free bond staked (half the budget).</Hint>
          )}
          <Field label="DELIVERABLE (the exact content)"><TextArea value={content} onChange={(e) => setContent(e.target.value)} placeholder="What you are delivering. Its hash is stored on chain." /></Field>
          <Field label="WHERE TO FIND IT (optional link)"><Input value={uri} onChange={(e) => setUri(e.target.value)} placeholder="ipfs://… or https://…" /></Field>
          {content && <div style={{ fontSize: 9, color: C.muted, fontFamily: "monospace", wordBreak: "break-all", marginBottom: 8 }}>hash {deliverableHash(content)}</div>}
          <Btn busy={busy === "Submit work"} disabled={!content.trim()} onClick={() => send("Submit work", "submit", [job.id, deliverableHash(content), submitParams(uri.trim())])}>Submit work</Btn>
        </Section>
      )}

      {(has("complete") || has("reject")) && (
        <Section title="Your decision">
          {submission ? (
            <>
              <div style={{ fontSize: 9, color: C.muted, fontFamily: "monospace", wordBreak: "break-all", marginBottom: 4 }}>delivered hash {submission.deliverable}</div>
              {submission.uri && <div style={{ fontSize: 9, color: C.dim, marginBottom: 6, wordBreak: "break-all" }}>link {submission.uri}</div>}
              <Field label="PASTE THE DELIVERED CONTENT TO CHECK IT"><TextArea rows={2} value={check} onChange={(e) => setCheck(e.target.value)} /></Field>
              {check && (deliverableHash(check).toLowerCase() === submission.deliverable.toLowerCase()
                ? <Hint tone="ok">The content matches the delivered hash.</Hint>
                : <Hint tone="bad">The content does NOT match the delivered hash.</Hint>)}
            </>
          ) : <Hint>The delivered hash is not in the events window shown on the board. Read it from the explorer before deciding.</Hint>}
          <Field label="REASON (stored on chain, up to 32 characters)"><Input maxLength={32} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div style={{ display: "grid", gap: 6 }}>
            {has("complete") && <Btn busy={busy === "Approve work"} disabled={needReason} onClick={() => send("Approve work", "complete", [job.id, reasonToBytes32(reason), "0x"], settlementGas(job))}>Approve and release payment</Btn>}
            {has("reject") && <Btn kind="danger" busy={busy === "Reject"} disabled={needReason} onClick={() => send("Reject", "reject", [job.id, reasonToBytes32(reason), "0x"], settlementGas(job))}>Reject</Btn>}
          </div>
          {has("reject") && outcome && <Hint tone={outcome.kind === "final" && outcome.reason !== "unsubmitted" ? "warn" : undefined}>{rejectOutcomeText(outcome)}</Hint>}
        </Section>
      )}

      {has("cancel") && (
        <Section title="Cancel">
          <Btn kind="danger" busy={busy === "Cancel job"} onClick={() => send("Cancel job", "reject", [job.id, reasonToBytes32("cancelled by client"), "0x"])}>Cancel this job</Btn>
        </Section>
      )}

      {has("challenge") && (
        <Section title="Challenge the rejection">
          <Hint>{deposit > 0n ? `A deposit of ${usdc(deposit)} USDC is required. You get it back if the arbiter overturns the rejection.` : "No deposit is required."} An arbiter is assigned when you challenge.</Hint>
          {deposit > allowance
            ? <Btn busy={busy === "Approve deposit"} onClick={() => approve("Approve deposit", deposit)}>Approve {usdc(deposit)} USDC</Btn>
            : <Btn busy={busy === "Challenge"} onClick={() => send("Challenge", "challengeRejection", [job.id])}>Challenge</Btn>}
        </Section>
      )}

      {has("resolve") && (
        <Section title="Rule on the challenge">
          <Field label="REASON (up to 32 characters)"><Input maxLength={32} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div style={{ display: "grid", gap: 6 }}>
            <Btn busy={busy === "Overturn"} disabled={needReason} onClick={() => send("Overturn", "resolveDispute", [job.id, false, reasonToBytes32(reason)], settlementGas(job))}>Overturn: pay the provider</Btn>
            <Btn kind="danger" busy={busy === "Uphold"} disabled={needReason} onClick={() => send("Uphold", "resolveDispute", [job.id, true, reasonToBytes32(reason)], settlementGas(job))}>Uphold: refund the client</Btn>
          </div>
        </Section>
      )}

      {has("finalize") && <Section title="Rejection window closed"><Btn busy={busy === "Finalize"} onClick={() => send("Finalize", "finalizeRejection", [job.id], settlementGas(job))}>Finalize the rejection</Btn></Section>}
      {has("arbiterTimeout") && <Section title="Arbiter did not rule"><Btn busy={busy === "Settle"} onClick={() => send("Settle", "settleArbiterTimeout", [job.id], settlementGas(job))}>Settle the dispute</Btn></Section>}
      {has("claimRefund") && <Section title="Job expired"><Btn busy={busy === "Refund"} onClick={() => send("Refund", "claimRefund", [job.id])}>Credit the refund to the client</Btn></Section>}
    </div>
  );
}
