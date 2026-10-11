import { useReadContract, useReadContracts, useWatchContractEvent } from "wagmi";
import { useState, useEffect } from "react";
import { ACP_ABI } from "../abis";
import { ACP_ADDRESS, TARGET_CHAIN } from "../config";
import { statusName, statusColor, fmtUsdc, fmtAddr, fmtExpiry } from "../utils";
import { Briefcase, RefreshCw } from "lucide-react";

type Job = {
  id: bigint; client: string; provider: string; evaluator: string;
  description: string; budget: bigint; expiredAt: bigint; status: number; hook: string;
};

const ALL_STATUSES = [-1, 0, 1, 2, 3, 4, 5];
const STATUS_LABELS = ["All", "Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

export default function JobList({ onSelect }: { onSelect: (id: bigint) => void }) {
  const [filter, setFilter] = useState(-1);
  const [jobIds, setJobIds] = useState<bigint[]>([]);

  const { data: count, refetch: refetchCount } = useReadContract({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "jobCount",
    chainId: TARGET_CHAIN.id,
    query: { enabled: !!ACP_ADDRESS },
  });

  // Build job id list when count changes
  useEffect(() => {
    if (!count) return;
    const ids: bigint[] = [];
    for (let i = 1n; i <= count; i++) ids.push(i);
    setJobIds(ids);
  }, [count]);

  // Read all jobs in one multicall
  const contracts = jobIds.map(id => ({
    address: ACP_ADDRESS, abi: ACP_ABI, functionName: "getJob" as const,
    args: [id] as const, chainId: TARGET_CHAIN.id,
  }));
  const { data: jobResults, refetch: refetchJobs } = useReadContracts({
    contracts, query: { enabled: jobIds.length > 0 },
  });

  // Watch for new jobs created
  useWatchContractEvent({
    address: ACP_ADDRESS, abi: ACP_ABI, eventName: "JobCreated",
    chainId: TARGET_CHAIN.id,
    onLogs: () => { void refetchCount(); },
    enabled: !!ACP_ADDRESS,
  });

  const jobs: Job[] = (jobResults ?? [])
    .filter(r => r.status === "success" && r.result)
    .map(r => r.result as unknown as Job);

  const visible = filter === -1 ? jobs : jobs.filter(j => j.status === filter);

  if (!ACP_ADDRESS) {
    return (
      <div className="card flex items-center gap-3 text-arc-muted">
        <Briefcase size={18} />
        <span className="text-sm">Set <code className="font-mono text-xs">VITE_ACP_ADDRESS</code> in <code className="font-mono text-xs">.env</code> to connect.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter row */}
      <div className="flex items-center gap-2 flex-wrap">
        {ALL_STATUSES.map((s, i) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors
              ${filter === s ? "bg-arc-accent text-arc-bg border-arc-accent" : "border-arc-border text-arc-subtext hover:border-arc-accent/50"}`}>
            {STATUS_LABELS[i]}
          </button>
        ))}
        <button onClick={() => { void refetchCount(); void refetchJobs(); }}
          className="ml-auto p-1.5 rounded-lg border border-arc-border text-arc-muted hover:text-arc-text transition-colors">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Jobs */}
      {visible.length === 0 ? (
        <div className="card text-center text-arc-muted text-sm py-12">
          No jobs found. Create one below.
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(job => (
            <button key={String(job.id)} onClick={() => onSelect(job.id)}
              className="card w-full text-left hover:border-arc-accent/50 transition-colors group">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs text-arc-muted">#{String(job.id)}</span>
                    <span className={`status-badge ${statusColor(job.status)}`}>
                      {statusName(job.status)}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-arc-text truncate group-hover:text-white transition-colors">
                    {job.description || "(no description)"}
                  </p>
                  <div className="mt-2 flex items-center gap-3 text-xs text-arc-muted">
                    <span>Provider: <span className="font-mono">{fmtAddr(job.provider)}</span></span>
                    <span>Evaluator: <span className="font-mono">{fmtAddr(job.evaluator)}</span></span>
                    <span>Expires: {fmtExpiry(job.expiredAt)}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-lg font-display font-semibold text-arc-text">
                    {fmtUsdc(job.budget)}
                  </p>
                  <p className="text-xs text-arc-muted">USDC</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
