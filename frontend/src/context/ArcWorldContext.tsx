// Board state. Everything on the board is read from Arc (see useOnchainWorld);
// this context only adds what the user is looking at: hover, selection, focus.

import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useOnchainWorld, acpConfigured } from "../hooks/useOnchainWorld";
import {
  awaitingReview, buildAgents, buildDeals, buildLedger, lockedEscrow,
  type ChainAgent, type ChainJob, type Deal, type LedgerEntry,
} from "../lib/chain";
import type { VisualStatus } from "../lib/world";

export type AcpJob = ChainJob;

interface ArcWorldState {
  configured:   boolean;
  loading:      boolean;
  error:        string | null;
  eventsError:  string | null;
  jobs:         ChainJob[];
  jobCount:     number;
  agents:       ChainAgent[];
  deals:        Deal[];
  ledger:       LedgerEntry[];
  /** Latest delivered work per job id, from JobSubmitted events inside the scanned window. */
  submissions:  Map<string, { deliverable: string; uri: string }>;
  escrow:       number;
  head:         bigint | null;
  eventsFrom:   bigint | null;
  eventsFloor:  bigint | null;
  eventsComplete: boolean;
  eventsFromDeploy: boolean;
  fetchedAt:    number | null;
  hoveredId:    string | null;
  selectedId:   string | null;
  focusId:      string | null;
  showLabels:   boolean;
  busyDeals:    Set<number>;
  statusOf:     (id: string) => VisualStatus;
  setHovered:   (id: string | null) => void;
  setSelected:  (id: string | null) => void;
  setFocusId:   (id: string | null) => void;
  setShowLabels:(v: boolean) => void;
  refetch:      () => void;
}

const Ctx = createContext<ArcWorldState | null>(null);

export function ArcWorldProvider({ children }: { children: ReactNode }) {
  const q = useOnchainWorld();
  const [hoveredId, setHovered]   = useState<string | null>(null);
  const [selectedId, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId]     = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);

  const snap = q.data;
  const jobs = useMemo(() => snap?.jobs ?? [], [snap]);

  const agents = useMemo(() => buildAgents(jobs, snap?.bonds ?? new Map()), [jobs, snap]);
  const deals  = useMemo(() => buildDeals(jobs), [jobs]);
  const ledger = useMemo(
    () => (snap ? buildLedger(snap.logs, snap.blockTimes) : []),
    [snap],
  );
  const escrow = useMemo(() => lockedEscrow(jobs), [jobs]);
  const submissions = useMemo(() => {
    const out = new Map<string, { deliverable: string; uri: string; block: bigint }>();
    for (const l of snap?.logs ?? []) {
      if (l.name !== "JobSubmitted") continue;
      const id = String(l.args.jobId);
      const prev = out.get(id);
      if (prev && prev.block > l.blockNumber) continue;
      out.set(id, { deliverable: String(l.args.deliverable ?? ""), uri: String(l.args.uri ?? ""), block: l.blockNumber });
    }
    return out;
  }, [snap]);
  const busyDeals = useMemo(() => new Set(deals.filter((d) => d.status === "Submitted").map((d) => d.id)), [deals]);

  const value: ArcWorldState = {
    configured:  acpConfigured,
    loading:     acpConfigured && q.isLoading,
    error:       q.error ? (q.error instanceof Error ? q.error.message.split("\n")[0] : String(q.error)) : null,
    eventsError: snap?.eventsError ?? null,
    jobs,
    jobCount:    snap?.jobCount ?? 0,
    agents, deals, ledger, escrow, submissions,
    head:        snap?.head ?? null,
    eventsFrom:  snap?.eventsFrom ?? null,
    eventsFloor: snap?.eventsFloor ?? null,
    eventsComplete: snap?.eventsComplete ?? false,
    eventsFromDeploy: snap?.eventsFromDeploy ?? false,
    fetchedAt:   snap?.fetchedAt ?? null,
    hoveredId, selectedId, focusId, showLabels, busyDeals,
    statusOf:    (id) => (awaitingReview(jobs, id) ? "review" : "active"),
    setHovered, setSelected, setFocusId, setShowLabels,
    refetch:     () => { void q.refetch(); },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useArcWorld(): ArcWorldState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useArcWorld must be inside ArcWorldProvider");
  return c;
}
