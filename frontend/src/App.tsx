// Nexus A2A — ERC-8183 Agentic Commerce Platform
// Main layout: full-screen izometric 3D board (Rialo diplomacy style),
// left sovereign directory, bottom ledger, top navbar with wallet + HUD.

import { useState, useEffect } from "react";
import { ConnectKitButton } from "connectkit";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { useContractRead, useWatchContractEvent } from "wagmi";
import { ArcWorldProvider, useArcWorld, type AcpJob } from "./context/ArcWorldContext";
import { SovereignDirectory, Ledger, DetailPanel } from "./components/Panels";
import Board from "./components/board/Board";
import WalletCard from "./components/WalletCard";
import { ACP_ADDRESS, ARC_CHAIN_ID } from "./config";
import { ACP_ABI as AGENT_MARKET_ABI } from "./abis";
import { formatUsdc } from "./utils";

const PANEL_W  = 260;
const LEDGER_H = 180;

// ── Inner app (needs ArcWorldProvider) ───────────────────────────────────────
function Inner() {
  const {
    world, acpJobs, acpAgreements,
    hoveredId, selectedId, selectedAgreement, focusId, showLabels, autonomous, busyContracts,
    statusOf,
    setHovered, setSelected, setSelectedAgreement, setFocusId, setShowLabels, setAutonomous,
    setAcpJobs,
  } = useArcWorld();

  const [selectedJob, setSelectedJob] = useState<AcpJob | null>(null);
  const [panelOpen,   setPanelOpen]   = useState(false);

  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { address } = useAccount();
  const onWrongChain = chainId !== ARC_CHAIN_ID;

  // ── Load all jobs from chain ─────────────────────────────────────────────
  const { data: taskCountRaw } = useContractRead({
    address: ACP_ADDRESS as `0x${string}`,
    abi: AGENT_MARKET_ABI,
    functionName: "jobCount",
  });
  const taskCount = Number(taskCountRaw ?? 0n);

  // Fetch jobs individually (simple approach for demo)
  useEffect(() => {
    if (!taskCount || taskCount === 0) return;
    const load = async () => {
      const jobs: AcpJob[] = [];
      for (let i = 1; i <= Math.min(taskCount, 50); i++) {
        // We'll rely on event-based loading instead for now
      }
    };
    load();
  }, [taskCount]);

  // Watch JobCreated events and build job list from them
  useWatchContractEvent({
    address: ACP_ADDRESS as `0x${string}`,
    abi: AGENT_MARKET_ABI,
    eventName: "JobCreated",
    onLogs: (logs) => {
      const newJobs: AcpJob[] = logs.map((l: any) => ({
        id:          BigInt(l.args?.jobId ?? 0),
        client:      l.args?.client   ?? "",
        provider:    l.args?.provider ?? "",
        evaluator:   l.args?.evaluator ?? "",
        description: l.args?.description ?? "",
        budget:      0n,
        expiredAt:   BigInt(l.args?.expiredAt ?? 0),
        status:      0,
      }));
      if (newJobs.length > 0) setAcpJobs([...acpJobs, ...newJobs]);
    },
  });

  // ── Merge world agreements + ACP arcs for Board ─────────────────────────
  const allAgreements = [...world.agreements, ...acpAgreements];
  const mergedWorld   = { ...world, agreements: allAgreements };

  const openPanel = (job: AcpJob) => { setSelectedJob(job); setPanelOpen(true); setSelected(null); };
  const closePanel = () => { setSelectedJob(null); setPanelOpen(false); };

  // ── Top HUD right side ────────────────────────────────────────────────────
  const locked = world.agreements.reduce((s,a) => s + a.bondA + a.bondB + a.callBudget, 0);
  const acpJobCount = acpJobs.length;

  return (
    <div style={{ position:"fixed",inset:0,background:"#060f1a",color:"#e2e8f0",fontFamily:"'Space Grotesk','DM Sans',system-ui,sans-serif",overflow:"hidden" }}>

      {/* ── Navbar ──────────────────────────────────────────────────────── */}
      <div style={{
        position:"absolute",top:0,left:0,right:0,height:48,zIndex:30,
        background:"rgba(6,15,26,0.92)",borderBottom:"1px solid #1a3a5a",
        display:"flex",alignItems:"center",padding:"0 16px",gap:12,backdropFilter:"blur(8px)",
      }}>
        {/* Logo */}
        <div style={{ display:"flex",alignItems:"center",gap:8,marginRight:8 }}>
          <div style={{
            width:28,height:28,borderRadius:6,
            background:"linear-gradient(135deg,#acc6e9,#8dd89f)",
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:14,fontWeight:900,color:"#0d1b2f",
          }}>N</div>
          <div>
            <div style={{ fontSize:13,fontWeight:700,color:"#e2e8f0",letterSpacing:0.3 }}>Nexus A2A</div>
            <div style={{ fontSize:9,color:"#64748b",letterSpacing:1 }}>ERC-8183 · ARC MAINNET</div>
          </div>
        </div>

        {/* Chain badge */}
        <div style={{
          padding:"2px 8px",borderRadius:20,border:`1px solid ${onWrongChain?"#e86d7a":"#8dd89f"}`,
          background: onWrongChain ? "rgba(232,109,122,0.1)" : "rgba(141,216,159,0.1)",
          fontSize:9,fontWeight:700,letterSpacing:0.8,
          color: onWrongChain ? "#e86d7a" : "#8dd89f",cursor: onWrongChain ? "pointer" : "default",
        }} onClick={() => onWrongChain && switchChain?.({ chainId: ARC_CHAIN_ID })}>
          {onWrongChain ? "⚠ SWITCH TO ARC" : "● ARC MAINNET"}
        </div>

        <div style={{ flex:1 }} />

        {/* Stats */}
        <div style={{ display:"flex",gap:16,alignItems:"center" }}>
          {[
            { label:"AGENTS",    value: world.nodes.length },
            { label:"ACP JOBS",  value: acpJobCount },
            { label:"ESCROW",    value: `${locked.toFixed(1)} USDC` },
          ].map(s => (
            <div key={s.label} style={{ textAlign:"center" }}>
              <div style={{ fontSize:13,fontWeight:700,color:"#acc6e9" }}>{s.value}</div>
              <div style={{ fontSize:8,color:"#64748b",letterSpacing:1 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Autonomous toggle */}
        <button
          onClick={() => setAutonomous(!autonomous)}
          style={{
            display:"flex",alignItems:"center",gap:6,padding:"4px 10px",
            background: autonomous ? "rgba(141,216,159,0.12)" : "rgba(26,58,90,0.4)",
            border: `1px solid ${autonomous?"#8dd89f":"#1a3a5a"}`,
            borderRadius:20,color: autonomous?"#8dd89f":"#64748b",
            cursor:"pointer",fontSize:10,fontWeight:700,letterSpacing:0.6,
          }}
        >
          <div style={{
            width:24,height:14,borderRadius:7,border:`1px solid ${autonomous?"#8dd89f":"#475569"}`,
            background: autonomous?"#8dd89f":"transparent",position:"relative",transition:"background 0.2s",
          }}>
            <div style={{
              position:"absolute",top:2,width:8,height:8,borderRadius:"50%",
              background: autonomous?"#0d1b2f":"#475569",transition:"left 0.2s",
              left: autonomous?12:2,
            }} />
          </div>
          Autonomous
        </button>

        {/* Labels toggle */}
        <button
          onClick={() => setShowLabels(!showLabels)}
          style={{
            padding:"4px 10px",background:"rgba(26,58,90,0.4)",
            border:`1px solid ${showLabels?"#acc6e9":"#1a3a5a"}`,
            borderRadius:20,color:showLabels?"#acc6e9":"#64748b",
            cursor:"pointer",fontSize:10,fontWeight:700,
          }}
        >
          Labels
        </button>

        {/* Wallet */}
        <ConnectKitButton />
      </div>

      {/* ── Layout ───────────────────────────────────────────────────────── */}
      <div style={{ position:"absolute",top:48,left:0,bottom:0,right:0,display:"flex" }}>

        {/* Left panel */}
        <div style={{ width:PANEL_W,flexShrink:0,display:"flex",flexDirection:"column",height:"100%" }}>
          <div style={{ flex:1,overflow:"hidden" }}>
            <SovereignDirectory onSelectJob={openPanel} />
          </div>
        </div>

        {/* Center: 3D board + bottom ledger */}
        <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden",position:"relative" }}>
          <div style={{ flex:1,position:"relative" }}>
            <Board
              world={mergedWorld}
              statusOf={statusOf}
              busyContracts={busyContracts}
              escrow={locked}
              hoveredId={hoveredId}
              selectedId={selectedId}
              focusId={focusId}
              selectedAgreement={selectedAgreement}
              showLabels={showLabels}
              interactive
              onHover={setHovered}
              onSelect={(id) => { setSelected(id); if (id) { setFocusId(id); setPanelOpen(true); setSelectedJob(null); } else setPanelOpen(false); }}
              onSelectAgreement={(id) => setSelectedAgreement(id)}
            />

            {/* Detail slide-over */}
            {panelOpen && (
              <DetailPanel acpJob={selectedJob} onClose={closePanel} />
            )}
          </div>

          {/* Bottom ledger */}
          <div style={{ height:LEDGER_H,flexShrink:0 }}>
            <Ledger />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <ArcWorldProvider>
      <Inner />
    </ArcWorldProvider>
  );
}
