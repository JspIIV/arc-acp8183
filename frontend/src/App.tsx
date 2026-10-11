import { useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { ConnectKitButton } from "connectkit";
import { toast } from "sonner";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { ACP_ABI, ERC20_ABI } from "./abis";
import { ACP_ADDRESS, USDC_ADDRESS, TARGET_CHAIN } from "./config";
import { statusName, statusColor, fmtUsdc, fmtAddr, parseUsdc } from "./utils";
import JobList from "./components/JobList";
import CreateJob from "./components/CreateJob";
import ProviderView from "./components/ProviderView";
import EvaluatorView from "./components/EvaluatorView";
import { Layers, ArrowLeft, Wallet, Clock, Link2 } from "lucide-react";

type Job = {
  id: bigint; client: string; provider: string; evaluator: string;
  description: string; budget: bigint; expiredAt: bigint; status: number; hook: string;
};

type Screen = "list" | "job";

export default function App() {
  const { address, isConnected, chain } = useAccount();
  const [screen, setScreen] = useState<Screen>("list");
  const [selectedId, setSelectedId] = useState<bigint>(0n);
  const [budgetForFund, setBudgetForFund] = useState("");
  const [listKey, setListKey] = useState(0);

  // Load selected job
  const { data: job, refetch: refetchJob } = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "getJob",
    args: [selectedId], chainId: TARGET_CHAIN.id,
    query: { enabled: !!ACP_ADDRESS && selectedId > 0n },
  });

  const typedJob = job as unknown as Job | undefined;

  // USDC allowance for ACP
  const { data: allowance } = useReadContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", ACP_ADDRESS],
    chainId: TARGET_CHAIN.id,
    query: { enabled: !!address && !!ACP_ADDRESS && screen === "job" },
  });

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: txHash,
    onReplaced: () => { void refetchJob(); },
  });
  const busy = isPending || isConfirming;

  function handleSelectJob(id: bigint) {
    setSelectedId(id);
    setScreen("job");
    setBudgetForFund("");
  }

  function handleFund() {
    if (!typedJob) return;
    const expected = parseUsdc(budgetForFund);
    const optParams = expected > 0n
      ? encodeAbiParameters(parseAbiParameters("uint256"), [expected])
      : "0x";
    writeContract({
      address: ACP_ADDRESS, abi: ACP_ABI, functionName: "fund",
      args: [selectedId, optParams], chainId: TARGET_CHAIN.id,
    });
    toast.info("Funding escrow…");
  }

  function handleApproveForFund() {
    if (!typedJob) return;
    writeContract({
      address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve",
      args: [ACP_ADDRESS, typedJob.budget], chainId: TARGET_CHAIN.id,
    });
    toast.info("Approving USDC…");
  }

  function handleClaimRefund() {
    writeContract({
      address: ACP_ADDRESS, abi: ACP_ABI, functionName: "claimRefund",
      args: [selectedId], chainId: TARGET_CHAIN.id,
    });
    toast.info("Claiming refund…");
  }

  const wrongChain = isConnected && chain?.id !== TARGET_CHAIN.id;

  return (
    <div className="min-h-dvh bg-arc-bg">
      {/* Navbar */}
      <header className="sticky top-0 z-10 border-b border-arc-border bg-arc-bg/90 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Layers size={20} className="text-arc-accent" />
            <span className="font-display font-semibold text-arc-text">ACP</span>
            <span className="hidden sm:block text-xs text-arc-muted">ERC-8183 · Arc Mainnet</span>
          </div>

          <div className="ml-auto flex items-center gap-3">
            {isConnected && (
              <span className={`status-badge text-xs ${wrongChain ? "bg-arc-danger/20 text-arc-danger" : "bg-arc-success/20 text-arc-success"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${wrongChain ? "bg-arc-danger" : "bg-arc-success"}`} />
                {wrongChain ? `Wrong chain (${chain?.name})` : "Arc Mainnet"}
              </span>
            )}
            <ConnectKitButton />
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {screen === "list" ? (
          <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
            {/* Left: job list */}
            <div className="space-y-4">
              <div>
                <h1 className="font-display text-2xl font-bold text-arc-text">Jobs</h1>
                <p className="text-sm text-arc-muted mt-1">
                  ERC-8183 agentic commerce on Arc. Read live from contract events.
                </p>
              </div>
              <JobList onSelect={handleSelectJob} />
            </div>

            {/* Right: create form */}
            <div>
              <CreateJob onCreated={() => setListKey(k => k + 1)} key={listKey} />
            </div>
          </div>
        ) : typedJob ? (
          <div className="space-y-6">
            {/* Back */}
            <button onClick={() => setScreen("list")}
              className="flex items-center gap-1.5 text-sm text-arc-muted hover:text-arc-text transition-colors">
              <ArrowLeft size={15} />
              Back to jobs
            </button>

            {/* Job header */}
            <div className="card">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-mono text-xs text-arc-muted">Job #{String(typedJob.id)}</span>
                    <span className={`status-badge ${statusColor(typedJob.status)}`}>
                      {statusName(typedJob.status)}
                    </span>
                  </div>
                  <h2 className="font-display text-xl font-semibold text-arc-text">
                    {typedJob.description || "(no description)"}
                  </h2>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-display font-bold text-arc-text">
                    {fmtUsdc(typedJob.budget)}
                  </p>
                  <p className="text-xs text-arc-muted">USDC budget</p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { icon: <Wallet size={13} />, label: "Client", val: fmtAddr(typedJob.client) },
                  { icon: <Link2 size={13} />, label: "Provider", val: fmtAddr(typedJob.provider) },
                  { icon: <Layers size={13} />, label: "Evaluator", val: fmtAddr(typedJob.evaluator) },
                  { icon: <Clock size={13} />, label: "Expires", val: typedJob.expiredAt > 0n ? new Date(Number(typedJob.expiredAt) * 1000).toLocaleString() : "—" },
                ].map(r => (
                  <div key={r.label} className="rounded-lg bg-arc-bg p-2.5">
                    <div className="flex items-center gap-1 text-arc-muted mb-0.5">{r.icon}<span className="text-xs">{r.label}</span></div>
                    <p className="font-mono text-xs text-arc-text">{r.val}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Fund action (Open state, client only) */}
            {typedJob.status === 0 && address?.toLowerCase() === typedJob.client.toLowerCase() && (
              <div className="card space-y-4">
                <h3 className="font-display font-semibold text-arc-text">Fund Escrow</h3>
                <p className="text-sm text-arc-muted">
                  Lock {fmtUsdc(typedJob.budget)} USDC into escrow. Optionally provide the expected budget
                  to protect against a last-moment provider price change.
                </p>
                <div>
                  <label className="block text-xs text-arc-muted mb-1.5">Expected budget guard (optional)</label>
                  <input className="field-input" type="number" min="0" step="0.01"
                    value={budgetForFund} onChange={e => setBudgetForFund(e.target.value)}
                    placeholder="Leave blank to skip check" />
                </div>
                {(allowance ?? 0n) < typedJob.budget ? (
                  <button className="btn-primary w-full" onClick={handleApproveForFund} disabled={busy}>
                    {busy ? "Approving…" : `Approve ${fmtUsdc(typedJob.budget)} USDC`}
                  </button>
                ) : (
                  <button className="btn-primary w-full" onClick={handleFund} disabled={busy}>
                    {busy ? "Funding…" : `Fund ${fmtUsdc(typedJob.budget)} USDC`}
                  </button>
                )}
              </div>
            )}

            {/* Claim refund (expired) */}
            {(typedJob.status === 1 || typedJob.status === 2) &&
             BigInt(Math.floor(Date.now() / 1000)) > typedJob.expiredAt && (
              <div className="card space-y-3">
                <h3 className="font-display font-semibold text-arc-danger">Job Expired</h3>
                <p className="text-sm text-arc-muted">
                  This job has passed its expiry. Anyone can claim the refund back to the client.
                </p>
                <button className="btn-ghost w-full" onClick={handleClaimRefund} disabled={busy}>
                  {busy ? "Claiming…" : "Claim Refund → Client"}
                </button>
              </div>
            )}

            {/* Provider & Evaluator panels */}
            <div className="grid gap-5 lg:grid-cols-2">
              <ProviderView job={typedJob} />
              <EvaluatorView job={typedJob} />
            </div>
          </div>
        ) : (
          <div className="card text-center text-arc-muted py-12">Loading job…</div>
        )}
      </main>
    </div>
  );
}
