import { useState } from "react";
import { ConnectKitButton } from "connectkit";
import { useAccount, useReadContract } from "wagmi";
import { Cpu, ChevronLeft, ToggleLeft, ToggleRight, Layers } from "lucide-react";
import Board from "./components/board/Board";
import { AgentDirectory, AgentDossier, AgreementInspector, Ledger } from "./components/Panels";
import WalletCard from "./components/WalletCard";
import { ArcWorldProvider, useArcWorld } from "./context/ArcWorldContext";
import { lockedEscrow } from "./lib/engine";
import { ACP_ABI } from "./abis";
import { ACP_ADDRESS, TARGET_CHAIN } from "./config";

// ── ACP live job count read from chain ──────────────────────────────────────
function useJobCount() {
  const { data } = useReadContract({
    address: ACP_ADDRESS || undefined,
    abi: ACP_ABI,
    functionName: "jobCount",
    chainId: TARGET_CHAIN.id,
    query: { enabled: !!ACP_ADDRESS, refetchInterval: 10_000 },
  });
  return ACP_ADDRESS ? Number(data ?? 0n) : null;
}

// ── Main app ─────────────────────────────────────────────────────────────────
function NexusApp() {
  const { isConnected } = useAccount();
  const { world, statusOf, busyContracts, autonomous, setAutonomous } = useArcWorld();
  const jobCount = useJobCount();

  const [hoveredId,         setHoveredId]         = useState<string | null>(null);
  const [selectedId,        setSelectedId]         = useState<string | null>(null);
  const [focusId,           setFocusId]            = useState<string | null>(null);
  const [selectedAgreement, setSelectedAgreement]  = useState<number | null>(null);
  const [showLabels,        setShowLabels]         = useState(true);
  const [leftOpen,          setLeftOpen]           = useState(true);
  const [rightPanel,        setRightPanel]         = useState<"agent" | "agreement" | null>(null);

  const escrow = lockedEscrow(world);

  function selectAgent(id: string) {
    setSelectedId(id); setFocusId(id); setSelectedAgreement(null); setRightPanel("agent");
  }
  function selectAgreement(id: number) {
    setSelectedAgreement(id); setRightPanel("agreement");
  }
  function clearSelection() {
    setSelectedId(null); setFocusId(null); setSelectedAgreement(null); setRightPanel(null);
  }

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#060f1a]">

      {/* ── Navbar ── */}
      <header className="h-12 shrink-0 flex items-center px-4 gap-3 border-b border-[rgba(172,198,233,0.1)] bg-[rgba(13,27,47,0.95)] backdrop-blur-sm z-30">
        <Cpu className="w-5 h-5 text-[#acc6e9] shrink-0" />
        <span
          className="font-semibold text-[#f9faf3] tracking-tight text-sm"
          style={{ fontFamily: "'Space Grotesk',sans-serif" }}
        >
          Nexus A2A
        </span>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-[#8dd89f]/40 text-[#8dd89f]">
          ARC MAINNET
        </span>

        {/* ERC-8183 badge */}
        <span className="hidden sm:flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-[rgba(172,198,233,0.3)] text-[#acc6e9]">
          <Layers className="w-3 h-3" />ERC-8183
        </span>

        {/* Live ACP job count */}
        {jobCount !== null && (
          <span className="text-[11px] text-[#64748b] hidden md:block">
            {jobCount} job{jobCount !== 1 ? "s" : ""} onchain
          </span>
        )}

        <span className="flex-1" />

        <button
          onClick={() => setAutonomous(!autonomous)}
          className="flex items-center gap-1.5 text-[11px] text-[#94a3b8] hover:text-[#f9faf3] transition-colors"
        >
          {autonomous
            ? <ToggleRight className="w-4 h-4 text-[#8dd89f]" />
            : <ToggleLeft  className="w-4 h-4" />}
          Autonomous agents
        </button>

        <button
          onClick={() => setShowLabels(v => !v)}
          className="text-[11px] text-[#94a3b8] hover:text-[#f9faf3] transition-colors hidden sm:block"
        >
          {showLabels ? "Hide labels" : "Show labels"}
        </button>

        <ConnectKitButton />
      </header>

      {/* ── Main layout ── */}
      <div className="flex flex-1 min-h-0 relative">

        {/* Left panel */}
        <div
          className={`relative flex flex-col shrink-0 transition-all duration-200 z-20 ${leftOpen ? "w-72" : "w-0"} overflow-hidden`}
        >
          <div className="w-72 h-full flex flex-col border-r border-[rgba(172,198,233,0.1)] bg-[rgba(13,27,47,0.96)]">
            <div className="px-3 pt-3 pb-1.5 shrink-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold tracking-widest text-[#64748b]">AGENTS</span>
                <span className="text-[10px] text-[#64748b]">{world.nodes.length} registered</span>
              </div>
              <AgentDirectory selectedId={selectedId} onSelect={selectAgent} />
            </div>
            <div className="mx-3 my-1.5 border-t border-[rgba(172,198,233,0.08)]" />
            <div className="px-3 pb-3 flex flex-col min-h-0 flex-1">
              <div className="text-[10px] font-semibold tracking-widest text-[#64748b] mb-1.5 shrink-0">LEDGER</div>
              <Ledger />
            </div>
          </div>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setLeftOpen(v => !v)}
          className="absolute top-1/2 -translate-y-1/2 z-30 w-5 h-10 flex items-center justify-center bg-[rgba(13,27,47,0.9)] border border-[rgba(172,198,233,0.15)] rounded-r-lg transition-all hover:bg-[rgba(172,198,233,0.1)]"
          style={{ left: leftOpen ? "288px" : "0px" }}
        >
          <ChevronLeft className={`w-3 h-3 text-[#94a3b8] transition-transform ${leftOpen ? "" : "rotate-180"}`} />
        </button>

        {/* 3-D Board */}
        <div className="flex-1 relative min-w-0">
          <Board
            world={world} statusOf={statusOf} busyContracts={busyContracts} escrow={escrow}
            hoveredId={hoveredId} selectedId={selectedId} focusId={focusId}
            selectedAgreement={selectedAgreement} showLabels={showLabels}
            onHover={setHoveredId}
            onSelect={id => id ? selectAgent(id) : clearSelection()}
            onSelectAgreement={selectAgreement}
          />

          {/* Bottom legend */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-3 px-3 py-1.5 rounded-xl bg-[rgba(13,27,47,0.85)] border border-[rgba(172,198,233,0.12)] text-[10px] text-[#64748b] pointer-events-none">
            <span className="flex items-center gap-1"><span className="w-6 h-px bg-[#acc6e9] inline-block" />Service</span>
            <span className="flex items-center gap-1"><span className="w-6 border-t border-dashed border-[#8dd89f] inline-block" />Data</span>
            <span className="flex items-center gap-1"><span className="w-6 border-t border-dotted border-[#cbdbf2] inline-block" />Non-aggression</span>
            <span className="text-[#8dd89f]">● Active</span>
            <span className="text-[#acc6e9]">● Under review</span>
            <span className="text-[#e86d7a]">● Suspended</span>
            <span className="text-[#acc6e9]">◎ Arc Escrow</span>
          </div>

          {/* Escrow + ACP HUD */}
          <div className="absolute top-3 right-3 text-right pointer-events-none">
            <div className="text-[10px] text-[#64748b] uppercase tracking-widest">ARC ESCROW</div>
            <div className="text-sm font-semibold font-mono text-[#acc6e9]">{escrow.toFixed(2)} USDC</div>
            <div className="text-[10px] text-[#64748b] mt-0.5">
              {world.nodes.length} agents · {world.agreements.filter(c => c.status === "active").length} agreements
            </div>
            {jobCount !== null && (
              <div className="text-[10px] text-[#8dd89f] mt-0.5 font-medium">
                {jobCount} ERC-8183 jobs live
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        {rightPanel && (
          <div className="w-80 shrink-0 flex flex-col border-l border-[rgba(172,198,233,0.1)] bg-[rgba(13,27,47,0.96)] z-20">
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b border-[rgba(172,198,233,0.08)] shrink-0">
              <span className="text-[10px] font-semibold tracking-widest text-[#64748b]">
                {rightPanel === "agent" ? "AGENT" : "AGREEMENT"}
              </span>
              <button onClick={clearSelection} className="text-[#64748b] hover:text-[#f9faf3] text-lg leading-none">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2 text-[13px] text-[#f9faf3]">
              {rightPanel === "agent" && selectedId && (
                <AgentDossier id={selectedId} onSelectAgreement={selectAgreement} onPropose={() => {}} />
              )}
              {rightPanel === "agreement" && selectedAgreement !== null && (
                <AgreementInspector id={selectedAgreement} onSelectAgent={selectAgent} onDispute={() => {}} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Wallet float */}
      {isConnected && (
        <div className="fixed bottom-4 right-4 z-40">
          <WalletCard />
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ArcWorldProvider>
      <NexusApp />
    </ArcWorldProvider>
  );
}
