// Opens a job. The client names the provider and the evaluator; the provider then sets the
// budget and the client funds it. Nothing is locked until the client funds.

import { useState } from "react";
import { usePublicClient } from "wagmi";
import { isAddress, parseEventLogs, zeroAddress, type Abi } from "viem";
import { ACP_ABI } from "../abis";
import { ACP_ADDRESS, ARC_CHAIN_ID, BOND_HOOK_ADDRESS, NETWORK_LABEL, WRITES_ENABLED } from "../config";
import { norm } from "../lib/chain";
import { useTx } from "../hooks/useTx";
import { Btn, C, Field, Hint, Input, Section, TextArea } from "./ui";

export function CreateJobPanel({ onCreated }: { onCreated: (jobId: bigint) => void }) {
  const { run, busy, address, isConnected } = useTx();
  const client = usePublicClient({ chainId: ARC_CHAIN_ID });
  const [provider, setProvider] = useState("");
  const [evaluator, setEvaluator] = useState("");
  const [description, setDescription] = useState("");
  const [hours, setHours] = useState("24");
  const [useBond, setUseBond] = useState(false);

  if (!WRITES_ENABLED) {
    return <Hint>This board is on {NETWORK_LABEL}. Opening jobs from this screen is limited to Arc Testnet.</Hint>;
  }

  const bondAvailable = norm(BOND_HOOK_ADDRESS) !== norm(zeroAddress);
  const hoursN = Number(hours);
  const problems: string[] = [];
  if (!isAddress(provider)) problems.push("Provider must be a valid address.");
  if (!isAddress(evaluator)) problems.push("Evaluator must be a valid address.");
  if (isAddress(provider) && isAddress(evaluator) && norm(provider) === norm(evaluator)) problems.push("Provider and evaluator must be different addresses.");
  if (!description.trim()) problems.push("Describe the work.");
  if (!Number.isFinite(hoursN) || hoursN < 1 || hoursN > 24 * 90) problems.push("Expiry must be between 1 hour and 90 days.");
  const sameAsClient = !!address && isAddress(evaluator) && norm(evaluator) === norm(address);

  async function create() {
    if (!client || problems.length) return;
    const block = await client.getBlock({ blockTag: "latest" });
    const expiredAt = block.timestamp + BigInt(Math.round(hoursN * 3600));
    const receipt = await run("Create job", {
      address: ACP_ADDRESS, abi: ACP_ABI as Abi, functionName: "createJob",
      args: [provider, evaluator, expiredAt, description.trim(), useBond && bondAvailable ? BOND_HOOK_ADDRESS : zeroAddress],
    });
    if (!receipt) return;
    const ev = parseEventLogs({ abi: ACP_ABI as Abi, logs: receipt.logs, eventName: "JobCreated" })[0];
    const id = (ev?.args as { jobId?: bigint } | undefined)?.jobId;
    if (id !== undefined) onCreated(id);
  }

  return (
    <div>
      {!isConnected && <Hint tone="warn">Connect a wallet to open a job.</Hint>}
      <Section title="New job">
        <Field label="PROVIDER (does the work)"><Input value={provider} onChange={(e) => setProvider(e.target.value.trim())} placeholder="0x…" /></Field>
        <Field label="EVALUATOR (decides if the work is good)">
          <Input value={evaluator} onChange={(e) => setEvaluator(e.target.value.trim())} placeholder="0x…" />
        </Field>
        {sameAsClient && <Hint tone="warn">You would be judging your own job. Pick an evaluator that is neither you nor the provider, or the decision is not independent.</Hint>}
        <Field label="WHAT NEEDS TO BE DONE"><TextArea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Summarise the gas conditions of the last 1000 blocks" /></Field>
        <Field label="EXPIRES IN (HOURS)"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
        {bondAvailable && (
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, color: C.dim, marginBottom: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={useBond} onChange={(e) => setUseBond(e.target.checked)} />
            Require the provider to have a bond (the contract must allow this hook)
          </label>
        )}
        {isConnected && problems.length > 0 && (provider || evaluator || description) && (
          <div style={{ fontSize: 10, color: C.warn, marginBottom: 8 }}>{problems[0]}</div>
        )}
        <Btn busy={busy === "Create job"} disabled={!isConnected || problems.length > 0} onClick={() => void create()}>Create job</Btn>
      </Section>
      <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.5 }}>
        Next steps: the provider sets a budget, you fund it, the provider submits work, the evaluator decides.
      </div>
    </div>
  );
}
