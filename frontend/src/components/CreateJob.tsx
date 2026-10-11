import { useState } from "react";
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from "wagmi";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { toast } from "sonner";
import { ACP_ABI, ERC20_ABI } from "../abis";
import { ACP_ADDRESS, USDC_ADDRESS, USDC_DECIMALS, TARGET_CHAIN } from "../config";
import { parseUsdc, fmtUsdc } from "../utils";
import { PlusCircle, Info } from "lucide-react";

export default function CreateJob({ onCreated }: { onCreated?: () => void }) {
  const { address, isConnected } = useAccount();
  const [provider,    setProvider]    = useState("");
  const [evaluator,   setEvaluator]   = useState("");
  const [description, setDescription] = useState("");
  const [budgetStr,   setBudgetStr]   = useState("");
  const [expiryHours, setExpiryHours] = useState("24");
  const [expectedBudget, setExpectedBudget] = useState("");
  const [crossChain,  setCrossChain]  = useState(false);

  const budget = parseUsdc(budgetStr);
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + Number(expiryHours) * 3600);

  // Fee preview
  const { data: feeSplit } = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "feeSplit",
    args: [budget], chainId: TARGET_CHAIN.id,
    query: { enabled: !!ACP_ADDRESS && budget > 0n },
  });

  // USDC allowance
  const { data: allowance } = useReadContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", ACP_ADDRESS],
    chainId: TARGET_CHAIN.id,
    query: { enabled: !!address && !!ACP_ADDRESS },
  });

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  if (isSuccess && onCreated) { onCreated(); }

  const needsApproval = allowance !== undefined && budget > 0n && allowance < budget;

  function handleApprove() {
    writeContract({
      address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve",
      args: [ACP_ADDRESS, budget],
      chainId: TARGET_CHAIN.id,
    });
    toast.info("Approving USDC…");
  }

  function handleCreate() {
    if (!provider || !evaluator || !description || budget === 0n) {
      toast.error("Fill in all fields"); return;
    }
    // optParams for fund: encode expected budget guard
    const fundOptParams = expectedBudget
      ? encodeAbiParameters(parseAbiParameters("uint256"), [parseUsdc(expectedBudget)])
      : "0x";

    // Step 1: createJob (provider can be address(0) if not known yet)
    writeContract({
      address: ACP_ADDRESS, abi: ACP_ABI, functionName: "createJob",
      args: [
        provider as `0x${string}`,
        evaluator as `0x${string}`,
        expiredAt,
        description,
        "0x0000000000000000000000000000000000000000",
      ],
      chainId: TARGET_CHAIN.id,
    });
    toast.info("Creating job…");
    void fundOptParams;
  }

  const busy = isPending || isConfirming;

  return (
    <div className="card space-y-5">
      <div className="flex items-center gap-2">
        <PlusCircle size={18} className="text-arc-accent" />
        <h2 className="font-display font-semibold text-arc-text">Create Job</h2>
      </div>

      {/* Cross-chain toggle */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <div onClick={() => setCrossChain(!crossChain)}
          className={`relative w-10 h-5 rounded-full transition-colors ${crossChain ? "bg-arc-accent" : "bg-arc-border"}`}>
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${crossChain ? "translate-x-5" : ""}`} />
        </div>
        <span className="text-sm text-arc-subtext">Cross-chain funding via CCTP</span>
      </label>

      {crossChain && (
        <div className="rounded-lg border border-arc-warn/30 bg-arc-warn/10 p-3 text-xs text-arc-warn flex gap-2">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>Cross-chain: deploy CCTPJobFunder on the source chain, create the job from its address, then call <code className="font-mono">depositForBurn</code> on the source. The funder contract will call <code className="font-mono">fund()</code> on Arc on your behalf.</span>
        </div>
      )}

      <div className="grid gap-4">
        <div>
          <label className="block text-xs text-arc-muted mb-1.5">Provider address</label>
          <input className="field-input font-mono" value={provider}
            onChange={e => setProvider(e.target.value)}
            placeholder="0x… (address(0) if not yet decided)" />
        </div>
        <div>
          <label className="block text-xs text-arc-muted mb-1.5">Evaluator address</label>
          <input className="field-input font-mono" value={evaluator}
            onChange={e => setEvaluator(e.target.value)} placeholder="0x…" />
        </div>
        <div>
          <label className="block text-xs text-arc-muted mb-1.5">Job description</label>
          <textarea className="field-input resize-none" rows={3} value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Describe what the provider must deliver" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-arc-muted mb-1.5">Budget (USDC)</label>
            <input className="field-input" type="number" min="0" step="0.01"
              value={budgetStr} onChange={e => setBudgetStr(e.target.value)} placeholder="100.00" />
          </div>
          <div>
            <label className="block text-xs text-arc-muted mb-1.5">Expires in (hours)</label>
            <input className="field-input" type="number" min="1"
              value={expiryHours} onChange={e => setExpiryHours(e.target.value)} placeholder="24" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-arc-muted mb-1.5">Expected budget guard (optional)</label>
          <input className="field-input" type="number" min="0" step="0.01"
            value={expectedBudget} onChange={e => setExpectedBudget(e.target.value)}
            placeholder="Leave blank to skip — protects against provider raising budget before fund" />
        </div>
      </div>

      {/* Fee preview */}
      {feeSplit && budget > 0n && (
        <div className="rounded-lg border border-arc-border bg-arc-bg p-4 space-y-2">
          <p className="text-xs font-medium text-arc-subtext uppercase tracking-wide">Fee split preview</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Platform", val: feeSplit[0] },
              { label: "Evaluator", val: feeSplit[1] },
              { label: "Provider", val: feeSplit[2] },
            ].map(row => (
              <div key={row.label} className="rounded-lg bg-arc-surface p-2">
                <p className="text-xs text-arc-muted">{row.label}</p>
                <p className="font-mono text-sm font-medium text-arc-text">{fmtUsdc(row.val)}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-arc-muted text-center">
            Sum: {fmtUsdc(feeSplit[0] + feeSplit[1] + feeSplit[2])} USDC
            {feeSplit[0] + feeSplit[1] + feeSplit[2] === budget
              ? <span className="text-arc-success ml-1">✓ matches budget</span>
              : <span className="text-arc-danger ml-1">✗ mismatch</span>}
          </p>
        </div>
      )}

      {!isConnected ? (
        <p className="text-sm text-arc-muted text-center">Connect wallet to continue</p>
      ) : needsApproval ? (
        <button className="btn-primary w-full" onClick={handleApprove} disabled={busy}>
          {busy ? "Approving…" : `Approve ${fmtUsdc(budget)} USDC`}
        </button>
      ) : (
        <button className="btn-primary w-full" onClick={handleCreate} disabled={busy || !ACP_ADDRESS}>
          {busy ? "Creating…" : "Create Job"}
        </button>
      )}

      {!ACP_ADDRESS && (
        <p className="text-xs text-center text-arc-danger">
          Set <code className="font-mono">VITE_ACP_ADDRESS</code> in <code className="font-mono">.env</code>
        </p>
      )}

      <p className="text-xs text-arc-muted text-center">
        After creating, use <strong>Fund</strong> to escrow the USDC budget.
      </p>
    </div>
  );
}
