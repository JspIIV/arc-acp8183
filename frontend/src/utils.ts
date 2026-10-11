import { USDC_DECIMALS } from "./config";

export const JOB_STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
export type JobStatusName = typeof JOB_STATUS[number];

export function statusName(s: number): JobStatusName {
  return JOB_STATUS[s] ?? "Unknown" as JobStatusName;
}

export function statusColor(s: number): string {
  switch (s) {
    case 0: return "bg-arc-border/60 text-arc-subtext";          // Open
    case 1: return "bg-arc-accent/20 text-arc-accent";           // Funded
    case 2: return "bg-arc-warn/20 text-arc-warn";               // Submitted
    case 3: return "bg-arc-success/20 text-arc-success";         // Completed
    case 4: return "bg-arc-danger/20 text-arc-danger";           // Rejected
    case 5: return "bg-arc-muted/20 text-arc-muted";             // Expired
    default: return "bg-arc-border/60 text-arc-subtext";
  }
}

export function fmtUsdc(raw: bigint): string {
  const n = Number(raw) / 10 ** USDC_DECIMALS;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmtExpiry(ts: bigint): string {
  const d = new Date(Number(ts) * 1000);
  const diff = d.getTime() - Date.now();
  if (diff < 0) return "Expired";
  if (diff < 60_000) return "< 1 min";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr`;
  return `${Math.floor(diff / 86_400_000)} d`;
}

export function parseUsdc(val: string): bigint {
  const n = parseFloat(val);
  if (isNaN(n) || n < 0) return 0n;
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}
