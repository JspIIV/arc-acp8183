// Side panels around the board. All numbers shown here come from Arc.

import { useState } from "react";
import { PasskeyWalletPanel } from "./PasskeyWalletPanel";
import { PayoutsPanel } from "./PayoutsPanel";
import { useArcWorld, type AcpJob } from "../context/ArcWorldContext";
import { arcMainnet } from "../config";
import { JOB_STATUS, STATUS_COLOR_BY_JOB, shortAddr, usdc, type LedgerKind } from "../lib/chain";
import { BIOME_BY_ROLE, ROLE_LABEL, STATUS_COLOR } from "../lib/world";

const EXPLORER = arcMainnet.blockExplorers.default.url;

function Mono({ children }: { children: string }) {
  return <span style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{children}</span>;
}

function timeAgo(ts: number | null, block: bigint): string {
  if (ts === null) return `block ${block.toString()}`;
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ─── Left panel ──────────────────────────────────────────────────────────────
export function LeftPanel({ onSelectJob }: { onSelectJob: (j: AcpJob) => void }) {
  const w = useArcWorld();
  const [tab, setTab] = useState<"agents" | "jobs">("agents");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "rgba(5,12,23,0.97)", borderRight: "1px solid #0f2035" }}>
      <div style={{ padding: "10px 10px 0", flexShrink: 0 }}>
        <PasskeyWalletPanel />
      </div>
      <PayoutsPanel />

      <div style={{ padding: "8px 14px 8px", borderBottom: "1px solid #0f2035" }}>
        <div style={{ fontSize: 9, letterSpacing: 2, color: "#4b6a8a", fontWeight: 700, marginBottom: 6 }}>ON-CHAIN</div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["agents", "jobs"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: "4px 0", fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
              background: tab === t ? "rgba(172,198,233,0.12)" : "transparent",
              border: `1px solid ${tab === t ? "#acc6e9" : "#0f2035"}`,
              borderRadius: 3, color: tab === t ? "#acc6e9" : "#4b6a8a", cursor: "pointer",
            }}>
              {t === "agents" ? `ADDRESSES (${w.agents.length})` : `JOBS (${w.jobs.length})`}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
          <span style={{ fontSize: 8, color: "#4b6a8a" }}>
            {w.head !== null ? `Block ${w.head.toString()}` : w.configured ? "Reading…" : "Not configured"}
          </span>
          <button onClick={w.refetch} disabled={!w.configured} style={{
            fontSize: 8, fontWeight: 700, letterSpacing: 0.8, color: "#85b1ed", background: "transparent",
            border: "1px solid #1a3a5a", borderRadius: 3, padding: "2px 6px", cursor: w.configured ? "pointer" : "default",
          }}>REFRESH</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "agents" ? (
          w.agents.length === 0 ? (
            <div style={{ padding: 16, fontSize: 11, color: "#4b6a8a", textAlign: "center" }}>
              {w.loading ? "Reading jobs…" : "No addresses yet. They appear once a job exists."}
            </div>
          ) : w.agents.map((n) => {
            const b = BIOME_BY_ROLE[n.role];
            const st = w.statusOf(n.id);
            const dot = st === "review" ? STATUS_COLOR.review : b.accent;
            return (
              <button key={n.id} onClick={() => { w.setSelected(n.id); w.setFocusId(n.id); }} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", width: "100%",
                background: w.selectedId === n.id ? "rgba(172,198,233,0.08)" : "transparent",
                border: "none", borderLeft: `2px solid ${w.selectedId === n.id ? "#acc6e9" : "transparent"}`,
                cursor: "pointer", textAlign: "left",
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 4, flexShrink: 0, background: b.base, border: `1.5px solid ${dot}`,
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: dot,
                }}>{ROLE_LABEL[n.role][0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#c8d9ec", fontFamily: "monospace" }}>{n.name}</div>
                  <div style={{ fontSize: 9, color: "#4b6a8a", marginTop: 1 }}>{ROLE_LABEL[n.role]} · {n.live} live</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#c8d9ec" }}>{n.jobs}</div>
                  <div style={{ fontSize: 8, color: "#4b6a8a", letterSpacing: 0.5 }}>{n.jobs === 1 ? "JOB" : "JOBS"}</div>
                </div>
              </button>
            );
          })
        ) : w.jobs.length === 0 ? (
          <div style={{ padding: 16, fontSize: 11, color: "#4b6a8a", textAlign: "center" }}>No on-chain jobs</div>
        ) : [...w.jobs].reverse().map((j) => {
          const name = JOB_STATUS[j.status] ?? "Open";
          const dot = STATUS_COLOR_BY_JOB[name];
          return (
            <button key={j.id.toString()} onClick={() => onSelectJob(j)} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", width: "100%",
              background: "transparent", border: "none", borderLeft: `2px solid ${dot}`, cursor: "pointer", textAlign: "left",
            }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "#c8d9ec" }}>Job #{j.id.toString()}</div>
                <div style={{ fontSize: 9, color: "#4b6a8a", marginTop: 1 }}>{usdc(j.budget).toFixed(2)} USDC</div>
              </div>
              <div style={{ fontSize: 9, fontWeight: 700, color: dot }}>{name.toUpperCase()}</div>
            </button>
          );
        })}
      </div>

      <div style={{ padding: "10px 14px", borderTop: "1px solid #0f2035" }}>
        <div style={{ fontSize: 9, color: "#4b6a8a", letterSpacing: 1.5, marginBottom: 3 }}>ARC ESCROW</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#8dd89f" }}>
          {w.escrow.toFixed(2)} <span style={{ fontSize: 10, color: "#4b6a8a" }}>USDC locked</span>
        </div>
      </div>
    </div>
  );
}

// ─── Bottom ledger ───────────────────────────────────────────────────────────
const KIND_COLOR: Record<LedgerKind, string> = {
  created: "#85b1ed", funded: "#85b1ed", submitted: "#f59e0b",
  completed: "#8dd89f", rejected: "#e86d7a", dispute: "#f59e0b", expired: "#64748b",
};
const KIND_BADGE: Record<LedgerKind, string> = {
  created: "CREATED", funded: "FUNDED", submitted: "DELIVERED",
  completed: "APPROVED", rejected: "REJECTED", dispute: "DISPUTE", expired: "EXPIRED",
};

export function BottomLedger() {
  const w = useArcWorld();
  const [tab, setTab] = useState<"all" | "settled" | "disputes">("all");
  const rows = w.ledger.filter((e) => {
    if (tab === "settled") return ["completed", "rejected", "expired"].includes(e.kind);
    if (tab === "disputes") return e.kind === "dispute";
    return true;
  });
  let range: string | null = null;
  if (w.head !== null && w.eventsFrom !== null && w.eventsFloor !== null) {
    if (w.eventsComplete) {
      range = w.eventsFromDeploy
        ? `Full history since deployment (blocks ${w.eventsFloor.toString()} to ${w.head.toString()})`
        : `Recent events only (blocks ${w.eventsFloor.toString()} to ${w.head.toString()})`;
    } else {
      const total = w.head - w.eventsFloor;
      const done = w.head - w.eventsFrom;
      const pct = total > 0n ? Number((done * 100n) / total) : 100;
      range = `Reading history: ${pct}% (${(w.eventsFrom - w.eventsFloor).toString()} blocks left)`;
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "rgba(5,12,23,0.97)", borderTop: "1px solid #0f2035" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "5px 14px", borderBottom: "1px solid #0f2035", flexShrink: 0, gap: 2 }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#4b6a8a", fontWeight: 700, marginRight: 10 }}>LEDGER</span>
        {(["all", "settled", "disputes"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "3px 10px", fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
            background: tab === t ? "rgba(172,198,233,0.12)" : "transparent",
            border: tab === t ? "1px solid #acc6e9" : "1px solid transparent",
            borderRadius: 12, color: tab === t ? "#acc6e9" : "#4b6a8a", cursor: "pointer",
          }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 9, color: w.eventsError ? "#e86d7a" : "#4b6a8a" }}>
          {w.eventsError ? `Event history unavailable: ${w.eventsError.slice(0, 60)}` : range}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {rows.length === 0 ? (
          <div style={{ padding: 10, fontSize: 10, color: "#4b6a8a", textAlign: "center" }}>
            {w.configured ? "No contract events in this window" : "Set VITE_ACP_ADDRESS to read the ledger"}
          </div>
        ) : rows.map((e) => {
          const c = KIND_COLOR[e.kind];
          return (
            <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 14px", borderBottom: "1px solid #0a1e30" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, marginTop: 3 }}>
                <div style={{ width: 6, height: 6, borderRadius: 1, background: c }} />
                <div style={{ fontSize: 8, fontWeight: 700, color: c, letterSpacing: 0.8, minWidth: 58, padding: "1px 4px", border: `1px solid ${c}44`, borderRadius: 2 }}>
                  {KIND_BADGE[e.kind]}
                </div>
              </div>
              <div style={{ flex: 1, fontSize: 10, color: "#7a94b0", lineHeight: 1.45 }}>
                {e.text}
                {e.txHash && (
                  <a href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noreferrer"
                    style={{ marginLeft: 8, color: "#85b1ed", textDecoration: "none" }}>tx</a>
                )}
              </div>
              <div style={{ fontSize: 9, color: "#2d4a6a", flexShrink: 0 }}>{timeAgo(e.ts, e.block)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Right detail panel ──────────────────────────────────────────────────────
function Row({ label, children, color = "#acc6e9" }: { label: string; children: string; color?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 8, color: "#4b6a8a", letterSpacing: 1.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color }}><Mono>{children}</Mono></div>
    </div>
  );
}

export function RightPanel({ acpJob, onClose, onSelectJob }: {
  acpJob: AcpJob | null; onClose: () => void; onSelectJob: (j: AcpJob) => void;
}) {
  const w = useArcWorld();
  const node = w.agents.find((n) => n.id === w.selectedId);
  if (!acpJob && !node) return null;
  const b = node ? BIOME_BY_ROLE[node.role] : BIOME_BY_ROLE.provider;
  const myJobs = node ? w.jobs.filter((j) => [j.client, j.provider, j.evaluator].some((a) => a.toLowerCase() === node.id)) : [];

  return (
    <div style={{
      position: "absolute", right: 0, top: 0, bottom: 0, width: 290, background: "rgba(5,12,23,0.97)",
      borderLeft: "1px solid #0f2035", display: "flex", flexDirection: "column", zIndex: 20,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid #0f2035" }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#4b6a8a", fontWeight: 700 }}>{acpJob ? "ACP JOB" : "ADDRESS"}</span>
        <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: "#4b6a8a", cursor: "pointer", fontSize: 14 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
        {acpJob ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#c8d9ec", marginBottom: 4 }}>Job #{acpJob.id.toString()}</div>
            <div style={{ fontSize: 10, color: STATUS_COLOR_BY_JOB[JOB_STATUS[acpJob.status] ?? "Open"], fontWeight: 700, marginBottom: 8 }}>
              {(JOB_STATUS[acpJob.status] ?? "Open").toUpperCase()}
            </div>
            <div style={{ fontSize: 10, color: "#7a94b0", lineHeight: 1.5, marginBottom: 14 }}>{acpJob.description}</div>
            <Row label="BUDGET" color="#8dd89f">{`${usdc(acpJob.budget).toFixed(2)} USDC`}</Row>
            <Row label="CLIENT">{acpJob.client}</Row>
            <Row label="PROVIDER">{acpJob.provider}</Row>
            <Row label="EVALUATOR">{acpJob.evaluator}</Row>
            <Row label="EXPIRES">{new Date(Number(acpJob.expiredAt) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"}</Row>
            <a href={`${EXPLORER}/address/${acpJob.client}`} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "#85b1ed" }}>Client on explorer</a>
          </>
        ) : node ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{
                width: 42, height: 42, borderRadius: 6, background: b.base, border: `2px solid ${b.accent}`,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: b.accent,
              }}>{ROLE_LABEL[node.role][0]}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#c8d9ec", fontFamily: "monospace" }}>{shortAddr(node.id)}</div>
                <div style={{ fontSize: 9, color: b.accent, fontWeight: 700, letterSpacing: 0.8 }}>
                  {node.roles.map((r) => ROLE_LABEL[r]).join(" + ")}
                </div>
              </div>
            </div>
            <Row label="ADDRESS">{node.id}</Row>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 14 }}>
              {[
                { label: "JOBS", value: String(node.jobs), color: "#acc6e9" },
                { label: "VOLUME", value: node.volume.toFixed(2), color: "#8dd89f" },
                { label: "BOND", value: node.bond === null ? "n/a" : node.bond.toFixed(2), color: "#f59e0b" },
              ].map((s) => (
                <div key={s.label} style={{ background: "rgba(15,32,53,0.8)", borderRadius: 4, padding: "7px 8px", textAlign: "center", border: "1px solid #0f2035" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 7, color: "#4b6a8a", letterSpacing: 0.8, marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
            {node.bondLocked !== null && node.bondLocked > 0 && (
              <div style={{ fontSize: 9, color: "#7a94b0", marginBottom: 10 }}>{node.bondLocked.toFixed(2)} USDC of the bond is locked in live jobs.</div>
            )}
            <div style={{ fontSize: 8, color: "#4b6a8a", letterSpacing: 1.5, marginBottom: 4 }}>JOBS</div>
            {myJobs.map((j) => (
              <button key={j.id.toString()} onClick={() => onSelectJob(j)} style={{
                display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none",
                padding: "4px 0", fontSize: 10, color: "#85b1ed", cursor: "pointer",
              }}>
                Job #{j.id.toString()} · {JOB_STATUS[j.status]} · {usdc(j.budget).toFixed(2)} USDC
              </button>
            ))}
            <div style={{ fontSize: 9, color: "#4b6a8a", marginTop: 12, lineHeight: 1.5 }}>
              Volume is the budget of jobs where this address is client or provider. Bond is read from the bond hook.
            </div>
            <a href={`${EXPLORER}/address/${node.id}`} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "#85b1ed" }}>Open on explorer</a>
          </>
        ) : null}
      </div>
    </div>
  );
}
