import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import * as E from "../lib/engine";
import type { VisualStatus } from "../lib/world";

// ── Seed world ────────────────────────────────────────────────────────────────
function seedWorld(): E.World {
  let w = E.emptyWorld();
  const now = Date.now();
  const nodes: E.FoundInput[] = [
    { name:"PriceOracleBot", archetype:"Oracle Collective",  charter:"Serves live price feeds with cryptographic freshness guarantees.", owner:"autonomous", collateral:120, treasury:200, endpoint:"https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd", capability:"price-feed", price:2 },
    { name:"TaskRunner",     archetype:"Defense Vanguard",   charter:"Executes deterministic compute tasks inside Arc's trust boundary.", owner:"autonomous", collateral:110, treasury:180 },
    { name:"BitPriceBot",    archetype:"Oracle Collective",  charter:"Provides BTC/USD prices with sub-second latency.", owner:"autonomous", collateral:100, treasury:160, endpoint:"https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", capability:"btc-price", price:3 },
    { name:"TranslateBot",   archetype:"Liquidity Nexus",    charter:"Translates natural language across 100+ language pairs.", owner:"autonomous", collateral:130, treasury:220, endpoint:"https://api.mymemory.translated.net/get?q=hello&langpair=en|es", capability:"translation", price:1 },
    { name:"EchoWorker",     archetype:"Autonomous Arbiter", charter:"Validates protocol invariants and mirrors payloads for audits.", owner:"autonomous", collateral:100, treasury:150, endpoint:"https://postman-echo.com/get?q=arc-test", capability:"echo", price:1 },
  ];
  for (const inp of nodes) {
    try { w = E.foundNode(w, inp, now - Math.floor(Math.random()*300_000)); } catch { /* skip */ }
  }
  return w;
}

// ── Context shape ─────────────────────────────────────────────────────────────
interface ArcWorldCtx {
  world: E.World;
  now: number;
  busyContracts: Set<number>;
  pendingDisputes: Set<number>;
  autonomous: boolean;
  setAutonomous: (v: boolean) => void;
  statusOf: (id: string) => VisualStatus;
  claim:    (id: string) => void;
  withdraw: (id: string, amount: number) => void;
  ratify:   (id: number) => void;
  reject:   (id: number, note: string) => void;
  cancel:   (id: number) => void;
  exit:     (id: number, by: string) => void;
  invoke:   (id: number) => void;
  dispute:  (agreementId: number, plaintiffId: string, allegation: string) => void;
  foundNode:       (inp: E.FoundInput) => void;
  proposeAgreement:(inp: E.ProposeInput) => void;
}

const Ctx = createContext<ArcWorldCtx | null>(null);
export const useArcWorld = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("ArcWorldContext missing");
  return c;
};

// ── Provider ──────────────────────────────────────────────────────────────────
export function ArcWorldProvider({ children }: { children: React.ReactNode }) {
  const [world,  setWorld]  = useState<E.World>(seedWorld);
  const [now,    setNow]    = useState(Date.now());
  const [autonomous,    setAutonomous]    = useState(true);
  const [busyContracts, setBusy]          = useState<Set<number>>(new Set());
  const [pendingDisputes, setPending]     = useState<Set<number>>(new Set());

  const turn = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      setWorld(w => {
        let next = E.expireAgreements(w, n);
        if (autonomous) {
          const act = E.nextAutonomousAction(next, n, turn.current++);
          if (act) {
            try {
              switch (act.type) {
                case "ratify":  next = E.ratifyAgreement(next,  act.agreementId, act.by, n, act.note); break;
                case "reject":  next = E.rejectAgreement(next,  act.agreementId, act.by, n, act.note); break;
                case "invoke":  /* handled async below */ break;
                case "dispute": break;
                case "claim":   next = E.claim(next, act.nodeId, n); break;
                case "propose": next = E.proposeAgreement(next, act.input, n); break;
              }
            } catch { /* rule refused */ }
          }
        }
        return next;
      });
    }, 1500);
    return () => clearInterval(id);
  }, [autonomous]);

  const statusOf = useCallback((id: string): VisualStatus => {
    const a = world.nodes.find(x => x.id === id);
    if (!a || a.status === "sanctioned") return "sanctioned";
    if (world.disputes.some(d => (d.defendant === id || d.plaintiff === id) && Date.now() - d.ts < 20_000)) return "contested";
    return "active";
  }, [world]);

  const mut = useCallback((fn: (w: E.World, n: number) => E.World) => {
    const n = Date.now();
    setNow(n);
    setWorld(w => { try { return fn(w, n); } catch (e) { console.warn(e); return w; } });
  }, []);

  const invoke = useCallback((id: number) => {
    setBusy(s => new Set(s).add(id));
    const ag = world.agreements.find(x => x.id === id);
    const provider = ag ? world.nodes.find(n => n.id === ag.partyB) : undefined;
    const endpoint = provider?.endpoint;
    if (!ag || !endpoint) { setBusy(s => { const n = new Set(s); n.delete(id); return n; }); return; }
    const t0 = Date.now();
    fetch(endpoint, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json().then(body => ({ ok: r.ok, body })).catch(() => ({ ok: r.ok, body: {} })))
      .catch(() => ({ ok: false, body: {} }))
      .then(({ ok, body }) => {
        const ms = Date.now() - t0;
        const output = ok ? JSON.stringify(body).slice(0, 80) : "network error";
        setWorld(w => { try { return E.recordServiceCall(w, id, { ts: Date.now(), ok, ms, input: endpoint, output }, Date.now()); } catch { return w; } });
      })
      .finally(() => setBusy(s => { const n = new Set(s); n.delete(id); return n; }));
  }, [world.agreements, world.nodes]);

  const dispute = useCallback((agreementId: number, plaintiffId: string, allegation: string) => {
    const n = Date.now();
    setWorld(w => {
      try {
        const c = E.prepareDispute(w, agreementId, plaintiffId, allegation, n);
        const { tier, rationale } = E.localArbiter(c.metricBps, !!allegation.trim());
        return E.settleDispute(w, c, { tier, rationale, by: "Arc Arbiter", allegation, evidenceUri: "" }, n);
      } catch (e) { console.warn(e); return w; }
    });
  }, []);

  const ctx: ArcWorldCtx = {
    world, now, busyContracts, pendingDisputes, autonomous, setAutonomous, statusOf,
    claim:   id  => mut((w, n) => E.claim(w, id, n)),
    withdraw:(id) => mut((w, n) => E.claim(w, id, n)),
    ratify:  id  => mut((w, n) => E.ratifyAgreement(w, id, world.agreements.find(c => c.id === id)?.partyB ?? "", n)),
    reject:  (id, note) => mut((w, n) => E.rejectAgreement(w, id, world.agreements.find(c => c.id === id)?.partyB ?? "", n, note)),
    cancel:  id  => mut((w, n) => E.cancelProposal(w, id, world.agreements.find(c => c.id === id)?.partyA ?? "", n)),
    exit:    (id, by) => mut((w, n) => E.exitAgreement(w, id, by, n)),
    invoke, dispute,
    foundNode:        inp => mut((w, n) => E.foundNode(w, inp, n)),
    proposeAgreement: inp => mut((w, n) => E.proposeAgreement(w, inp, n)),
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}
