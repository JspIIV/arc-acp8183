import { useState } from "react";
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from "wagmi";
import { toast } from "sonner";
import { ACP_ABI, BOND_HOOK_ABI, ERC20_ABI } from "../abis";
import { ACP_ADDRESS, BOND_HOOK_ADDRESS, USDC_ADDRESS, TARGET_CHAIN } from "../config";
import { parseUsdc, fmtUsdc } from "../utils";
import { ShieldCheck, Send } from "lucide-react";

type Job = {
  id: bigint; client: string; provider: string; evaluator: string;
  description: string; budget: bigint; expiredAt: bigint; status: number; hook: string;
};

export default function ProviderView({ job }: { job: Job }) {
  const { address, isConnected } = useAccount();
  const [bondStr,    setBondStr]    = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [subAgent,    setSubAgent]    = useState("");
  const [subCostStr,  setSubCostStr]  = useState("");

  const bondAmount = parseUsdc(bondStr);
  const subCost    = parseUsdc(subCostStr);
  const isProvider = address?.toLowerCase() === job.provider.toLowerCase();

  // Bond state: total staked
  const { data: totalBond, refetch: rfFree } = useReadContract({
    address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: "bondBalance",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    chainId: TARGET_CHAIN.id,
    query: { enabled: !!BOND_HOOK_ADDRESS && !!address },
  });
  // Locked bond against this job
  const { data: lockedBond } = useReadContract({
    address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: "lockedBond",
    args: [job.id],
    chainId: TARGET_CHAIN.id,
    query: { enabled: !!BOND_HOOK_ADDRESS },
  });
  const freeBond = (totalBond ?? 0n) - (lockedBond ?? 0n);

  // Bond requirement: 50% of job budget
  const bondRequired = job.budget / 2n;
  const hasSufficientBond = (freeBond ?? 0n) >= bondRequired;

  // USDC allowance for BondHook
  const { data: bondAllowance } = useReadContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", BOND_HOOK_ADDRESS],
    chainId: TARGET_CHAIN.id,
    query: { enabled: !!address && !!BOND_HOOK_ADDRESS },
  });

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash, onReplaced: () => { void rfFree(); },
  });
  const busy = isPending || isConfirming;

  function handleApprove() {
    writeContract({
      address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve",
      args: [BOND_HOOK_ADDRESS, bondAmount],
      chainId: TARGET_CHAIN.id,
    });
    toast.info("Approving USDC for bond…");
  }

  function handleStake() {
    writeContract({
      address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: "stakeBond",
      args: [bondAmount], chainId: TARGET_CHAIN.id,
    });
    toast.info(`Staking ${fmtUsdc(bondAmount)} USDC bond…`);
  }

  function handleWithdraw() {
    writeContract({
      address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: "withdrawBond",
      args: [bondAmount], chainId: TARGET_CHAIN.id,
    });
    toast.info(`Withdrawing ${fmtUsdc(bondAmount)} USDC bond…`);
  }

  function handleSubmit() {
    if (!deliverable) { toast.error("Enter a deliverable"); return; }
    const optParams = subAgent
      ? (() => {
          const enc = new TextEncoder();
          const addr = subAgent.padStart(64, "0");
          const cost = subCost.toString(16).padStart(64, "0");
          void addr; void cost; void enc;
          // ABI encode (address, uint256)
          const abiEncoded = `0x${
            "000000000000000000000000" + subAgent.slice(2)
          }${
            subCost.toString(16).padStart(64, "0")
          }` as `0x${string}`;
          return abiEncoded;
        })()
      : "0x" as `0x${string}`;

    writeContract({
      address: ACP_ADDRESS, abi: ACP_ABI, functionName: "submit",
      args: [job.id, new TextEncoder().encode(deliverable) as unknown as `0x${string}`, optParams],
      chainId: TARGET_CHAIN.id,
    });
    toast.info("Submitting deliverable…");
  }

  if (!isConnected) {
    return <div className="card text-arc-muted text-sm text-center py-8">Connect wallet</div>;
  }

  return (
    <div className="space-y-5">
      {/* Bond panel */}
      <div className="card space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className={hasSufficientBond ? "text-arc-success" : "text-arc-danger"} />
          <h3 className="font-display font-semibold text-arc-text">Bond</h3>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Free bond", val: freeBond ?? 0n },
            { label: "Locked bond", val: lockedBond ?? 0n },
            { label: "Required (50%)", val: bondRequired },
          ].map(r => (
            <div key={r.label} className="rounded-lg bg-arc-bg p-3 text-center">
              <p className="text-xs text-arc-muted mb-1">{r.label}</p>
              <p className="font-mono font-medium text-arc-text">{fmtUsdc(r.val)}</p>
            </div>
          ))}
        </div>

        {!hasSufficientBond && (
          <p className="text-xs text-arc-danger">
            Insufficient free bond. Stake at least {fmtUsdc(bondRequired - (freeBond ?? 0n))} more USDC to submit.
          </p>
        )}

        <div className="flex gap-2">
          <input className="field-input" type="number" min="0" step="0.01"
            value={bondStr} onChange={e => setBondStr(e.target.value)}
            placeholder="Amount USDC" />
          {(bondAllowance ?? 0n) < bondAmount ? (
            <button className="btn-primary shrink-0" onClick={handleApprove} disabled={busy || bondAmount === 0n}>
              Approve
            </button>
          ) : (
            <>
              <button className="btn-primary shrink-0" onClick={handleStake} disabled={busy || bondAmount === 0n}>
                Stake
              </button>
              <button className="btn-ghost shrink-0" onClick={handleWithdraw} disabled={busy || bondAmount === 0n}>
                Withdraw
              </button>
            </>
          )}
        </div>
      </div>

      {/* Submit panel */}
      {isProvider && job.status === 1 && (
        <div className="card space-y-4">
          <div className="flex items-center gap-2">
            <Send size={18} className="text-arc-accent" />
            <h3 className="font-display font-semibold text-arc-text">Submit Deliverable</h3>
          </div>

          <div>
            <label className="block text-xs text-arc-muted mb-1.5">Deliverable (URI, hash, or data)</label>
            <textarea className="field-input resize-none" rows={3} value={deliverable}
              onChange={e => setDeliverable(e.target.value)}
              placeholder="ipfs://... or https://... or any reference" />
          </div>

          <div className="rounded-lg border border-arc-border/50 p-4 space-y-3">
            <p className="text-xs font-medium text-arc-subtext">Sub-agent payout (optional)</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-arc-muted mb-1.5">Sub-agent address</label>
                <input className="field-input font-mono" value={subAgent}
                  onChange={e => setSubAgent(e.target.value)} placeholder="0x…" />
              </div>
              <div>
                <label className="block text-xs text-arc-muted mb-1.5">Sub-agent cost (USDC)</label>
                <input className="field-input" type="number" min="0" step="0.01"
                  value={subCostStr} onChange={e => setSubCostStr(e.target.value)} placeholder="0.00" />
              </div>
            </div>
            {subAgent && (
              <p className="text-xs text-arc-muted">
                BondHook will pull {fmtUsdc(subCost)} USDC from your wallet on completion.
                Ensure you have approved BondHook for at least this amount.
              </p>
            )}
          </div>

          <button className="btn-primary w-full" onClick={handleSubmit}
            disabled={busy || !hasSufficientBond || !BOND_HOOK_ADDRESS}>
            {busy ? "Submitting…" : "Submit Deliverable"}
          </button>
        </div>
      )}
    </div>
  );
}
