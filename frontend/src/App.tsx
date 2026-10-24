import { useState, useEffect, useRef, useMemo } from "react";
import { ConnectKitButton } from "connectkit";
import {
  ArcWorldProvider, useArcWorld, lockedEscrow, agreementsOf, type AcpJob,
} from "./context/ArcWorldContext";
import type { AgentNode, Agreement } from "./lib/engine";
import { BIOME_BY_ARCHETYPE, KIND_COLOR, STATUS_LABEL, type VisualStatus } from "./lib/world";

// ─── Archetype biome ─────────────────────────────────────────────────────────
function biome(arch: string) {
  return BIOME_BY_ARCHETYPE[arch as keyof typeof BIOME_BY_ARCHETYPE]
    ?? { base: "#0d2a4a", ridge: "#1a5080", accent: "#acc6e9" };
}

// ─── Star field ──────────────────────────────────────────────────────────────
const STARS = Array.from({ length: 120 }, (_, i) => ({
  x: ((i * 137.508) % 100),
  y: ((i * 97.31)   % 100),
  s: 0.8 + (i % 4) * 0.4,
  o: 0.15 + (i % 6) * 0.1,
}));

// ─── Island positions (percent of canvas) ────────────────────────────────────
// Mimics Rialo: two on top, escrow hub centre, two bottom-left, one bottom-right
const SLOT_POS: [number, number][] = [
  [36, 20],  // top-left  (PriceOracleBot)
  [62, 20],  // top-right (TaskRunner)
  [24, 52],  // mid-left  (EchoWorker)
  [64, 52],  // mid-right (BitPriceBot)
  [50, 72],  // bottom    (TranslateBot)
];
const HUB_POS: [number, number] = [50, 38];

// ─── Voxel island (CSS isometric) ────────────────────────────────────────────
// Rialo-style: stacked flat tiles forming a raised hex island, small citadel tower
function VoxelIsland({ node, px, py, selected, hovered, onHover, onSelect, status }: {
  node: AgentNode;
  px: number; py: number;
  selected: boolean; hovered: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  status: VisualStatus;
}) {
  const b = biome(node.archetype);
  const active = selected || hovered;
  const statusColor = status === "sanctioned" ? "#e86d7a" : status === "contested" ? "#f59e0b" : b.accent;
  const label = STATUS_LABEL[status];
  // 3 voxel tiles + citadel + beacon
  // Using CSS 3D isometric projection: rotateX(60deg) rotateZ(45deg)
  return (
    <div
      style={{
        position: "absolute",
        left: `${px}%`, top: `${py}%`,
        transform: "translate(-50%, -50%)",
        cursor: "pointer",
        zIndex: selected ? 10 : 2,
      }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(node.id)}
    >
      {/* Glow under island */}
      {active && (
        <div style={{
          position: "absolute", left: "50%", top: "50%",
          transform: "translate(-50%, -50%)",
          width: 140, height: 60,
          background: `radial-gradient(ellipse, ${b.accent}40 0%, transparent 70%)`,
          pointerEvents: "none",
          zIndex: 0,
        }} />
      )}

      {/* Isometric island using SVG */}
      <svg width="140" height="110" viewBox="-70 -55 140 110" style={{ overflow: "visible" }}>
        {/* Shadow */}
        <ellipse cx="0" cy="28" rx="44" ry="16" fill="#000000" opacity="0.35" />

        {/* Bottom voxel layer (widest) */}
        <IsoPlatform y={22} w={54} h={28} depth={10} base={b.base} ridge={b.ridge} accent={b.accent} opacity={0.9} />
        {/* Middle layer */}
        <IsoPlatform y={10} w={42} h={22} depth={10} base={b.base} ridge={b.ridge} accent={b.accent} opacity={0.95} />
        {/* Top layer */}
        <IsoPlatform y={0} w={30} h={16} depth={10} base={b.ridge} ridge={b.accent} accent={b.accent} opacity={1} />

        {/* Citadel tower */}
        <IsoTower color={b.accent} />

        {/* Beacon light */}
        <circle cx="0" cy="-38" r={active ? 4 : 3} fill={b.accent} opacity={active ? 1 : 0.7}>
          {active && <animate attributeName="r" values="3;5;3" dur="1.5s" repeatCount="indefinite" />}
        </circle>
        <line x1="0" y1="-34" x2="0" y2="-14" stroke={b.accent} strokeWidth="0.8" opacity="0.7" />

        {/* Sanctioned cage */}
        {status === "sanctioned" && (
          <>
            <ellipse cx="0" cy="0" rx="52" ry="26" fill="none" stroke="#e86d7a" strokeWidth="1.2" strokeDasharray="5 3" opacity="0.8">
              <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="4s" repeatCount="indefinite" />
            </ellipse>
          </>
        )}
      </svg>

      {/* Label box — Rialo style dark card */}
      <div style={{
        position: "absolute", left: "50%", bottom: "100%",
        transform: "translateX(-50%) translateY(12px)",
        background: "rgba(0,0,0,0.82)",
        border: `1px solid ${statusColor}88`,
        borderRadius: 3, padding: "4px 10px", whiteSpace: "nowrap",
        pointerEvents: "none", zIndex: 20,
        boxShadow: active ? `0 0 12px ${b.accent}44` : "none",
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: statusColor, letterSpacing: 1.2, textAlign: "center" }}>
          {node.name.toUpperCase()}
        </div>
        <div style={{ fontSize: 8, color: "#6b7280", letterSpacing: 0.8, textAlign: "center", marginTop: 1 }}>
          {label} · REP {node.reputation} · 0 TREATIES
        </div>
      </div>
    </div>
  );
}

// Isometric platform tile — top + left + right faces
function IsoPlatform({ y, w, h, depth, base, ridge, accent, opacity }: {
  y: number; w: number; h: number; depth: number;
  base: string; ridge: string; accent: string; opacity: number;
}) {
  const hw = w / 2;
  const hh = h / 2;
  // Top face (rhombus)
  const top = `0,${y - hh}  ${hw},${y}  0,${y + hh}  -${hw},${y}`;
  // Left face
  const left = `-${hw},${y}  0,${y + hh}  0,${y + hh + depth}  -${hw},${y + depth}`;
  // Right face
  const right = `${hw},${y}  0,${y + hh}  0,${y + hh + depth}  ${hw},${y + depth}`;

  return (
    <g opacity={opacity}>
      <polygon points={left}  fill={base}  stroke={accent} strokeWidth="0.3" opacity="0.9" />
      <polygon points={right} fill={ridge} stroke={accent} strokeWidth="0.3" opacity="0.9" />
      <polygon points={top}   fill={ridge} stroke={accent} strokeWidth="0.4" opacity="1" />
    </g>
  );
}

// Isometric tower (citadel)
function IsoTower({ color }: { color: string }) {
  return (
    <g>
      {/* Tower body */}
      <polygon points="-6,-14  6,-14  6,-2  -6,-2" fill={`${color}33`} stroke={color} strokeWidth="0.6" />
      {/* Left face */}
      <polygon points="-6,-14  -6,-2  -10,-5  -10,-17" fill={`${color}22`} stroke={color} strokeWidth="0.4" />
      {/* Right face */}
      <polygon points="6,-14  6,-2  10,-5  10,-17" fill={`${color}44`} stroke={color} strokeWidth="0.4" />
      {/* Battlements */}
      {[-4, 0, 4].map((x, i) => (
        <rect key={i} x={x - 1.5} y={-18} width={3} height={4} fill={color} opacity="0.9" />
      ))}
      {/* Top cap */}
      <polygon points="0,-22  -6,-16  6,-16" fill={color} opacity="0.85" />
    </g>
  );
}

// ─── Arc Escrow Hub (Rialo's golden orbital) ──────────────────────────────────
function EscrowHubCSS({ escrow }: { escrow: number }) {
  const ringRef = useRef<HTMLDivElement>(null);
  const rot = useRef(0);
  useEffect(() => {
    let raf: number;
    const tick = () => {
      rot.current = (rot.current + 0.3) % 360;
      if (ringRef.current) ringRef.current.style.transform = `rotate(${rot.current}deg)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div style={{
      position: "absolute",
      left: `${HUB_POS[0]}%`, top: `${HUB_POS[1]}%`,
      transform: "translate(-50%,-50%)",
      zIndex: 5,
    }}>
      {/* Outer glow ring */}
      <div style={{
        position: "absolute", left: "50%", top: "50%",
        transform: "translate(-50%,-50%)",
        width: 110, height: 110,
        borderRadius: "50%",
        background: "radial-gradient(ellipse, #acc6e920 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      {/* SVG escrow hub */}
      <svg width="160" height="100" viewBox="-80 -50 160 100" style={{ overflow: "visible" }}>
        {/* Orbital rings — rotated */}
        <g ref={ringRef as unknown as React.RefObject<SVGGElement>}>
          <ellipse cx="0" cy="0" rx="52" ry="22" fill="none" stroke="#acc6e9" strokeWidth="1" opacity="0.6" />
        </g>
        <ellipse cx="0" cy="0" rx="34" ry="14" fill="none" stroke="#8dd89f" strokeWidth="0.7" opacity="0.4" />

        {/* Platform hex */}
        <polygon points="0,-20 36,-10 36,10 0,20 -36,10 -36,-10"
          fill="#0d1b2f" stroke="#acc6e9" strokeWidth="0.8" opacity="0.9" />
        <polygon points="0,-20 36,-10 0,0 -36,-10"
          fill="#122d45" stroke="#acc6e9" strokeWidth="0.5" opacity="0.8" />

        {/* Central floating orb */}
        <circle cx="0" cy="-10" r="10" fill="#acc6e922" stroke="#acc6e9" strokeWidth="1.2">
          <animate attributeName="r" values="9;11;9" dur="2.5s" repeatCount="indefinite" />
        </circle>
        <circle cx="0" cy="-10" r="5" fill="#acc6e9" opacity="0.8">
          <animate attributeName="opacity" values="0.5;1;0.5" dur="2s" repeatCount="indefinite" />
        </circle>

        {/* Labels */}
        <text x="0" y="30" textAnchor="middle" fontSize="8" fontWeight="700"
          fill="#acc6e9" fontFamily='"DM Sans",monospace' letterSpacing="1.5">
          ARC ESCROW
        </text>
        <text x="0" y="40" textAnchor="middle" fontSize="7" fill="#6b7280"
          fontFamily='"DM Sans",monospace' letterSpacing="0.8">
          {escrow.toFixed(2)} USDC LOCKED
        </text>
      </svg>
    </div>
  );
}

// ─── SVG connection lines between nodes ─────────────────────────────────────
function ConnectionLines({ nodes, agreements, posMap, hoveredId, selectedId, busySet }: {
  nodes: AgentNode[];
  agreements: Agreement[];
  posMap: Map<string, [number, number]>;
  hoveredId: string | null;
  selectedId: string | null;
  busySet: Set<number>;
}) {
  const focus = hoveredId ?? selectedId;
  return (
    <svg
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <defs>
        {agreements.map(ag => {
          const color = KIND_COLOR[ag.kind] ?? "#acc6e9";
          const id = `lg-${ag.id}`;
          const pa = posMap.get(ag.partyA);
          const pb = posMap.get(ag.partyB);
          if (!pa || !pb) return null;
          return (
            <linearGradient key={id} id={id} gradientUnits="userSpaceOnUse"
              x1={pa[0]} y1={pa[1]} x2={pb[0]} y2={pb[1]}>
              <stop offset="0%"   stopColor={color} stopOpacity="0.1" />
              <stop offset="50%"  stopColor={color} stopOpacity="1" />
              <stop offset="100%" stopColor={color} stopOpacity="0.1" />
            </linearGradient>
          );
        })}
      </defs>

      {agreements.map(ag => {
        const pa = posMap.get(ag.partyA);
        const pb = posMap.get(ag.partyB);
        if (!pa || !pb) return null;
        const color = KIND_COLOR[ag.kind] ?? "#acc6e9";
        const opacity = !focus ? 0.5 : (focus === ag.partyA || focus === ag.partyB) ? 1 : 0.1;
        const busy = busySet.has(ag.id);
        const mx = (pa[0] + pb[0]) / 2;
        const my = (pa[1] + pb[1]) / 2 - 8;
        const d = `M ${pa[0]} ${pa[1]} Q ${mx} ${my} ${pb[0]} ${pb[1]}`;

        return (
          <g key={ag.id} opacity={opacity}>
            <path d={d} fill="none" stroke={`url(#lg-${ag.id})`} strokeWidth="0.5"
              strokeDasharray={ag.kind === "DATA_SHARING" ? "2 1.5" : ag.kind === "NON_AGGRESSION" ? "0.5 2" : "none"} />
            {busy && (
              <circle r="1.2" fill={color} opacity="0.9">
                <animateMotion dur="2s" repeatCount="indefinite" path={d} />
              </circle>
            )}
          </g>
        );
      })}

      {/* Hub lines — each island connects to escrow hub */}
      {nodes.slice(0, 5).map((n, i) => {
        const pos = posMap.get(n.id);
        if (!pos) return null;
        return (
          <line key={n.id}
            x1={pos[0]} y1={pos[1]}
            x2={HUB_POS[0]} y2={HUB_POS[1]}
            stroke="#acc6e9" strokeWidth="0.2" opacity="0.15"
            strokeDasharray="1 2"
          />
        );
      })}
    </svg>
  );
}

// ─── Legend ──────────────────────────────────────────────────────────────────
function Legend() {
  return (
    <div style={{
      position: "absolute", bottom: 12, right: 16,
      display: "flex", gap: 16, alignItems: "center",
      background: "rgba(0,0,0,0.5)", borderRadius: 4,
      padding: "4px 12px", border: "1px solid #1a3a5a",
    }}>
      {[
        { color: "#acc6e9", label: "Service",         dash: false },
        { color: "#8dd89f", label: "Data",            dash: true  },
        { color: "#cbdbf2", label: "Non-aggression",  dash: true  },
        { color: "#f59e0b", label: "Under tribunal",  dash: false },
        { color: "#e86d7a", label: "Sanctioned",      dash: false },
      ].map(l => (
        <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="18" height="6">
            <line x1="0" y1="3" x2="18" y2="3"
              stroke={l.color} strokeWidth="1.5"
              strokeDasharray={l.dash ? "4 3" : "none"} />
          </svg>
          <span style={{ fontSize: 8, color: "#6b7280", letterSpacing: 0.5 }}>{l.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── World board ─────────────────────────────────────────────────────────────
function WorldBoard() {
  const {
    world, hoveredId, selectedId, selectedAgreement, busyContracts,
    statusOf, acpAgreements, setHovered, setSelected, setFocusId,
  } = useArcWorld();

  const escrow = lockedEscrow(world);
  const nodes  = world.nodes.slice(0, 5);

  const posMap = useMemo(() => {
    const m = new Map<string, [number, number]>();
    nodes.forEach((n, i) => m.set(n.id, SLOT_POS[i] ?? [50, 50]));
    return m;
  }, [nodes]);

  const allAgreements = useMemo(() => [
    ...world.agreements.filter(a => a.status === "proposed" || a.status === "active"),
    ...acpAgreements,
  ], [world.agreements, acpAgreements]);

  return (
    <div
      style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "#050c17" }}
      onClick={() => { setSelected(null); }}
    >
      {/* Star field */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        {STARS.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.s * 0.15} fill="white" opacity={s.o} />
        ))}
        {/* Subtle grid */}
        {[20,40,60,80].map(v => (
          <line key={`h${v}`} x1="0" y1={v} x2="100" y2={v} stroke="#1a3a5a" strokeWidth="0.15" opacity="0.4" />
        ))}
        {[20,40,60,80].map(v => (
          <line key={`v${v}`} x1={v} y1="0" x2={v} y2="100" stroke="#1a3a5a" strokeWidth="0.15" opacity="0.4" />
        ))}
      </svg>

      {/* Connection lines layer */}
      <ConnectionLines
        nodes={nodes}
        agreements={allAgreements}
        posMap={posMap}
        hoveredId={hoveredId}
        selectedId={selectedId}
        busySet={busyContracts}
      />

      {/* Escrow hub */}
      <EscrowHubCSS escrow={escrow} />

      {/* Agent islands */}
      {nodes.map((node, i) => {
        const pos = SLOT_POS[i] ?? [50, 50];
        return (
          <VoxelIsland
            key={node.id}
            node={node}
            px={pos[0]} py={pos[1]}
            selected={selectedId === node.id}
            hovered={hoveredId === node.id}
            onHover={setHovered}
            onSelect={(id) => { setSelected(id); setFocusId(id); }}
            status={statusOf(node.id)}
          />
        );
      })}

      <Legend />
    </div>
  );
}

// ─── Left panel ──────────────────────────────────────────────────────────────
function LeftPanel({ onSelectJob }: { onSelectJob: (j: AcpJob) => void }) {
  const { world, acpJobs, selectedId, setSelected, setFocusId, statusOf } = useArcWorld();
  const [tab, setTab] = useState<"nodes" | "jobs">("nodes");
  const escrow = lockedEscrow(world);
  const JOB_STATUS = ["Open","Funded","Submitted","Completed","Rejected","Expired"];
  const JOB_COLOR  = ["#acc6e9","#8dd89f","#f59e0b","#8dd89f","#e86d7a","#64748b"];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:"rgba(5,12,23,0.97)", borderRight:"1px solid #0f2035" }}>
      <div style={{ padding:"12px 14px 10px", borderBottom:"1px solid #0f2035" }}>
        <div style={{ fontSize:9, letterSpacing:2, color:"#4b6a8a", fontWeight:700, marginBottom:6 }}>SOVEREIGNS</div>
        <div style={{ display:"flex", gap:4 }}>
          {(["nodes","jobs"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex:1, padding:"4px 0", fontSize:10, fontWeight:700, letterSpacing:0.8,
              background: tab===t ? "rgba(172,198,233,0.12)" : "transparent",
              border:`1px solid ${tab===t ? "#acc6e9" : "#0f2035"}`,
              borderRadius:3, color:tab===t ? "#acc6e9" : "#4b6a8a", cursor:"pointer",
            }}>
              {t==="nodes" ? `AGENTS (${world.nodes.length})` : `JOBS (${acpJobs.length})`}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex:1, overflowY:"auto" }}>
        {tab==="nodes" ? world.nodes.map(n => {
          const b = biome(n.archetype);
          const st = statusOf(n.id);
          const dot = st==="sanctioned" ? "#e86d7a" : st==="contested" ? "#f59e0b" : b.accent;
          const ags = agreementsOf(world, n.id).filter(a => a.status==="active").length;
          return (
            <button key={n.id} onClick={() => { setSelected(n.id); setFocusId(n.id); }} style={{
              display:"flex", alignItems:"center", gap:10, padding:"8px 14px", width:"100%",
              background: selectedId===n.id ? "rgba(172,198,233,0.08)" : "transparent",
              border:"none", borderLeft:`2px solid ${selectedId===n.id ? "#acc6e9" : "transparent"}`,
              cursor:"pointer", textAlign:"left",
            }}>
              <div style={{
                width:30, height:30, borderRadius:4, flexShrink:0,
                background:`${b.base}`, border:`1.5px solid ${dot}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:11, fontWeight:700, color:dot,
              }}>{n.name[0]}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:600, color:"#c8d9ec", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{n.name}</div>
                <div style={{ fontSize:9, color:"#4b6a8a", marginTop:1 }}>{n.archetype.split(" ")[0]} · {ags} acti...</div>
              </div>
              <div style={{ textAlign:"right", flexShrink:0 }}>
                <div style={{ fontSize:12, fontWeight:700, color:"#c8d9ec" }}>{n.reputation}</div>
                <div style={{ fontSize:8, color:"#4b6a8a", letterSpacing:0.5 }}>REP</div>
              </div>
            </button>
          );
        }) : acpJobs.length===0
          ? <div style={{ padding:16, fontSize:11, color:"#4b6a8a", textAlign:"center" }}>No on-chain jobs</div>
          : acpJobs.map(j => {
            const dot = JOB_COLOR[j.status] ?? "#64748b";
            return (
              <button key={j.id.toString()} onClick={() => onSelectJob(j)} style={{
                display:"flex", alignItems:"center", gap:8, padding:"7px 14px", width:"100%",
                background:"transparent", border:"none", borderLeft:`2px solid ${dot}`,
                cursor:"pointer", textAlign:"left",
              }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background:dot, flexShrink:0 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:11, color:"#c8d9ec", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>Job #{j.id.toString()}</div>
                  <div style={{ fontSize:9, color:"#4b6a8a", marginTop:1 }}>{(Number(j.budget)/1e6).toFixed(2)} USDC</div>
                </div>
                <div style={{ fontSize:9, fontWeight:700, color:dot }}>{JOB_STATUS[j.status]?.toUpperCase()}</div>
              </button>
            );
          })
        }
      </div>

      <div style={{ padding:"10px 14px", borderTop:"1px solid #0f2035" }}>
        <div style={{ fontSize:9, color:"#4b6a8a", letterSpacing:1.5, marginBottom:3 }}>ARC ESCROW</div>
        <div style={{ fontSize:15, fontWeight:700, color:"#8dd89f" }}>
          {escrow.toFixed(2)} <span style={{ fontSize:10, color:"#4b6a8a" }}>USDC locked</span>
        </div>
      </div>
    </div>
  );
}

// ─── Bottom ledger ────────────────────────────────────────────────────────────
function BottomLedger() {
  const { world } = useArcWorld();
  const [tab, setTab] = useState<"all"|"agreements"|"calls"|"disputes">("all");
  const KIND_COLOR_MAP: Record<string, string> = {
    "node-founded":"#8dd89f","agreement-proposed":"#acc6e9","agreement-signed":"#8dd89f",
    "agreement-rejected":"#e86d7a","agreement-closed":"#4b6a8a","service-call":"#acc6e9",
    "dispute-opened":"#f59e0b","verdict":"#e86d7a","escrow-released":"#8dd89f","sanction":"#e86d7a",
  };
  const KIND_BADGE: Record<string, string> = {
    "node-founded":"JOINED","agreement-proposed":"PROPOSAL","agreement-signed":"RATIFIED",
    "agreement-rejected":"REJECTED","agreement-closed":"CLOSED","service-call":"CALL",
    "dispute-opened":"DISPUTE","verdict":"VERDICT","escrow-released":"CLAIM","sanction":"SANCTION",
  };
  const filtered = world.ledger.filter(e => {
    if (tab==="agreements") return ["agreement-proposed","agreement-signed","agreement-rejected","agreement-closed"].includes(e.kind);
    if (tab==="calls")      return e.kind==="service-call"||e.kind==="escrow-released";
    if (tab==="disputes")   return ["dispute-opened","verdict","sanction"].includes(e.kind);
    return true;
  });
  const timeAgo = (ts: number) => {
    const s = (Date.now()-ts)/1000;
    if (s<60) return `${Math.round(s)}s ago`;
    if (s<3600) return `${Math.round(s/60)}m ago`;
    return `${Math.round(s/3600)}h ago`;
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:"rgba(5,12,23,0.97)", borderTop:"1px solid #0f2035" }}>
      <div style={{ display:"flex", alignItems:"center", padding:"5px 14px", borderBottom:"1px solid #0f2035", flexShrink:0, gap:2 }}>
        <span style={{ fontSize:9, letterSpacing:2, color:"#4b6a8a", fontWeight:700, marginRight:10 }}>LEDGER</span>
        {(["all","agreements","calls","disputes"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding:"3px 10px", fontSize:10, fontWeight:700, letterSpacing:0.6,
            background: tab===t ? "rgba(172,198,233,0.12)" : "transparent",
            border: tab===t ? "1px solid #acc6e9" : "1px solid transparent",
            borderRadius:12, color:tab===t ? "#acc6e9" : "#4b6a8a", cursor:"pointer",
          }}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
        ))}
      </div>
      <div style={{ flex:1, overflowY:"auto" }}>
        {filtered.length===0
          ? <div style={{ padding:10, fontSize:10, color:"#4b6a8a", textAlign:"center" }}>No events</div>
          : filtered.map(e => {
            const c = KIND_COLOR_MAP[e.kind] ?? "#4b6a8a";
            return (
              <div key={e.id} style={{ display:"flex", alignItems:"flex-start", gap:8, padding:"5px 14px", borderBottom:"1px solid #0a1e30" }}>
                <div style={{ display:"flex", alignItems:"center", gap:5, flexShrink:0, marginTop:3 }}>
                  <div style={{ width:6, height:6, borderRadius:1, background:c }} />
                  <div style={{ fontSize:8, fontWeight:700, color:c, letterSpacing:0.8, minWidth:54, padding:"1px 4px", border:`1px solid ${c}44`, borderRadius:2 }}>
                    {KIND_BADGE[e.kind] ?? "EVENT"}
                  </div>
                </div>
                <div style={{ flex:1, fontSize:10, color:"#7a94b0", lineHeight:1.45 }}>{e.text}</div>
                <div style={{ fontSize:9, color:"#2d4a6a", flexShrink:0 }}>{timeAgo(e.ts)}</div>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

// ─── Right detail panel ───────────────────────────────────────────────────────
function RightPanel({ acpJob, onClose }: { acpJob: AcpJob | null; onClose: () => void }) {
  const { world, selectedId, statusOf } = useArcWorld();
  const node = world.nodes.find(n => n.id === selectedId);
  if (!acpJob && !node) return null;
  const b = node ? biome(node.archetype) : { base:"#0d2a4a", ridge:"#1a5080", accent:"#acc6e9" };

  return (
    <div style={{
      position:"absolute", right:0, top:0, bottom:0, width:290,
      background:"rgba(5,12,23,0.97)", borderLeft:"1px solid #0f2035",
      display:"flex", flexDirection:"column", zIndex:20,
    }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 14px", borderBottom:"1px solid #0f2035" }}>
        <span style={{ fontSize:9, letterSpacing:2, color:"#4b6a8a", fontWeight:700 }}>
          {acpJob ? "ACP JOB" : "AGENT DOSSIER"}
        </span>
        <button onClick={onClose} style={{ background:"transparent", border:"none", color:"#4b6a8a", cursor:"pointer", fontSize:14 }}>✕</button>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>
        {acpJob ? (
          <>
            <div style={{ fontSize:14, fontWeight:700, color:"#c8d9ec", marginBottom:4 }}>Job #{acpJob.id.toString()}</div>
            <div style={{ fontSize:10, color:"#7a94b0", lineHeight:1.5, marginBottom:14 }}>{acpJob.description}</div>
            {[
              { label:"BUDGET",    value:`${(Number(acpJob.budget)/1e6).toFixed(2)} USDC`, color:"#8dd89f" },
              { label:"CLIENT",    value:acpJob.client.slice(0,12)+"…",                    color:"#acc6e9" },
              { label:"PROVIDER",  value:acpJob.provider.slice(0,12)+"…",                  color:"#acc6e9" },
              { label:"EVALUATOR", value:acpJob.evaluator.slice(0,12)+"…",                 color:"#acc6e9" },
            ].map(r => (
              <div key={r.label} style={{ marginBottom:10 }}>
                <div style={{ fontSize:8, color:"#4b6a8a", letterSpacing:1.5, marginBottom:2 }}>{r.label}</div>
                <div style={{ fontSize:11, fontWeight:600, color:r.color, fontFamily:"monospace" }}>{r.value}</div>
              </div>
            ))}
          </>
        ) : node ? (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
              <div style={{
                width:42, height:42, borderRadius:6,
                background:b.base, border:`2px solid ${b.accent}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:18, fontWeight:700, color:b.accent,
              }}>{node.name[0]}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:"#c8d9ec" }}>{node.name}</div>
                <div style={{ fontSize:9, color:b.accent, fontWeight:700, letterSpacing:0.8 }}>{statusOf(node.id).toUpperCase()}</div>
              </div>
            </div>
            <div style={{ fontSize:9, color:"#4b6a8a", lineHeight:1.5, marginBottom:14 }}>{node.charter}</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:14 }}>
              {[
                { label:"REP",      value:node.reputation, color:"#f59e0b" },
                { label:"BOND",     value:node.collateral, color:"#acc6e9" },
                { label:"TREASURY", value:node.treasury,   color:"#8dd89f" },
              ].map(s => (
                <div key={s.label} style={{ background:"rgba(15,32,53,0.8)", borderRadius:4, padding:"7px 8px", textAlign:"center", border:"1px solid #0f2035" }}>
                  <div style={{ fontSize:13, fontWeight:700, color:s.color }}>{s.value}</div>
                  <div style={{ fontSize:7, color:"#4b6a8a", letterSpacing:0.8, marginTop:2 }}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{ marginBottom:6 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                <span style={{ fontSize:8, color:"#4b6a8a" }}>REPUTATION</span>
                <span style={{ fontSize:9, fontWeight:700, color:"#f59e0b" }}>{node.reputation}/100</span>
              </div>
              <div style={{ height:3, background:"rgba(15,32,53,0.8)", borderRadius:2 }}>
                <div style={{ height:"100%", width:`${node.reputation}%`, background:"linear-gradient(90deg,#f59e0b,#acc6e9)", borderRadius:2 }} />
              </div>
            </div>
            <div style={{ fontSize:9, color:"#4b6a8a", marginTop:8 }}>{node.archetype}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
function Inner() {
  const { autonomous, setAutonomous } = useArcWorld();
  const [acpJob, setAcpJob] = useState<AcpJob | null>(null);

  return (
    <div style={{
      width:"100vw", height:"100vh", overflow:"hidden",
      background:"#050c17", display:"flex", flexDirection:"column",
      fontFamily:'"DM Sans",system-ui,sans-serif',
    }}>
      {/* Navbar */}
      <div style={{
        height:46, flexShrink:0, display:"flex", alignItems:"center",
        justifyContent:"space-between", padding:"0 18px",
        background:"rgba(5,12,23,0.98)", borderBottom:"1px solid #0f2035", zIndex:30,
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{
            width:28, height:28, borderRadius:6, background:"linear-gradient(135deg,#acc6e9,#8dd89f)",
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:900, color:"#050c17",
          }}>N</div>
          <span style={{ fontSize:13, fontWeight:700, color:"#c8d9ec", letterSpacing:0.5 }}>NEXUS A2A</span>
          <span style={{ fontSize:8, fontWeight:700, letterSpacing:1.5, color:"#8dd89f", border:"1px solid #8dd89f44", borderRadius:2, padding:"2px 6px" }}>
            ARC MAINNET
          </span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer" }}>
            <div onClick={() => setAutonomous(!autonomous)} style={{
              width:34, height:18, borderRadius:9,
              background: autonomous ? "#acc6e9" : "#0f2035",
              position:"relative", transition:"background 0.2s", cursor:"pointer",
              border:"1px solid #1a3a5a",
            }}>
              <div style={{
                position:"absolute", top:2, left: autonomous ? 17 : 2,
                width:13, height:13, borderRadius:"50%",
                background: autonomous ? "#050c17" : "#4b6a8a",
                transition:"left 0.2s",
              }} />
            </div>
            <span style={{ fontSize:10, color: autonomous ? "#acc6e9" : "#4b6a8a" }}>Autonomous agents</span>
          </label>
          <ConnectKitButton />
        </div>
      </div>

      {/* Body */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
        {/* Left */}
        <div style={{ width:240, flexShrink:0, height:"100%", overflow:"hidden", display:"flex", flexDirection:"column" }}>
          <LeftPanel onSelectJob={j => setAcpJob(j)} />
        </div>

        {/* Canvas */}
        <div style={{ flex:1, position:"relative", overflow:"hidden" }}>
          <WorldBoard />
          <RightPanel acpJob={acpJob} onClose={() => { setAcpJob(null); }} />
        </div>
      </div>

      {/* Ledger */}
      <div style={{ height:155, flexShrink:0, overflow:"hidden" }}>
        <BottomLedger />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ArcWorldProvider>
      <Inner />
    </ArcWorldProvider>
  );
}
