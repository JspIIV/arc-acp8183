import { useEffect, useState } from "react";
import { ConnectKitButton } from "connectkit";
import { IsoBoard } from "./components/IsoBoard";
import { LeftPanel, BottomLedger, RightPanel } from "./components/BoardPanels";
import { ArcWorldProvider, useArcWorld, type AcpJob } from "./context/ArcWorldContext";

const LEGEND = [
  { color: "#85b1ed", label: "Open or funded" },
  { color: "#f59e0b", label: "Delivered, awaiting evaluator" },
  { color: "#8dd89f", label: "Completed" },
  { color: "#e86d7a", label: "Rejected" },
  { color: "#64748b", label: "Expired", dash: true },
];

function Legend() {
  return (
    <div style={{
      position: "absolute", bottom: 12, right: 16, display: "flex", gap: 14, alignItems: "center",
      background: "rgba(0,0,0,0.5)", borderRadius: 4, padding: "4px 12px", border: "1px solid #1a3a5a",
    }}>
      {LEGEND.map((l) => (
        <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="18" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="18" y2="3" stroke={l.color} strokeWidth="2" strokeDasharray={l.dash ? "3 3" : "none"} />
          </svg>
          <span style={{ fontSize: 8, color: "#9db2c9", letterSpacing: 0.5 }}>{l.label}</span>
        </div>
      ))}
    </div>
  );
}

function DataNote() {
  const w = useArcWorld();
  if (!w.configured) {
    return <Note tone="warn">No ACP contract configured. Set VITE_ACP_ADDRESS (and VITE_BOND_HOOK_ADDRESS) in the environment, then restart.</Note>;
  }
  if (w.error) return <Note tone="error">Could not read Arc: {w.error}</Note>;
  return null;
}

function Note({ tone, children }: { tone: "warn" | "error"; children: React.ReactNode }) {
  const c = tone === "error" ? "#e86d7a" : "#f59e0b";
  return (
    <div role="status" style={{
      position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 10, maxWidth: "70%",
      background: "rgba(13,27,47,0.95)", border: `1px solid ${c}`, color: "#e3ecf9", fontSize: 11, padding: "6px 12px", borderRadius: 4,
    }}>{children}</div>
  );
}

function Inner() {
  const w = useArcWorld();
  const [acpJob, setAcpJob] = useState<AcpJob | null>(null);

  // Picking an address on the board replaces any open job detail.
  useEffect(() => { if (w.selectedId) setAcpJob(null); }, [w.selectedId]);

  return (
    <div style={{
      width: "100vw", height: "100vh", overflow: "hidden", background: "#050c17",
      display: "flex", flexDirection: "column", fontFamily: '"DM Sans",system-ui,sans-serif',
    }}>
      <div style={{
        height: 46, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 18px", background: "rgba(5,12,23,0.98)", borderBottom: "1px solid #0f2035", zIndex: 30,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6, background: "linear-gradient(135deg,#acc6e9,#8dd89f)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, color: "#050c17",
          }}>N</div>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#c8d9ec", letterSpacing: 0.5 }}>NEXUS A2A</span>
          <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1.5, color: "#8dd89f", border: "1px solid #8dd89f44", borderRadius: 2, padding: "2px 6px" }}>
            ARC MAINNET
          </span>
          <span style={{ fontSize: 9, color: "#4b6a8a" }}>Live data from the ACP contract</span>
        </div>
        <ConnectKitButton />
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ width: 240, flexShrink: 0, height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <LeftPanel onSelectJob={(j) => { w.setSelected(null); setAcpJob(j); }} />
        </div>
        <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "#050c17" }}>
          <IsoBoard />
          <Legend />
          <DataNote />
          <RightPanel
            acpJob={acpJob}
            onClose={() => { setAcpJob(null); w.setSelected(null); }}
            onSelectJob={(j) => { w.setSelected(null); setAcpJob(j); }}
          />
        </div>
      </div>

      <div style={{ height: 155, flexShrink: 0, overflow: "hidden" }}>
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
