import { useState } from "react";
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from "wagmi";
import { toast } from "sonner";
import { ACP_ABI, ERC20_ABI } from "../abis";
import { ACP_ADDRESS, USDC_ADDRESS, TARGET_CHAIN } from "../config";
import { fmtUsdc } from "../utils";
import { CheckCircle2, XCircle, Scale } from "lucide-react";

type Job = {
  id: bigint; client: string; provider: string; evaluator: string;
  description: string; budget: bigint; expiredAt: bigint; status: number; hook: string;
};

export default function EvaluatorView({ job }: { job: Job }) {
  const { address, isConnected } = useAccount();
  const [reason, setReason] = useState("");

  const isEvaluator = address?.toLowerCase() === job.evaluator.toLowerCase();
  const canAct = job.status === 2; // Submitted

  // Fee split preview
  const { data: feeSplit } = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "feeSplit",
    args: [job.budget], chainId: TARGET_CHAIN.id,
    query: { enabled: !!ACP_ADDRESS && job.budget > 0n },
  });

  // USDC balance of ACP (escrow sanity check)
  const { data: escrowBalance } = useReadContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf",
    args: [ACP_ADDRESS], chainId: TARGET_CHAIN.id,
    query: { enabled: !!ACP_ADDRESS },
  });

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash });
  const busy = isPending || isConfirming;

  function handleComplete() {
    if (!reason) { toast.error("Provide a reason/verdict"); return; }
    writeContract({
      address: ACP_ADDRESS, abi: ACP_ABI, functionName: "complete",
      args: [job.id, reason, "0x"], chainId: TARGET_CHAIN.id,
    });
    toast.info("Completing job…");
  }

  function handleReject() {
    if (!reason) { toast.error("Provide a rejection reason"); return; }
    writeContract({
      address: ACP_ADDRESS, abi: ACP_ABI, functionName: "reject",
      args: [job.id, reason, "0x"], chainId: TARGET_CHAIN.id,
    });
    toast.info("Rejecting job…");
  }

  if (!isConnected) {
    return <div className="card text-arc-muted text-sm text-center py-8">Connect wallet</div>;
  }

  return (
    <div className="card space-y-5">
      <div className="flex items-center gap-2">
        <Scale size={18} className="text-arc-accent" />
        <h3 className="font-display font-semibold text-arc-text">Evaluator Panel</h3>
        {isEvaluator && (
          <span className="ml-auto status-badge bg-arc-accent/20 text-arc-accent">You</span>
        )}
      </div>

      {/* Escrow summary */}
      <div className="rounded-lg bg-arc-bg p-4 space-y-3">
        <p className="text-xs font-medium text-arc-subtext uppercase tracking-wide">Escrow & fee split</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-xs text-arc-muted">Total escrowed</p>
            <p className="font-mono font-semibold text-arc-text">{fmtUsdc(job.budget)} <span className="text-arc-muted font-normal">USDC</span></p>
          </div>
          <div>
            <p className="text-xs text-arc-muted">ACP contract holds</p>
            <p className="font-mono font-semibold text-arc-text">{fmtUsdc(escrowBalance ?? 0n)} <span className="text-arc-muted font-normal">USDC</span></p>
          </div>
        </div>
        {feeSplit && (
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-arc-border">
            {[
              { label: "Platform", val: feeSplit[0], color: "text-arc-muted" },
              { label: "→ You (evaluator)", val: feeSplit[1], color: "text-arc-accent" },
              { label: "→ Provider", val: feeSplit[2], color: "text-arc-success" },
            ].map(r => (
              <div key={r.label} className="text-center">
                <p className={`text-xs ${r.color}`}>{r.label}</p>
                <p className="font-mono text-sm font-medium text-arc-text">{fmtUsdc(r.val)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {!isEvaluator ? (
        <p className="text-sm text-arc-muted text-center">
          You are not the evaluator for this job.
        </p>
      ) : !canAct ? (
        <p className="text-sm text-arc-muted text-center">
          Job must be in <strong>Submitted</strong> state to complete or reject.
        </p>
      ) : (
        <>
          <div>
            <label className="block text-xs text-arc-muted mb-1.5">Verdict / reason (required)</label>
            <textarea className="field-input resize-none" rows={4} value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Describe your evaluation. This is recorded on-chain and in the ERC-8004 ValidationRegistry." />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button className="btn-primary w-full flex items-center justify-center gap-2"
              onClick={handleComplete} disabled={busy || !reason}>
              <CheckCircle2 size={16} />
              {busy ? "Processing…" : "Complete — release payment"}
            </button>
            <button className="w-full flex items-center justify-center gap-2 rounded-lg
              border border-arc-danger/50 px-4 py-2.5 text-sm font-medium text-arc-danger
              hover:bg-arc-danger/10 disabled:opacity-40 transition-colors"
              onClick={handleReject} disabled={busy || !reason}>
              <XCircle size={16} />
              {busy ? "Processing…" : "Reject — refund client"}
            </button>
          </div>

          <p className="text-xs text-arc-muted text-center">
            Completing pays provider, evaluator, and platform. Rejecting refunds the client and slashes the provider's bond.
          </p>
        </>
      )}
    </div>
  );
}
