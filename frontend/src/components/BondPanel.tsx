// A provider's bond: USDC staked in the bond hook. Half of a job's budget is locked while
// the job is live. Free bond can be withdrawn at any time.

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Abi } from "viem";
import { BOND_HOOK_ABI, ERC20_ABI } from "../abis";
import { ARC_CHAIN_ID, BOND_HOOK_ADDRESS, USDC_ADDRESS, WRITES_ENABLED } from "../config";
import { norm } from "../lib/chain";
import { parseUsdcInput } from "../lib/actions";
import { useTx } from "../hooks/useTx";
import { Btn, C, Hint, Input } from "./ui";

const ZERO = "0x0000000000000000000000000000000000000000";
const usdc = (v: bigint) => (Number(v) / 1e6).toFixed(2);

export function BondPanel() {
  const { address } = useAccount();
  const { run, busy } = useTx();
  const [text, setText] = useState("");
  const on = WRITES_ENABLED && norm(BOND_HOOK_ADDRESS) !== ZERO && !!address;

  const total = useReadContract({ address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: "bondBalance", args: [address ?? ZERO], chainId: ARC_CHAIN_ID, query: { enabled: on, refetchInterval: 15_000, retry: false } });
  const locked = useReadContract({ address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: "bondLocked", args: [address ?? ZERO], chainId: ARC_CHAIN_ID, query: { enabled: on, refetchInterval: 15_000, retry: false } });
  const allowance = useReadContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [address ?? ZERO, BOND_HOOK_ADDRESS], chainId: ARC_CHAIN_ID, query: { enabled: on, refetchInterval: 15_000 } });

  if (!on) return null;
  if (total.isError) return null;

  const t = (total.data as bigint | undefined) ?? 0n;
  const l = (locked.data as bigint | undefined) ?? 0n;
  const a = (allowance.data as bigint | undefined) ?? 0n;
  const amount = parseUsdcInput(text);

  return (
    <div style={{ margin: "0 10px 10px", padding: 10, background: C.card, border: `1px solid ${C.line}`, borderRadius: 6 }}>
      <div style={{ fontSize: 9, letterSpacing: 1.5, color: C.accent, fontWeight: 700, marginBottom: 6 }}>YOUR BOND</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.dim, marginBottom: 8 }}>
        <span>staked {usdc(t)}</span><span>locked {usdc(l)}</span><span>free {usdc(t > l ? t - l : 0n)}</span>
      </div>
      <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="USDC amount" style={{ marginBottom: 6 }} />
      {text && !amount && <Hint tone="warn">Enter an amount with up to 6 decimals.</Hint>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {amount !== null && a < amount ? (
          <Btn busy={busy === "Approve bond"} onClick={() => run("Approve bond", { address: USDC_ADDRESS, abi: ERC20_ABI as Abi, functionName: "approve", args: [BOND_HOOK_ADDRESS, amount] })}>Approve</Btn>
        ) : (
          <Btn busy={busy === "Stake bond"} disabled={!amount} onClick={() => run("Stake bond", { address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI as Abi, functionName: "stakeBond", args: [amount] })}>Stake</Btn>
        )}
        <Btn kind="ghost" busy={busy === "Withdraw bond"} disabled={!amount} onClick={() => run("Withdraw bond", { address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI as Abi, functionName: "withdrawBond", args: [amount] })}>Withdraw</Btn>
      </div>
    </div>
  );
}
