// Left sovereign directory + bottom ledger, ported from arc-a2a-pipeline
// and adapted for ACP: node list shows agent nodes; ledger shows both
// engine events and ACP job events; right slide-over shows ACP job detail.

import { useState } from "react";
import { useArcWorld, lockedEscrow, agreementsOf, type AcpJob } from "../context/ArcWorldContext";
import { type AgentNode, type Agreement, type LedgerKind, TIER_LABEL, KIND_LABEL } from "../lib/engine";
import { useContractRead } from "wagmi";
import { ACP_ADDRESS } from "../config";
import { ACP_ABI as AGENT_MARKET_ABI } from "../abis";
import { formatUsdc, shortAddr, JOB_STATUS } from "../utils";

// ── Ledger kind styling ───────────────────────────────────────────────────────
const KIND_DOT: Record<LedgerKind, string> = {
  "node-founded":       "#8dd89f",
  "agreement-proposed": "#acc6e9",
  "agreement-signed":   "#8dd89f",
  "agreement-rejected": "#e86d7a",
  "agreement-closed":   "#94a3b8",
  "service-call":       "#acc6e9",
  "dispute-opened":     "#f59e0b",
  "verdict":            "#e86d7a",
  "escrow-released":    "#8dd89f",
  "sanction":           "#e86d7a",
};

const KIND_BADGE: Record<LedgerKind, string> = {
  "node-founded":       "JOINED",
  "agreement-proposed": "PROPOSE",
  "agreement-signed":   "RATIFIED",
  "agreement-rejected": "REJECTED",
  "agreement-closed":   "CLOSED",
  "service-call":       "CALL",
  "dispute-opened":     "DISPUTE",
  "verdict":            "VERDICT",
  "escrow-released":    "CLAIM",
  "sanction":           "SANCTION",
};

const JOB_DOT = ["#acc6e9","#8dd89f","#f59e0b","#8dd89f","#e86d7a","#94a3b8"] as const;

type LedgerTab = "all" | "agreements" | "calls" | "disputes";

// ── Node row ─────────────────────────────────────────────────────────────────
function NodeRow({ node, selected, onClick }: { node: AgentNode; selected: boolean; onClick: () => void }) {
  const { world, statusOf } = useArcWorld();
  const st = statusOf(node.id);
  const ags = agreementsOf(world, node.id).filter(a => a.status==="active").length;
  const dot = st==="sanctioned" ? "#e86d7a" : st==="contested" ? "#f59e0b" : "#8dd89f";
  return (
    <button
      onClick={onClick}
      style={{
        display:"flex",alignItems:"center",gap:10,padding:"8px 12px",width:"100%",
        background: selected ? "rgba(172,198,233,0.12)" : "transparent",
        border:"none",borderLeft:`2px solid ${selected?"#acc6e9":"transparent"}`,
        cursor:"pointer",textAlign:"left",transition:"background 0.15s",
      }}
    >
      <div style={{
        width:28,height:28,borderRadius:"50%",flexShrink:0,
        background:`linear-gradient(135deg,#1a3a5a,#0d2a4a)`,
        border:`2px solid ${dot}`,display:"flex",alignItems:"center",justifyContent:"center",
        fontSize:10,fontWeight:700,color:dot,
      }}>
        {node.name.slice(0,1).toUpperCase()}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",letterSpacing:0.3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          {node.name}
        </div>
        <div style={{fontSize:10,color:"#64748b",marginTop:1}}>
          {node.archetype.split(" ")[0]} · {ags} active
        </div>
      </div>
      <div style={{textAlign:"right",flexShrink:0}}>
        <div style={{fontSize:11,fontWeight:700,color:"#acc6e9"}}>{node.reputation}</div>
        <div style={{fontSize:9,color:"#64748b",letterSpacing:0.5}}>REP</div>
      </div>
    </button>
  );
}

// ── ACP job badge row ─────────────────────────────────────────────────────────
function AcpJobRow({ job, onSelect }: { job: AcpJob; onSelect: () => void }) {
  const dot = JOB_DOT[job.status] ?? "#94a3b8";
  const label = JOB_STATUS[job.status] ?? "Unknown";
  return (
    <button
      onClick={onSelect}
      style={{
        display:"flex",alignItems:"center",gap:10,padding:"7px 12px",width:"100%",
        background:"transparent",border:"none",borderLeft:`2px solid ${dot}`,
        cursor:"pointer",textAlign:"left",transition:"background 0.15s",
      }}
      onMouseEnter={e => (e.currentTarget.style.background="rgba(172,198,233,0.07)")}
      onMouseLeave={e => (e.currentTarget.style.background="transparent")}
    >
      <div style={{width:8,height:8,borderRadius:"50%",background:dot,flexShrink:0}} />
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:11,color:"#e2e8f0",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          Job #{job.id.toString()} · {shortAddr(job.provider)}
        </div>
        <div style={{fontSize:10,color:"#64748b",marginTop:1}}>
          {formatUsdc(job.budget)} USDC · {job.description.slice(0,40)}{job.description.length>40?"…":""}
        </div>
      </div>
      <div style={{fontSize:9,fontWeight:700,color:dot,letterSpacing:0.8,flexShrink:0}}>
        {label.toUpperCase()}
      </div>
    </button>
  );
}

// ── Left panel ────────────────────────────────────────────────────────────────
export function SovereignDirectory({ onSelectJob }: { onSelectJob: (job: AcpJob) => void }) {
  const { world, acpJobs, selectedId, setSelected, setFocusId } = useArcWorld();
  const [tab, setTab] = useState<"nodes"|"jobs">("nodes");
  const escrow = lockedEscrow(world);

  return (
    <div style={{
      display:"flex",flexDirection:"column",height:"100%",
      background:"rgba(13,27,47,0.92)",borderRight:"1px solid #1a3a5a",
    }}>
      {/* Header */}
      <div style={{ padding:"12px 14px 10px", borderBottom:"1px solid #1a3a5a" }}>
        <div style={{ fontSize:9,letterSpacing:2,color:"#64748b",fontWeight:700,marginBottom:6 }}>
          NEXUS A2A
        </div>
        <div style={{ display:"flex", gap:6 }}>
          {(["nodes","jobs"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex:1,padding:"4px 0",fontSize:10,fontWeight:600,letterSpacing:0.8,
              background: tab===t ? "rgba(172,198,233,0.15)" : "transparent",
              border: `1px solid ${tab===t?"#acc6e9":"#1a3a5a"}`,
              borderRadius:4,color: tab===t ? "#acc6e9" : "#64748b",cursor:"pointer",
            }}>
              {t==="nodes" ? `AGENTS (${world.nodes.length})` : `JOBS (${acpJobs.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div style={{ flex:1, overflowY:"auto" }}>
        {tab==="nodes" ? (
          world.nodes.length === 0
            ? <div style={{ padding:16,fontSize:11,color:"#64748b",textAlign:"center" }}>No agents</div>
            : world.nodes.map(n => (
                <NodeRow key={n.id} node={n} selected={selectedId===n.id}
                  onClick={() => { setSelected(n.id); setFocusId(n.id); }} />
              ))
        ) : (
          acpJobs.length === 0
            ? <div style={{ padding:16,fontSize:11,color:"#64748b",textAlign:"center" }}>No on-chain jobs</div>
            : acpJobs.map(j => (
                <AcpJobRow key={j.id.toString()} job={j} onSelect={() => onSelectJob(j)} />
              ))
        )}
      </div>

      {/* Escrow HUD */}
      <div style={{ padding:"10px 14px", borderTop:"1px solid #1a3a5a" }}>
        <div style={{ fontSize:9,color:"#64748b",letterSpacing:1.5,marginBottom:3 }}>ARC ESCROW</div>
        <div style={{ fontSize:14,fontWeight:700,color:"#8dd89f" }}>
          {escrow.toFixed(2)} <span style={{ fontSize:10,fontWeight:400,color:"#64748b" }}>USDC locked</span>
        </div>
      </div>
    </div>
  );
}

// ── Ledger (bottom) ───────────────────────────────────────────────────────────
export function Ledger() {
  const { world } = useArcWorld();
  const [tab, setTab] = useState<LedgerTab>("all");
  const tabs: { id: LedgerTab; label: string }[] = [
    { id:"all",        label:"All" },
    { id:"agreements", label:"Agreements" },
    { id:"calls",      label:"Calls" },
    { id:"disputes",   label:"Disputes" },
  ];
  const filtered = world.ledger.filter(e => {
    if (tab==="agreements") return ["agreement-proposed","agreement-signed","agreement-rejected","agreement-closed"].includes(e.kind);
    if (tab==="calls")      return e.kind==="service-call"||e.kind==="escrow-released";
    if (tab==="disputes")   return ["dispute-opened","verdict","sanction"].includes(e.kind);
    return true;
  });
  const timeAgo = (ts: number) => {
    const s = (Date.now()-ts)/1000;
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s/60)}m ago`;
    return `${Math.round(s/3600)}h ago`;
  };

  return (
    <div style={{
      display:"flex",flexDirection:"column",height:"100%",
      background:"rgba(13,27,47,0.92)",borderTop:"1px solid #1a3a5a",
    }}>
      <div style={{ display:"flex",alignItems:"center",gap:0,padding:"6px 14px",borderBottom:"1px solid #1a3a5a" }}>
        <div style={{ fontSize:9,letterSpacing:2,color:"#64748b",fontWeight:700,marginRight:12 }}>LEDGER</div>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:"3px 10px",fontSize:10,fontWeight:600,
            background: tab===t.id ? "rgba(172,198,233,0.14)" : "transparent",
            border: tab===t.id ? "1px solid #acc6e9" : "1px solid transparent",
            borderRadius:3,color: tab===t.id ? "#acc6e9" : "#64748b",cursor:"pointer",marginRight:4,
          }}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:0 }}>
        {filtered.length===0
          ? <div style={{ padding:12,fontSize:11,color:"#64748b",textAlign:"center" }}>No events</div>
          : filtered.map(e => (
            <div key={e.id} style={{
              display:"flex",alignItems:"flex-start",gap:8,padding:"6px 14px",
              borderBottom:"1px solid rgba(26,58,90,0.4)",
            }}>
              <div style={{ display:"flex",alignItems:"center",gap:5,flexShrink:0,marginTop:2 }}>
                <div style={{ width:6,height:6,borderRadius:"50%",background:KIND_DOT[e.kind] }} />
                <div style={{ fontSize:9,fontWeight:700,color:KIND_DOT[e.kind],letterSpacing:0.8,minWidth:52 }}>
                  {KIND_BADGE[e.kind]}
                </div>
              </div>
              <div style={{ flex:1,fontSize:11,color:"#94a3b8",lineHeight:1.45 }}>{e.text}</div>
              <div style={{ fontSize:9,color:"#475569",flexShrink:0 }}>{timeAgo(e.ts)}</div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── Right detail panel: selected agent or ACP job ─────────────────────────────
function AgreementRow({ ag }: { ag: Agreement }) {
  const { world } = useArcWorld();
  const peerName = (id: string) => world.nodes.find(n => n.id === id)?.name ?? shortAddr(id);
  const statusColor = ag.status==="active" ? "#8dd89f" : ag.status==="proposed" ? "#acc6e9" : "#64748b";
  return (
    <div style={{
      padding:"8px 0",borderBottom:"1px solid rgba(26,58,90,0.5)",
    }}>
      <div style={{ display:"flex",justifyContent:"space-between",marginBottom:2 }}>
        <span style={{ fontSize:10,fontWeight:700,color:"#acc6e9",letterSpacing:0.8 }}>
          #{Math.abs(ag.id)} · {KIND_LABEL[ag.kind]}
        </span>
        <span style={{ fontSize:9,fontWeight:700,color:statusColor,letterSpacing:0.8 }}>
          {ag.status.toUpperCase()}
        </span>
      </div>
      <div style={{ fontSize:10,color:"#94a3b8" }}>
        {peerName(ag.partyA)} → {peerName(ag.partyB)}
      </div>
      <div style={{ fontSize:10,color:"#64748b",marginTop:2 }}>
        Bond {ag.bondA}/{ag.bondB} USDC · Budget {ag.callBudget.toFixed(2)} USDC
      </div>
    </div>
  );
}

export function DetailPanel({ acpJob, onClose }: { acpJob: AcpJob | null; onClose: () => void }) {
  const { world, selectedId, acpAgreements } = useArcWorld();
  const node = world.nodes.find(n => n.id === selectedId);
  const nodeAgs = node ? agreementsOf(world, node.id) : [];

  const content = acpJob ? (
    <AcpJobDetail job={acpJob} />
  ) : node ? (
    <NodeDetail node={node} agreements={nodeAgs} />
  ) : null;

  if (!content) return null;

  return (
    <div style={{
      position:"absolute",right:0,top:0,bottom:0,width:320,
      background:"rgba(13,27,47,0.96)",borderLeft:"1px solid #1a3a5a",
      display:"flex",flexDirection:"column",zIndex:20,
    }}>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderBottom:"1px solid #1a3a5a" }}>
        <div style={{ fontSize:10,letterSpacing:2,color:"#64748b",fontWeight:700 }}>
          {acpJob ? "ACP JOB" : "AGENT DOSSIER"}
        </div>
        <button onClick={onClose} style={{
          background:"transparent",border:"none",color:"#64748b",cursor:"pointer",fontSize:16,lineHeight:1,
        }}>✕</button>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:"12px 16px" }}>
        {content}
      </div>
    </div>
  );
}

function NodeDetail({ node, agreements }: { node: AgentNode; agreements: Agreement[] }) {
  const { world, statusOf } = useArcWorld();
  const st = statusOf(node.id);
  const dot = st==="sanctioned" ? "#e86d7a" : st==="contested" ? "#f59e0b" : "#8dd89f";
  return (
    <>
      <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:16 }}>
        <div style={{
          width:44,height:44,borderRadius:"50%",
          background:"linear-gradient(135deg,#1a3a5a,#0d2a4a)",
          border:`2px solid ${dot}`,display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:18,fontWeight:700,color:dot,
        }}>{node.name.slice(0,1)}</div>
        <div>
          <div style={{ fontSize:14,fontWeight:700,color:"#e2e8f0" }}>{node.name}</div>
          <div style={{ fontSize:10,color:dot,fontWeight:600,letterSpacing:0.8 }}>{st.toUpperCase()}</div>
        </div>
      </div>

      <div style={{ fontSize:10,color:"#64748b",marginBottom:12,lineHeight:1.5 }}>{node.charter}</div>

      {/* Stats grid */}
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16 }}>
        {[
          { label:"REPUTATION", value:node.reputation, color:"#f59e0b" },
          { label:"BOND",       value:`${node.collateral}`,   color:"#acc6e9", suffix:"USDC" },
          { label:"TREASURY",   value:`${node.treasury}`,    color:"#8dd89f", suffix:"USDC" },
        ].map(s => (
          <div key={s.label} style={{
            background:"rgba(26,58,90,0.4)",borderRadius:6,padding:"8px 10px",textAlign:"center",
            border:"1px solid rgba(26,58,90,0.8)",
          }}>
            <div style={{ fontSize:13,fontWeight:700,color:s.color }}>{s.value}</div>
            <div style={{ fontSize:8,color:"#64748b",letterSpacing:0.8,marginTop:2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Reputation bar */}
      <div style={{ marginBottom:16 }}>
        <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
          <span style={{ fontSize:10,color:"#64748b",letterSpacing:0.8 }}>REPUTATION</span>
          <span style={{ fontSize:10,fontWeight:700,color:"#f59e0b" }}>{node.reputation}/100</span>
        </div>
        <div style={{ height:4,background:"rgba(26,58,90,0.6)",borderRadius:2 }}>
          <div style={{ height:"100%",width:`${node.reputation}%`,background:"linear-gradient(90deg,#f59e0b,#acc6e9)",borderRadius:2,transition:"width 0.5s" }} />
        </div>
      </div>

      {/* Agreements */}
      {agreements.length > 0 && (
        <>
          <div style={{ fontSize:9,letterSpacing:1.5,color:"#64748b",fontWeight:700,marginBottom:8 }}>
            AGREEMENTS ({agreements.length})
          </div>
          {agreements.map(a => <AgreementRow key={a.id} ag={a} />)}
        </>
      )}
    </>
  );
}

const ACP_STATUS_COLORS = ["#acc6e9","#8dd89f","#f59e0b","#8dd89f","#e86d7a","#64748b"];

function AcpJobDetail({ job }: { job: AcpJob }) {
  const statusColor = ACP_STATUS_COLORS[job.status] ?? "#94a3b8";
  const statusLabel = JOB_STATUS[job.status] ?? "Unknown";
  const exp = new Date(Number(job.expiredAt) * 1000).toLocaleString();

  return (
    <>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16 }}>
        <div>
          <div style={{ fontSize:14,fontWeight:700,color:"#e2e8f0" }}>Job #{job.id.toString()}</div>
          <div style={{ fontSize:10,color:statusColor,fontWeight:600,letterSpacing:0.8 }}>{statusLabel.toUpperCase()}</div>
        </div>
        <div style={{
          background:`${statusColor}22`,border:`1px solid ${statusColor}`,
          borderRadius:20,padding:"3px 10px",fontSize:10,fontWeight:700,color:statusColor,
        }}>{statusLabel}</div>
      </div>

      <div style={{ fontSize:11,color:"#94a3b8",lineHeight:1.5,marginBottom:16 }}>{job.description}</div>

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16 }}>
        {[
          { label:"BUDGET",  value:`${formatUsdc(job.budget)} USDC`, color:"#8dd89f" },
          { label:"EXPIRES", value:exp,                               color:"#acc6e9" },
        ].map(s => (
          <div key={s.label} style={{
            background:"rgba(26,58,90,0.4)",borderRadius:6,padding:"8px 10px",
            border:"1px solid rgba(26,58,90,0.8)",
          }}>
            <div style={{ fontSize:11,fontWeight:700,color:s.color,wordBreak:"break-all" }}>{s.value}</div>
            <div style={{ fontSize:8,color:"#64748b",letterSpacing:0.8,marginTop:2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {[
        { label:"CLIENT",    value:job.client },
        { label:"PROVIDER",  value:job.provider },
        { label:"EVALUATOR", value:job.evaluator },
      ].map(r => (
        <div key={r.label} style={{ marginBottom:8 }}>
          <div style={{ fontSize:9,color:"#64748b",letterSpacing:1.5,marginBottom:2 }}>{r.label}</div>
          <div style={{
            fontFamily:"monospace",fontSize:11,color:"#acc6e9",
            background:"rgba(26,58,90,0.4)",borderRadius:4,padding:"5px 8px",
            border:"1px solid rgba(26,58,90,0.6)",wordBreak:"break-all",
          }}>{r.value}</div>
        </div>
      ))}
    </>
  );
}
