// Arc World context: merges the diplomacy engine's local world state
// with live on-chain ACP job data. The 3D board visualises agents as
// island nodes; ACP jobs appear as arcs between client and provider nodes.

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from "react";
import type { ReactNode } from "react";
import {
  type World, type AgentNode, type Agreement, type AutoAction,
  type AgreementKind, type AgreementStatus,
  emptyWorld, foundNode, proposeAgreement, ratifyAgreement, rejectAgreement,
  cancelProposal, exitAgreement, expireAgreements, recordServiceCall,
  prepareDispute, settleDispute, localArbiter, clampTier, claim,
  nextAutonomousAction, isContested, agreementsOf, lockedEscrow,
  log as wLog,
} from "../lib/engine";
import { islandTopY, buildLayouts, type VisualStatus } from "../lib/world";
import * as THREE from "three";

export interface AcpJob {
  id:          bigint;
  client:      string;
  provider:    string;
  evaluator:   string;
  description: string;
  budget:      bigint;
  expiredAt:   bigint;
  status:      number;   // 0=Open,1=Funded,2=Submitted,3=Completed,4=Rejected,5=Expired
}

interface ArcWorldState {
  world:             World;
  acpJobs:           AcpJob[];
  hoveredId:         string | null;
  selectedId:        string | null;
  selectedAgreement: number | null;
  focusId:           string | null;
  showLabels:        boolean;
  autonomous:        boolean;
  busyContracts:     Set<number>;
  statusOf:          (id: string) => VisualStatus;
  agentTopPos:       (id: string) => THREE.Vector3 | null;
  acpAgreements:     Agreement[];  // synthetic arcs from ACP jobs
  // actions
  foundNode:   (input: Parameters<typeof foundNode>[1]) => void;
  propose:     (input: Parameters<typeof proposeAgreement>[1]) => void;
  ratify:      (id: number, note?: string) => void;
  rejectAg:   (id: number, note: string) => void;
  cancel:      (id: number) => void;
  exit:        (id: number) => void;
  invoke:      (id: number) => void;
  fileDispute: (agreementId: number, plaintiffId: string, allegation: string, evidenceUri: string) => void;
  claimNode:   (id: string) => void;
  setHovered:        (id: string | null) => void;
  setSelected:       (id: string | null) => void;
  setSelectedAgreement: (id: number | null) => void;
  setFocusId:        (id: string | null) => void;
  setShowLabels:     (v: boolean) => void;
  setAutonomous:     (v: boolean) => void;
  setAcpJobs:        (jobs: AcpJob[]) => void;
}

const Ctx = createContext<ArcWorldState | null>(null);

// ── Seed agents representing ACP roles ────────────────────────────────────────
const SEED_AGENTS: Parameters<typeof foundNode>[1][] = [
  { name:"PriceOracleBot", archetype:"Oracle Collective",  charter:"Live price feeds for Arc DeFi protocols.", collateral:120, treasury:200, owner:"autonomous", endpoint:"https://api.coingecko.com/api/v3/simple/price", capability:"price", price:4 },
  { name:"TaskRunner",     archetype:"Liquidity Nexus",    charter:"General compute tasks for Arc agents.",      collateral:120, treasury:180, owner:"autonomous", endpoint:"https://postman-echo.com/post",                capability:"compute", price:3 },
  { name:"BitPriceBot",    archetype:"Oracle Collective",  charter:"BTC/ETH spot prices.",                       collateral:110, treasury:160, owner:"autonomous", endpoint:"https://api.coingecko.com/api/v3/simple/price", capability:"price", price:4 },
  { name:"TranslateBot",   archetype:"Liquidity Nexus",    charter:"Multilingual text translation on Arc.",      collateral:115, treasury:170, owner:"autonomous", endpoint:"https://api.mymemory.translated.net/get",      capability:"translate", price:3 },
  { name:"EchoWorker",     archetype:"Autonomous Arbiter", charter:"Echo and validation service for Arc jobs.",  collateral:100, treasury:150, owner:"autonomous", endpoint:"https://postman-echo.com/post",                capability:"echo", price:2 },
];

function buildSeedWorld(): World {
  let w = emptyWorld();
  const now = Date.now();
  for (const s of SEED_AGENTS) {
    try { w = foundNode(w, { ...s, foundedAt: now - 5 * 60_000 } as typeof s & { foundedAt?: number }, now - 5 * 60_000); }
    catch { /* already exists */ }
  }
  return w;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function agentNameFromAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function acpStatusToAgreementStatus(s: number): AgreementStatus {
  switch (s) {
    case 0: return "proposed";   // Open
    case 1: return "proposed";   // Funded
    case 2: return "active";     // Submitted
    case 3: return "settled";    // Completed
    case 4: return "cancelled";  // Rejected
    case 5: return "expired";
    default: return "proposed";
  }
}

function jobKind(job: AcpJob): AgreementKind {
  // All ACP jobs are service agreements
  return "SERVICE";
}

function makeSyntheticNode(addr: string, w: World): World {
  if (w.nodes.find(n => n.id === addr)) return w;
  return foundNode(w, {
    name: agentNameFromAddr(addr),
    archetype: "Oracle Collective",
    charter: "ACP participant node.",
    collateral: 0,
    treasury: 0,
    owner: "autonomous",
  }, Date.now() - 60_000);
}

export function ArcWorldProvider({ children }: { children: ReactNode }) {
  const [world,          setWorld]          = useState<World>(buildSeedWorld);
  const [acpJobs,        setAcpJobsState]   = useState<AcpJob[]>([]);
  const [hoveredId,      setHovered]        = useState<string | null>(null);
  const [selectedId,     setSelected]       = useState<string | null>(null);
  const [selectedAg,     setSelectedAg]     = useState<number | null>(null);
  const [focusId,        setFocusId]        = useState<string | null>(null);
  const [showLabels,     setShowLabels]     = useState(true);
  const [autonomous,     setAutonomous]     = useState(false);
  const [busyContracts,  setBusy]           = useState<Set<number>>(new Set());
  const turnRef   = useRef(0);

  const now = () => Date.now();

  // ── Sync ACP jobs into world nodes + synthetic agreements ─────────────────
  const setAcpJobs = useCallback((jobs: AcpJob[]) => {
    setAcpJobsState(jobs);
    setWorld(prev => {
      let w = prev;
      for (const job of jobs) {
        w = makeSyntheticNode(job.client,   w);
        w = makeSyntheticNode(job.provider, w);
      }
      return w;
    });
  }, []);

  // Build synthetic arcs from live ACP jobs
  const acpAgreements: Agreement[] = acpJobs
    .filter(j => j.status < 4)
    .map((j, idx) => ({
      id:               -(idx + 1),   // negative IDs = ACP job arcs
      kind:             jobKind(j),
      terms:            j.description,
      partyA:           j.client,
      partyB:           j.provider,
      bondA:            0,
      bondB:            0,
      feePerCall:       0,
      callBudget:       Number(j.budget) / 1e6,
      calls:            [],
      durationMs:       Number(j.expiredAt) * 1000 - Date.now(),
      proposedAt:       Date.now(),
      status:           acpStatusToAgreementStatus(j.status),
      elevatedSlashedA: false,
      elevatedSlashedB: false,
    }));

  // ── Tick ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      setWorld(w => expireAgreements(w, now()));
    }, 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!autonomous) return;
    const id = setInterval(() => {
      setWorld(prev => {
        const action: AutoAction | null = nextAutonomousAction(prev, now(), turnRef.current++);
        if (!action) return prev;
        try {
          switch (action.type) {
            case "ratify":  return ratifyAgreement(prev, action.agreementId, action.by, now(), action.note);
            case "reject":  return rejectAgreement(prev, action.agreementId, action.by, now(), action.note);
            case "claim":   return claim(prev, action.nodeId, now());
            case "propose": return proposeAgreement(prev, action.input, now());
            case "invoke": {
              const ag = prev.agreements.find(a => a.id === action.agreementId);
              if (!ag || ag.kind !== "SERVICE") return prev;
              const node = prev.nodes.find(n => n.id === ag.partyB);
              if (!node?.endpoint) return prev;
              setBusy(s => new Set([...s, ag.id]));
              const t0 = Date.now();
              fetch(node.endpoint, { method: "POST", body: JSON.stringify({ arc: true }), signal: AbortSignal.timeout(6000) })
                .then(r => r.ok ? r.json().then(() => ({ ok: true, ms: Date.now()-t0 })) : { ok: false, ms: Date.now()-t0 })
                .catch(() => ({ ok: false, ms: Date.now()-t0 }))
                .then(({ ok, ms }) => {
                  setWorld(w2 => {
                    try {
                      return recordServiceCall(w2, action.agreementId, { ts: Date.now(), ok, ms, input: "{}", output: ok ? "{}" : "" }, now());
                    } catch { return w2; }
                  });
                  setBusy(s => { const n = new Set(s); n.delete(action.agreementId); return n; });
                });
              return prev;
            }
            case "dispute": {
              const c = prepareDispute(prev, action.agreementId, action.plaintiff, action.allegation, now());
              const v = localArbiter(c.metricBps, !!action.allegation);
              const tier = clampTier(v.tier, c.metricBps, !!action.allegation);
              return settleDispute(prev, c, { ...v, tier, by: "Arc Arbiter", allegation: action.allegation, evidenceUri: "" }, now());
            }
          }
        } catch { return prev; }
        return prev;
      });
    }, 2200);
    return () => clearInterval(id);
  }, [autonomous]);

  // ── Status ────────────────────────────────────────────────────────────────
  const statusOf = useCallback((id: string): VisualStatus => {
    const n = world.nodes.find(n => n.id === id);
    if (!n) return "active";
    if (n.status === "sanctioned") return "sanctioned";
    if (isContested(world, id, now())) return "contested";
    return "active";
  }, [world]);

  // ── Top positions for arc drawing ─────────────────────────────────────────
  const agentTopPos = useCallback((id: string): THREE.Vector3 | null => {
    const layouts = buildLayouts(world.nodes);
    const l = layouts.find(x => x.id === id);
    if (!l) return null;
    return new THREE.Vector3(l.x, islandTopY(l.floatY) + 2.6, l.z);
  }, [world.nodes]);

  // ── Mutation wrappers ─────────────────────────────────────────────────────
  const wrap = useCallback((fn: (w: World) => World) => {
    setWorld(prev => { try { return fn(prev); } catch (e) { console.warn(e); return prev; } });
  }, []);

  const value: ArcWorldState = {
    world, acpJobs, hoveredId, selectedId, selectedAgreement: selectedAg,
    focusId, showLabels, autonomous, busyContracts,
    statusOf, agentTopPos, acpAgreements,
    foundNode:   (input) => wrap(w => foundNode(w, input, now())),
    propose:     (input) => wrap(w => proposeAgreement(w, input, now())),
    ratify:      (id, note) => wrap(w => ratifyAgreement(w, id, selectedId ?? "", now(), note)),
    rejectAg:    (id, note) => wrap(w => rejectAgreement(w, id, selectedId ?? "", now(), note)),
    cancel:      (id) => wrap(w => cancelProposal(w, id, selectedId ?? "", now())),
    exit:        (id) => wrap(w => exitAgreement(w, id, selectedId ?? "", now())),
    invoke:      (id) => { /* triggered by autonomous tick */ void id; },
    fileDispute: (agreementId, plaintiffId, allegation, evidenceUri) => wrap(w => {
      const c = prepareDispute(w, agreementId, plaintiffId, allegation, now());
      const v = localArbiter(c.metricBps, !!evidenceUri);
      const tier = clampTier(v.tier, c.metricBps, !!evidenceUri);
      return settleDispute(w, c, { ...v, tier, by: "Arc AI Arbiter", allegation, evidenceUri }, now());
    }),
    claimNode:   (id) => wrap(w => claim(w, id, now())),
    setHovered, setSelected,
    setSelectedAgreement: setSelectedAg,
    setFocusId, setShowLabels, setAutonomous, setAcpJobs,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useArcWorld(): ArcWorldState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useArcWorld must be inside ArcWorldProvider");
  return c;
}

export { lockedEscrow, agreementsOf };
