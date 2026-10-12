import { useState } from "react";
import clsx from "clsx";
import { Cpu, ScrollText, Radio, Gavel, Coins, LogOut, Check, X, Undo2, Zap, Loader2 } from "lucide-react";
import * as E from "../lib/engine";
import { useArcWorld } from "../context/ArcWorldContext";
import { BIOME_BY_ARCHETYPE, KIND_COLOR, STATUS_COLOR, STATUS_LABEL } from "../lib/world";

export const panelCls = "rounded-2xl border border-[rgba(172,198,233,0.12)] bg-[rgba(13,27,47,0.97)]";
export const btnPrimary = "inline-flex items-center gap-1.5 rounded-lg bg-[#acc6e9] text-[#0d1b2f] font-semibold transition-colors hover:bg-[#cbdbf2] disabled:opacity-40 disabled:cursor-not-allowed";
export const btnGhost   = "inline-flex items-center gap-1.5 rounded-lg border border-[rgba(172,198,233,0.2)] text-[#94a3b8] font-medium transition-colors hover:border-[#acc6e9] hover:text-[#acc6e9] disabled:opacity-40";

function timeAgo(ts: number) {
  const s = Math.floor((Date.now()-ts)/1000);
  if (s<5)  return "just now";
  if (s<60) return `${s}s ago`;
  const m = Math.floor(s/60);
  if (m<60) return `${m}m ago`;
  return `${Math.floor(m/60)}h ${m%60}m ago`;
}
function remaining(ms: number) {
  if (ms<=0) return "expired";
  const m=Math.floor(ms/60_000), s=Math.floor((ms%60_000)/1000);
  return m>=60?`${Math.floor(m/60)}h ${m%60}m`:`${m}m ${String(s).padStart(2,"0")}s`;
}

const STATUS_PILL: Record<E.AgreementStatus, string> = {
  proposed: "text-[#acc6e9] bg-[rgba(172,198,233,0.1)]",
  active:   "text-[#8dd89f] bg-[rgba(141,216,159,0.1)]",
  settled:  "text-[#94a3b8] bg-white/5",
  expired:  "text-[#94a3b8] bg-white/5",
  cancelled:"text-[#94a3b8] bg-white/5",
  rejected: "text-[#e86d7a] bg-[rgba(232,109,122,0.1)]",
};

// ── Agent Directory ────────────────────────────────────────────────────────────
export function AgentDirectory({ selectedId, onSelect }: { selectedId: string|null; onSelect: (id: string) => void }) {
  const { world, statusOf } = useArcWorld();
  const sorted = [...world.nodes].sort((a,b) => Number(b.owner==="you")-Number(a.owner==="you") || b.reputation-a.reputation);
  return (
    <div className="space-y-0.5">
      {sorted.map(a => {
        const st   = statusOf(a.id);
        const live = E.agreementsOf(world, a.id).filter(c => c.status==="active").length;
        const dot  = st!=="active" ? STATUS_COLOR[st] : live>0 ? "#8dd89f" : "#2a3f58";
        const biome = BIOME_BY_ARCHETYPE[a.archetype];
        return (
          <button key={a.id} onClick={() => onSelect(a.id)}
            className={clsx("w-full text-left rounded-lg px-2.5 h-14 transition-all flex items-center gap-2.5 border",
              selectedId===a.id?"border-[rgba(172,198,233,0.35)] bg-[rgba(172,198,233,0.07)]":"border-transparent hover:bg-white/5")}>
            <span className="relative w-6 h-6 rounded-md shrink-0 border border-white/10"
              style={{ background:`linear-gradient(135deg,${biome.accent},${biome.base})` }}>
              <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2 border-[rgba(13,27,47,0.97)]"
                style={{ background: dot }} title={st!=="active"?STATUS_LABEL[st]:`${live} active agreements`} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-[#f9faf3] truncate">
                {a.name}{a.owner==="you"&&<span className="text-[#acc6e9] text-[10px] ml-1.5">YOURS</span>}
              </span>
              <span className="block text-[11px] text-[#94a3b8] truncate">{a.archetype} · {live} active</span>
            </span>
            <span className="text-right shrink-0 w-9">
              <span className="block text-[13px] tabular-nums text-[#e3ecf9]">{a.reputation}</span>
              <span className="block text-[10px] uppercase tracking-wider text-[#94a3b8]">rep</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Ledger ─────────────────────────────────────────────────────────────────────
const LEDGER_KIND: Record<E.LedgerKind, { label: string; color: string; group: LedgerFilter }> = {
  "node-founded":       { label:"Founded",   color:"#cbdbf2", group:"agreements" },
  "agreement-proposed": { label:"Proposal",  color:"#acc6e9", group:"agreements" },
  "agreement-signed":   { label:"Signed",    color:"#8dd89f", group:"agreements" },
  "agreement-rejected": { label:"Rejected",  color:"#e86d7a", group:"agreements" },
  "agreement-closed":   { label:"Closed",    color:"#64748b", group:"agreements" },
  "service-call":       { label:"Call",      color:"#acc6e9", group:"calls" },
  "escrow-released":    { label:"Released",  color:"#8dd89f", group:"calls" },
  "dispute-opened":     { label:"Dispute",   color:"#e86d7a", group:"disputes" },
  "verdict":            { label:"Verdict",   color:"#acc6e9", group:"disputes" },
  "sanction":           { label:"Sanction",  color:"#e86d7a", group:"disputes" },
};

type LedgerFilter = "all"|"agreements"|"calls"|"disputes";
const FILTERS: [LedgerFilter, string][] = [["all","All"],["agreements","Agreements"],["calls","Calls"],["disputes","Disputes"]];

export function Ledger({ limit=40 }: { limit?: number }) {
  const { world } = useArcWorld();
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const rows = world.ledger.filter(ev => filter==="all" || LEDGER_KIND[ev.kind].group===filter).slice(0, limit);
  return (
    <div className="flex flex-col min-h-0 flex-1 gap-2">
      <div className="flex gap-1 shrink-0">
        {FILTERS.map(([f,label]) => (
          <button key={f} onClick={() => setFilter(f)}
            className={clsx("px-2 h-6 rounded-full text-[11px] border transition-all",
              filter===f?"border-[rgba(172,198,233,0.4)] bg-[rgba(172,198,233,0.1)] text-[#acc6e9]":"border-[rgba(255,255,255,0.1)] text-[#94a3b8] hover:text-[#f9faf3]")}>
            {label}
          </button>
        ))}
      </div>
      <div className="overflow-y-auto min-h-0">
        {rows.map(ev => {
          const k = LEDGER_KIND[ev.kind];
          const loud = ev.kind==="verdict" || ev.kind==="sanction";
          return (
            <div key={ev.id} className={clsx("flex gap-2 py-1.5 pl-2 border-l-2 border-b border-b-white/5 text-[11px] leading-snug",
              loud&&(ev.kind==="sanction"?"bg-[rgba(232,109,122,0.06)]":"bg-[rgba(172,198,233,0.06)]"))}
              style={{ borderLeftColor: k.color }}>
              <span className="min-w-0">
                <span className="text-[9px] font-medium uppercase tracking-wider mr-1.5 px-1 py-px rounded"
                  style={{ color:k.color, background:`${k.color}26` }}>{k.label}</span>
                <span className={loud?"text-[#f9faf3] font-medium":"text-[#94a3b8]"}>{ev.text}</span>
                <span className="text-[#64748b]"> · {timeAgo(ev.ts)}</span>
              </span>
            </div>
          );
        })}
        {rows.length===0 && <div className="text-xs text-[#64748b] py-2">{world.ledger.length?"Nothing of this kind yet.":"No protocol events yet."}</div>}
      </div>
    </div>
  );
}

// ── Agent Dossier ──────────────────────────────────────────────────────────────
export function AgentDossier({ id, onSelectAgreement, onPropose }: {
  id: string; onSelectAgreement: (id: number) => void; onPropose: (to?: string, from?: string) => void;
}) {
  const { world, statusOf, claim, withdraw } = useArcWorld();
  const a = world.nodes.find(x => x.id===id);
  if (!a) return null;
  const st      = statusOf(a.id);
  const biome   = BIOME_BY_ARCHETYPE[a.archetype];
  const agreements = E.agreementsOf(world, a.id).filter(c => c.status==="active"||c.status==="proposed");
  const locked  = E.r2(agreements.reduce((s,c) => s+(c.partyA===a.id?c.bondA+c.callBudget:c.bondB), 0));
  const history = world.disputes.filter(d => d.plaintiff===a.id||d.defendant===a.id).slice(0,4);
  const mine    = a.owner==="you";
  const haveNode = world.nodes.some(x => x.owner==="you"&&x.status==="active");

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border border-white/10"
          style={{ background:`linear-gradient(135deg,${biome.accent}55,${biome.base})` }}>
          <Cpu className="w-5 h-5 text-[#f9faf3]" />
        </div>
        <div className="min-w-0">
          <div className="font-semibold truncate text-[#f9faf3]">{a.name}</div>
          <div className="text-[11px] text-[#94a3b8]">{a.archetype}{a.capability?` · sells ${a.capability} at ${a.price} USDC/call`:" · no endpoint"}</div>
          <div className="text-[10px] font-semibold tracking-widest mt-0.5" style={{ color: STATUS_COLOR[st] }}>
            {STATUS_LABEL[st]}{mine?" · YOURS":a.owner==="autonomous"?" · AUTONOMOUS":""}
          </div>
        </div>
      </div>
      <p className="text-xs text-[#94a3b8] italic leading-relaxed">&ldquo;{a.charter}&rdquo;</p>
      <div className="space-y-1">
        <div className="flex justify-between text-[11px]"><span className="text-[#94a3b8]">Reputation</span><span className="font-mono text-[#f9faf3]">{a.reputation}/100</span></div>
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div className="h-full rounded-full" style={{ width:`${a.reputation}%`, background:"linear-gradient(90deg,#5b8fbd,#acc6e9)" }} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-center">
        {[["Collateral",a.collateral],["Treasury",a.treasury],["Locked",locked],["Claimable",a.claimable]].map(([k,v]) => (
          <div key={k as string} className="rounded-lg bg-white/[0.04] py-2">
            <div className="text-sm font-semibold font-mono text-[#f9faf3]">{(v as number).toFixed(2)}</div>
            <div className="text-[10px] text-[#64748b]">{k as string}</div>
          </div>
        ))}
      </div>
      {mine && (
        <div className="flex gap-2 flex-wrap">
          <button className={clsx(btnPrimary,"text-xs px-3 py-1.5")} disabled={a.claimable<=0} onClick={() => claim(a.id)}>
            <Coins className="w-3.5 h-3.5" />Claim {a.claimable||""}
          </button>
          <button className={clsx(btnGhost,"text-xs px-3 py-1.5")} disabled={a.treasury<=0} onClick={() => withdraw(a.id, a.treasury)}>Withdraw</button>
          <button className={clsx(btnGhost,"text-xs px-3 py-1.5")} onClick={() => onPropose(undefined, a.id)}>Propose</button>
        </div>
      )}
      {!mine && a.status==="active" && (
        <button className={clsx(btnPrimary,"text-xs px-3 py-1.5 w-full")} onClick={() => onPropose(a.id)}>
          {haveNode?`Propose to ${a.name}`:"Register an agent first"}
        </button>
      )}
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold tracking-widest text-[#64748b]">AGREEMENTS</div>
        {agreements.length===0&&<div className="text-xs text-[#64748b]">No live agreements.</div>}
        {agreements.map(c => {
          const other = world.nodes.find(x => x.id===(c.partyA===a.id?c.partyB:c.partyA));
          return (
            <button key={c.id} onClick={() => onSelectAgreement(c.id)}
              className="w-full text-left rounded-lg bg-white/[0.03] hover:bg-white/[0.06] px-2.5 py-2 text-xs flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: KIND_COLOR[c.kind] }} />
              <span className="flex-1 min-w-0 truncate">#{c.id} {E.KIND_LABEL[c.kind]} {c.partyA===a.id?"→":"←"} {other?.name}</span>
              <span className={clsx("px-1.5 py-0.5 rounded text-[10px]",STATUS_PILL[c.status])}>{c.status}</span>
            </button>
          );
        })}
      </div>
      {history.length>0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold tracking-widest text-[#64748b]">DISPUTE RECORD</div>
          {history.map(d => (
            <div key={d.id} className="rounded-lg border border-[rgba(172,198,233,0.12)] px-2.5 py-1.5 text-[11px] text-[#94a3b8]">
              {E.TIER_LABEL[d.tier]} · {d.plaintiff===a.id?"as plaintiff":"as defendant"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Agreement Inspector ────────────────────────────────────────────────────────
export function AgreementInspector({ id, onSelectAgent, onDispute }: {
  id: number; onSelectAgent: (id: string) => void; onDispute: (id: number) => void;
}) {
  const { world, now, busyContracts, pendingDisputes, ratify, reject, cancel, exit, invoke } = useArcWorld();
  const [rejectNote, setRejectNote] = useState<string|null>(null);
  const c = world.agreements.find(x => x.id===id);
  if (!c) return null;
  const a = world.nodes.find(n => n.id===c.partyA)!;
  const b = world.nodes.find(n => n.id===c.partyB)!;
  if (!a||!b) return null;
  const aMine=a.owner==="you", bMine=b.owner==="you";
  const bps    = E.defendantMetricBps(c, c.partyB);
  const failed = c.calls.filter(x => !x.ok).length;
  const busy   = busyContracts.has(c.id);
  const underReview = pendingDisputes.has(c.id);
  const disputes = world.disputes.filter(d => d.agreementId===c.id);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ScrollText className="w-4 h-4" style={{ color: KIND_COLOR[c.kind] }} />
        <span className="font-semibold text-[#f9faf3]">Agreement #{c.id} · {E.KIND_LABEL[c.kind]}</span>
        <span className={clsx("ml-auto px-1.5 py-0.5 rounded text-[10px]",STATUS_PILL[c.status])}>{c.status}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {([[a,c.bondA,c.kind==="SERVICE"?"hires":"party_a"],[b,c.bondB,c.kind==="SERVICE"?"serves":"party_b"]] as [E.AgentNode,number,string][]).map(([ag,bond,role]) => (
          <button key={ag.id} onClick={() => onSelectAgent(ag.id)} className="rounded-lg bg-white/[0.04] hover:bg-white/[0.07] p-2 text-left">
            <div className="text-[10px] text-[#64748b]">{role}</div>
            <div className="font-medium truncate text-[#f9faf3]">{ag.name}{ag.owner==="you"&&<span className="text-[#acc6e9]"> ◆</span>}</div>
            <div className="text-[#94a3b8] font-mono">{bond.toFixed(2)} USDC bonded</div>
          </button>
        ))}
      </div>
      <div className="text-xs text-[#94a3b8] bg-white/[0.03] rounded-lg p-2.5 leading-relaxed">&ldquo;{c.terms}&rdquo;</div>
      <div className="text-[11px] text-[#94a3b8] space-y-0.5">
        {c.status==="active"&&c.expiresAt&&<div>Expires in {remaining(c.expiresAt-now)}</div>}
        {c.status==="proposed"&&<div>Proposed {timeAgo(c.proposedAt)}, awaiting {b.name}</div>}
        {c.kind==="SERVICE"&&<div>{c.feePerCall} USDC per call · {c.callBudget.toFixed(2)} budget ({Math.floor(c.callBudget/(c.feePerCall||1))} calls)</div>}
        {c.decisionNote&&<div className="text-[#64748b]">Decision: {c.decisionNote}</div>}
      </div>
      {c.kind==="SERVICE"&&(
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold tracking-widest text-[#64748b]">SERVICE RECORD</span>
            <span className="text-[#94a3b8]">{failed}/{c.calls.length} failed{bps!==null?` · ${bps} bps`:""}</span>
          </div>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {c.calls.slice().reverse().map((call, i) => (
              <div key={i} className="text-[10px] font-mono bg-white/[0.03] rounded px-2 py-1 flex gap-2">
                <span className={call.ok?"text-[#8dd89f]":"text-[#e86d7a]"}>{call.ok?"OK ":"ERR"}</span>
                <span className="text-[#94a3b8] truncate flex-1">{call.output}</span>
                <span className="text-[#64748b] shrink-0">{call.ms}ms</span>
              </div>
            ))}
            {c.calls.length===0&&<div className="text-[11px] text-[#64748b]">No calls yet.</div>}
          </div>
        </div>
      )}
      {underReview&&(
        <ol className="flex items-center gap-2 text-[11px] bg-[rgba(172,198,233,0.06)] border border-[rgba(172,198,233,0.2)] rounded-lg px-3 py-2">
          <li className="flex items-center gap-1.5 text-[#acc6e9]"><Check className="w-3 h-3" />Filed</li>
          <li className="h-px flex-1 bg-[rgba(172,198,233,0.2)]" />
          <li className="flex items-center gap-1.5 text-[#cbdbf2] font-medium"><Loader2 className="w-3 h-3 animate-spin" />Validators</li>
          <li className="h-px flex-1 bg-white/10" />
          <li className="text-[#64748b]">Verdict</li>
        </ol>
      )}
      <div className="flex gap-2 flex-wrap">
        {c.status==="proposed"&&bMine&&rejectNote===null&&<>
          <button className={clsx(btnPrimary,"text-xs px-3 py-1.5")} onClick={() => ratify(c.id)}><Check className="w-3.5 h-3.5" />Ratify</button>
          <button className={clsx(btnGhost,"text-xs px-3 py-1.5")} onClick={() => setRejectNote("")}><X className="w-3.5 h-3.5" />Reject</button>
        </>}
        {c.status==="proposed"&&bMine&&rejectNote!==null&&(
          <div className="w-full flex gap-2">
            <input autoFocus className="field-input flex-1 text-xs py-1" placeholder="Why?" value={rejectNote} onChange={e=>setRejectNote(e.target.value)} />
            <button className={clsx(btnGhost,"text-xs px-3 py-1")} onClick={() => { reject(c.id,rejectNote||"declined"); setRejectNote(null); }}>Send</button>
          </div>
        )}
        {c.status==="proposed"&&aMine&&<button className={clsx(btnGhost,"text-xs px-3 py-1.5")} onClick={()=>cancel(c.id)}><Undo2 className="w-3.5 h-3.5" />Withdraw</button>}
        {c.status==="active"&&aMine&&c.kind==="SERVICE"&&(
          <button className={clsx(btnPrimary,"text-xs px-3 py-1.5")} disabled={busy||!E.canInvoke(c)} onClick={()=>invoke(c.id)}>
            {busy?<Loader2 className="w-3.5 h-3.5 animate-spin" />:<Zap className="w-3.5 h-3.5" />}Call {b.name}
          </button>
        )}
        {c.status==="active"&&(aMine||bMine)&&!underReview&&(
          <button className={clsx(btnGhost,"text-xs px-3 py-1.5 hover:text-[#e86d7a]")} onClick={()=>onDispute(c.id)}><Gavel className="w-3.5 h-3.5" />Dispute</button>
        )}
        {c.status==="active"&&(aMine||bMine)&&(
          <button className={clsx(btnGhost,"text-xs px-3 py-1.5")} onClick={()=>exit(c.id,aMine?a.id:b.id)}><LogOut className="w-3.5 h-3.5" />Exit</button>
        )}
        {!aMine&&!bMine&&(c.status==="active"||c.status==="proposed")&&(
          <div className="text-[11px] text-[#64748b] flex items-center gap-1.5"><Radio className="w-3 h-3" />Autonomous agreement.</div>
        )}
      </div>
      {disputes.length>0&&(
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold tracking-widest text-[#64748b]">DISPUTES</div>
          {disputes.map(d=>(
            <div key={d.id} className="rounded-lg border border-[rgba(172,198,233,0.12)] px-2.5 py-2 text-[11px] space-y-0.5 text-[#94a3b8]">
              <div className="font-medium text-[#f9faf3]">{E.TIER_LABEL[d.tier]} · {d.by}</div>
              <div className="opacity-80">{d.settlement}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
