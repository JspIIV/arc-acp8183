// Arc A2A Protocol engine: sovereign agents ("nodes") post USDC collateral,
// sign bonded agreements with each other, hire each other through service
// agreements, and settle breaches through a four-tier Arc arbiter verdict.
//
// Ported from the Westphalia protocol (MIT). Ground changed: escrow is USDC
// on Arc instead of RIALO on Rialo. Amounts scaled for a testnet wallet.

export type Archetype = "Autonomous Arbiter" | "Liquidity Nexus" | "Oracle Collective" | "Defense Vanguard";
export const ARCHETYPES: Archetype[] = ["Autonomous Arbiter", "Liquidity Nexus", "Oracle Collective", "Defense Vanguard"];

export type NodeStatus    = "active" | "sanctioned";
export type AgreementKind = "SERVICE" | "DATA_SHARING" | "NON_AGGRESSION";
export const AGREEMENT_KINDS: AgreementKind[] = ["SERVICE", "DATA_SHARING", "NON_AGGRESSION"];
export type AgreementStatus = "proposed" | "active" | "settled" | "expired" | "cancelled" | "rejected";
export type Tier = "CRITICAL_BREACH" | "ELEVATED_RISK" | "NORMAL" | "MALICIOUS_REPORT";
export const TIERS: Tier[] = ["CRITICAL_BREACH", "ELEVATED_RISK", "NORMAL", "MALICIOUS_REPORT"];

export const KIND_LABEL: Record<AgreementKind, string> = {
  SERVICE:        "Service agreement",
  DATA_SHARING:   "Data sharing",
  NON_AGGRESSION: "Non-aggression",
};

export const TIER_LABEL: Record<Tier, string> = {
  CRITICAL_BREACH:  "Critical breach",
  ELEVATED_RISK:    "Elevated risk",
  NORMAL:           "Normal",
  MALICIOUS_REPORT: "Malicious report",
};

// --- Protocol constants -------------------------------------------------------
export const MIN_NODE_COLLATERAL   = 100;
export const MIN_DISPUTE_BOND      = 50;
export const VALIDATION_FEE        = 0.5;
export const MAX_UNTRUSTED_BOND    = 200;
export const HIGH_BOND_THRESHOLD   = 500;
export const NODE_MATURATION_MS    = 5 * 60_000;
export const DISPUTE_COOLDOWN_MS   = 60_000;
export const MIN_AGREEMENT_DURATION_MS = 60_000;
export const MAX_AGREEMENT_DURATION_MS = 24 * 3600_000;
export const EXIT_PENALTY_BPS      = 1000;
export const MIN_REP_THROUGHPUT    = 10;

export const REP_SEED           = 50;
export const REP_REWARD_CRITICAL = 15;
export const REP_DEBIT_ELEVATED  = 10;
export const REP_DEBIT_MALICIOUS = 20;

export const BPS_CRITICAL    = 7500;
export const BPS_ELEVATED    = 2500;
export const BPS_NEGLIGIBLE  = 500;
export const MIN_CALLS_FOR_METRIC = 3;

// --- Types --------------------------------------------------------------------
export interface AgentNode {
  id:          string;
  name:        string;
  archetype:   Archetype;
  charter:     string;
  owner:       "you" | "autonomous";
  agentId?:    number;
  endpoint?:   string;
  capability?: string;
  price?:      number;
  collateral:  number;   // USDC locked
  treasury:    number;   // liquid USDC
  claimable:   number;
  reputation:  number;   // 0-100
  status:      NodeStatus;
  foundedAt:   number;
  seed:        number;
}

export interface ServiceCall {
  ts:     number;
  ok:     boolean;
  ms:     number;
  fee:    number;
  input:  string;
  output: string;
}

export interface Agreement {
  id:             number;
  kind:           AgreementKind;
  terms:          string;
  partyA:         string;
  partyB:         string;
  bondA:          number;
  bondB:          number;
  feePerCall:     number;
  callBudget:     number;
  calls:          ServiceCall[];
  durationMs:     number;
  proposedAt:     number;
  activatedAt?:   number;
  expiresAt?:     number;
  status:         AgreementStatus;
  elevatedSlashedA: boolean;
  elevatedSlashedB: boolean;
  lastDisputeAt?: number;
  decisionNote?:  string;
}

export type VerdictSource = "Arc AI Arbiter" | "Arc Arbiter" | "local rule";

export interface DisputeRecord {
  id:           number;
  agreementId:  number;
  plaintiff:    string;
  defendant:    string;
  allegation:   string;
  evidenceUri:  string;
  bond:         number;
  metricBps:    number | null;
  tier:         Tier;
  rationale:    string;
  by:           VerdictSource;
  txHash?:      string;
  ts:           number;
  settlement:   string;
}

export type LedgerKind =
  | "node-founded" | "agreement-proposed" | "agreement-signed"
  | "agreement-rejected" | "agreement-closed"
  | "service-call" | "dispute-opened" | "verdict" | "escrow-released" | "sanction";

export interface LedgerEvent {
  id:   number;
  ts:   number;
  kind: LedgerKind;
  text: string;
}

export interface World {
  nodes:          AgentNode[];
  agreements:     Agreement[];
  disputes:       DisputeRecord[];
  ledger:         LedgerEvent[];
  reserves:       number;
  replay:         string[];
  nextAgreementId: number;
  nextDisputeId:  number;
  nextEventId:    number;
}

export class ProtocolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// --- Helpers ------------------------------------------------------------------
export const r2 = (n: number) => Math.round(n * 100) / 100;
const clampRep = (n: number) => Math.max(0, Math.min(100, n));

export function nodeById(w: World, id: string): AgentNode {
  const n = w.nodes.find(x => x.id === id);
  if (!n) throw new ProtocolError("ERR_STATE", `unknown node ${id}`);
  return n;
}

export function agreementById(w: World, id: number): Agreement {
  const a = w.agreements.find(x => x.id === id);
  if (!a) throw new ProtocolError("ERR_STATE", `unknown agreement #${id}`);
  return a;
}

function patchNode(w: World, id: string, f: (n: AgentNode) => AgentNode): World {
  return { ...w, nodes: w.nodes.map(n => n.id === id ? f(n) : n) };
}
function patchAgreement(w: World, id: number, f: (a: Agreement) => Agreement): World {
  return { ...w, agreements: w.agreements.map(a => a.id === id ? f(a) : a) };
}
function credit(w: World, id: string, amount: number): World {
  if (amount <= 0) return w;
  return patchNode(w, id, n => ({ ...n, claimable: r2(n.claimable + amount) }));
}
function debitTreasury(w: World, id: string, amount: number, what: string): World {
  const n = nodeById(w, id);
  if (n.treasury + 1e-9 < amount)
    throw new ProtocolError("ERR_INSUFFICIENT_BOND", `${n.name} needs ${r2(amount)} USDC for ${what} but holds ${n.treasury}`);
  return patchNode(w, id, x => ({ ...x, treasury: r2(x.treasury - amount) }));
}
function repDelta(w: World, id: string, delta: number): World {
  return patchNode(w, id, n => ({ ...n, reputation: clampRep(n.reputation + delta) }));
}

export function log(w: World, ts: number, kind: LedgerKind, text: string): World {
  return { ...w, nextEventId: w.nextEventId + 1, ledger: [{ id: w.nextEventId, ts, kind, text }, ...w.ledger].slice(0, 80) };
}

function requireActiveNode(n: AgentNode) {
  if (n.status !== "active") throw new ProtocolError("ERR_STATE", `${n.name} is sanctioned`);
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function emptyWorld(): World {
  return { nodes: [], agreements: [], disputes: [], ledger: [], reserves: 0, replay: [], nextAgreementId: 1, nextDisputeId: 1, nextEventId: 1 };
}

// --- Nodes --------------------------------------------------------------------
export interface FoundInput {
  name: string; archetype: Archetype; charter: string;
  collateral: number; treasury: number; owner: AgentNode["owner"];
  agentId?: number; endpoint?: string; capability?: string; price?: number;
}

export function foundNode(w: World, input: FoundInput, now: number): World {
  const name = input.name.trim();
  if (!name) throw new ProtocolError("ERR_STATE", "a node needs a name");
  if (input.collateral < MIN_NODE_COLLATERAL)
    throw new ProtocolError("ERR_INSUFFICIENT_BOND", `collateral must be at least ${MIN_NODE_COLLATERAL} USDC`);
  if (input.agentId !== undefined && w.nodes.some(n => n.agentId === input.agentId))
    throw new ProtocolError("ERR_STATE", "that agent already governs a node");
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
  let id = base;
  for (let i = 2; w.nodes.some(n => n.id === id); i++) id = `${base}-${i}`;
  const node: AgentNode = {
    id, name, archetype: input.archetype, charter: input.charter.trim(), owner: input.owner,
    agentId: input.agentId, endpoint: input.endpoint, capability: input.capability, price: input.price,
    collateral: r2(input.collateral), treasury: r2(input.treasury), claimable: 0,
    reputation: REP_SEED, status: "active", foundedAt: now, seed: hashStr(id) % 100000,
  };
  return log({ ...w, nodes: [...w.nodes, node] }, now, "node-founded",
    `${name} joined the Arc network (${input.archetype}) with ${node.collateral} USDC collateral`);
}

export function claim(w: World, id: string, now: number): World {
  const n = nodeById(w, id);
  if (n.claimable <= 0) throw new ProtocolError("ERR_NO_CLAIMABLE_BALANCE", `${n.name} has nothing to claim`);
  const next = patchNode(w, id, x => ({ ...x, treasury: r2(x.treasury + x.claimable), claimable: 0 }));
  return log(next, now, "escrow-released", `${n.name} claimed ${n.claimable} USDC from Arc Escrow`);
}

// --- Agreements ---------------------------------------------------------------
export interface ProposeInput {
  proposer: string; counterparty: string; kind: AgreementKind;
  terms: string; bond: number; durationMs: number; feePerCall?: number; maxCalls?: number;
}

export function proposeAgreement(w: World, input: ProposeInput, now: number): World {
  const a = nodeById(w, input.proposer), b = nodeById(w, input.counterparty);
  requireActiveNode(a); requireActiveNode(b);
  if (a.id === b.id) throw new ProtocolError("ERR_INVALID_PARAMS", "a node cannot agree with itself");
  if (!input.terms.trim()) throw new ProtocolError("ERR_INVALID_PARAMS", "an agreement needs written terms");
  if (!(input.bond > 0)) throw new ProtocolError("ERR_INSUFFICIENT_BOND", "bond must be positive");
  if (input.durationMs < MIN_AGREEMENT_DURATION_MS || input.durationMs > MAX_AGREEMENT_DURATION_MS)
    throw new ProtocolError("ERR_INVALID_PARAMS", "duration must be 1 min – 24 h");
  if (a.reputation < 30 && input.bond > MAX_UNTRUSTED_BOND)
    throw new ProtocolError("ERR_UNTRUSTED_BOND_CAP", `reputation ${a.reputation} caps bond at ${MAX_UNTRUSTED_BOND} USDC`);
  if (input.bond > HIGH_BOND_THRESHOLD && now - a.foundedAt < NODE_MATURATION_MS)
    throw new ProtocolError("ERR_NODE_NOT_MATURED", `bonds above ${HIGH_BOND_THRESHOLD} USDC need a node older than 5 min`);

  let feePerCall = 0, callBudget = 0;
  if (input.kind === "SERVICE") {
    if (!b.endpoint) throw new ProtocolError("ERR_INVALID_PARAMS", `${b.name} has no endpoint`);
    feePerCall = r2(input.feePerCall ?? 0);
    const maxCalls = Math.floor(input.maxCalls ?? 0);
    if (feePerCall <= 0 || maxCalls < 1) throw new ProtocolError("ERR_INVALID_PARAMS", "service agreement needs fee and call count");
    callBudget = r2(feePerCall * maxCalls);
  }
  const bond = r2(input.bond);
  let next = debitTreasury(w, a.id, bond + callBudget, callBudget ? "bond + prepaid calls" : "bond");
  const ag: Agreement = {
    id: w.nextAgreementId, kind: input.kind, terms: input.terms.trim(), partyA: a.id, partyB: b.id,
    bondA: bond, bondB: 0, feePerCall, callBudget, calls: [], durationMs: input.durationMs,
    proposedAt: now, status: "proposed", elevatedSlashedA: false, elevatedSlashedB: false,
  };
  next = { ...next, agreements: [ag, ...next.agreements], nextAgreementId: w.nextAgreementId + 1 };
  const extra = callBudget ? ` and prepaid ${callBudget} USDC for calls` : "";
  return log(next, now, "agreement-proposed", `${a.name} proposed ${KIND_LABEL[input.kind].toLowerCase()} to ${b.name}, bonding ${bond} USDC${extra}`);
}

export function ratifyAgreement(w: World, id: number, by: string, now: number, note?: string): World {
  const ag = agreementById(w, id);
  if (ag.status !== "proposed") throw new ProtocolError("ERR_INVALID_STATE", `agreement #${id} is not awaiting ratification`);
  if (by !== ag.partyB) throw new ProtocolError("ERR_UNAUTHORIZED", "only the counterparty can ratify");
  const b = nodeById(w, by);
  requireActiveNode(b); requireActiveNode(nodeById(w, ag.partyA));
  let next = debitTreasury(w, by, ag.bondA, "matching bond");
  next = patchAgreement(next, id, x => ({ ...x, bondB: ag.bondA, status: "active", activatedAt: now, expiresAt: now + ag.durationMs, decisionNote: note }));
  return log(next, now, "agreement-signed", `${b.name} ratified agreement #${id} with ${nodeById(w, ag.partyA).name}, matching ${ag.bondA} USDC bond`);
}

export function rejectAgreement(w: World, id: number, by: string, now: number, note: string): World {
  const ag = agreementById(w, id);
  if (ag.status !== "proposed") throw new ProtocolError("ERR_INVALID_STATE", `agreement #${id} not pending`);
  if (by !== ag.partyB) throw new ProtocolError("ERR_UNAUTHORIZED", "only counterparty can reject");
  let next = credit(w, ag.partyA, r2(ag.bondA + ag.callBudget));
  next = patchAgreement(next, id, x => ({ ...x, status: "rejected", bondA: 0, callBudget: 0, decisionNote: note }));
  return log(next, now, "agreement-rejected", `${nodeById(w, by).name} rejected agreement #${id}: ${note}`);
}

export function cancelProposal(w: World, id: number, by: string, now: number): World {
  const ag = agreementById(w, id);
  if (ag.status !== "proposed") throw new ProtocolError("ERR_INVALID_STATE", `agreement #${id} not a pending proposal`);
  if (by !== ag.partyA) throw new ProtocolError("ERR_UNAUTHORIZED", "only proposer can cancel");
  let next = credit(w, ag.partyA, r2(ag.bondA + ag.callBudget));
  next = patchAgreement(next, id, x => ({ ...x, status: "cancelled", bondA: 0, callBudget: 0 }));
  return log(next, now, "agreement-closed", `${nodeById(w, by).name} withdrew proposal #${id}; escrow returned`);
}

export function exitAgreement(w: World, id: number, by: string, now: number): World {
  const ag = agreementById(w, id);
  if (ag.status !== "active") throw new ProtocolError("ERR_NOT_ACTIVE", `agreement #${id} not active`);
  if (by !== ag.partyA && by !== ag.partyB) throw new ProtocolError("ERR_UNAUTHORIZED", "only a party can exit");
  const ownBond = by === ag.partyA ? ag.bondA : ag.bondB;
  const penalty = r2((ownBond * EXIT_PENALTY_BPS) / 10000);
  let next: World = { ...w, reserves: r2(w.reserves + penalty) };
  next = credit(next, ag.partyA, r2((by === ag.partyA ? ag.bondA - penalty : ag.bondA) + ag.callBudget));
  next = credit(next, ag.partyB, r2(by === ag.partyB ? ag.bondB - penalty : ag.bondB));
  next = patchAgreement(next, id, x => ({ ...x, status: "settled", bondA: 0, bondB: 0, callBudget: 0 }));
  return log(next, now, "agreement-closed", `${nodeById(w, by).name} exited agreement #${id}, forfeiting ${penalty} USDC to reserves`);
}

export function expireAgreements(w: World, now: number): World {
  let next = w;
  for (const ag of w.agreements) {
    if (ag.status !== "active" || !ag.expiresAt || ag.expiresAt > now) continue;
    next = credit(next, ag.partyA, r2(ag.bondA + ag.callBudget));
    next = credit(next, ag.partyB, ag.bondB);
    next = patchAgreement(next, ag.id, x => ({ ...x, status: "expired", bondA: 0, bondB: 0, callBudget: 0 }));
    next = log(next, now, "agreement-closed", `Agreement #${ag.id} expired; ${r2(ag.bondA + ag.bondB)} USDC released`);
  }
  return next;
}

// --- Service calls ------------------------------------------------------------
export function canInvoke(ag: Agreement): boolean {
  return ag.kind === "SERVICE" && ag.status === "active" && ag.callBudget + 1e-9 >= ag.feePerCall;
}

export function recordServiceCall(w: World, id: number, call: Omit<ServiceCall, "fee">, now: number): World {
  const ag = agreementById(w, id);
  if (!canInvoke(ag)) throw new ProtocolError("ERR_NOT_ACTIVE", `agreement #${id} cannot take calls`);
  const fee = call.ok ? ag.feePerCall : 0;
  let next = credit(w, ag.partyB, fee);
  next = patchAgreement(next, id, x => ({ ...x, callBudget: r2(x.callBudget - fee), calls: [...x.calls, { ...call, fee }].slice(-30) }));
  const a = nodeById(w, ag.partyA).name, b = nodeById(w, ag.partyB).name;
  return log(next, now, "service-call", call.ok
    ? `${a} called ${b} under agreement #${id} (${call.ms}ms) · ${fee} USDC paid`
    : `${a} called ${b} under agreement #${id} — FAILED · nothing paid`);
}

export function defendantMetricBps(ag: Agreement, defendant: string): number | null {
  if (ag.kind !== "SERVICE") return null;
  if (defendant === ag.partyA) return 0;
  if (ag.calls.length < MIN_CALLS_FOR_METRIC) return null;
  const failed = ag.calls.filter(c => !c.ok).length;
  return Math.round((failed / ag.calls.length) * 10000);
}

// --- Disputes -----------------------------------------------------------------
export function requiredDisputeBond(reputation: number): number {
  return r2((MIN_DISPUTE_BOND * (150 - Math.min(reputation, 100))) / 100);
}

export interface DisputeCase {
  agreement:    Agreement;
  plaintiff:    AgentNode;
  defendant:    AgentNode;
  defendantRole: "party_a" | "party_b";
  bond:         number;
  metricBps:    number | null;
  replayKey:    string;
}

export function prepareDispute(w: World, agreementId: number, plaintiffId: string, allegation: string, now: number): DisputeCase {
  const ag = agreementById(w, agreementId);
  if (ag.status !== "active") throw new ProtocolError("ERR_NOT_ACTIVE", `agreement #${agreementId} not active`);
  if (plaintiffId !== ag.partyA && plaintiffId !== ag.partyB) throw new ProtocolError("ERR_UNAUTHORIZED", "only a party can file");
  const plaintiff = nodeById(w, plaintiffId);
  requireActiveNode(plaintiff);
  if (ag.expiresAt && now >= ag.expiresAt) throw new ProtocolError("ERR_NOT_ACTIVE", "the agreement has expired");
  if (!allegation.trim()) throw new ProtocolError("ERR_EMPTY_EVIDENCE", "a dispute needs an allegation");
  const bond = requiredDisputeBond(plaintiff.reputation);
  if (plaintiff.treasury + 1e-9 < bond)
    throw new ProtocolError("ERR_INSUFFICIENT_BOND", `${plaintiff.name} needs ${bond} USDC to file`);
  const replayKey = `${agreementId}|${plaintiffId}|${hashStr(allegation.trim().toLowerCase())}`;
  if (w.replay.includes(replayKey)) throw new ProtocolError("ERR_REPLAY", "this exact filing was already adjudicated");
  if (ag.lastDisputeAt && now - ag.lastDisputeAt < DISPUTE_COOLDOWN_MS)
    throw new ProtocolError("ERR_COOLDOWN", "one dispute per minute per agreement");
  const defendantId = plaintiffId === ag.partyA ? ag.partyB : ag.partyA;
  return {
    agreement: ag, plaintiff, defendant: nodeById(w, defendantId),
    defendantRole: defendantId === ag.partyA ? "party_a" : "party_b",
    bond, metricBps: defendantMetricBps(ag, defendantId), replayKey,
  };
}

export function clampTier(tier: Tier, bps: number | null, evidencePresent: boolean): Tier {
  if (bps === null) { if (tier === "CRITICAL_BREACH" && !evidencePresent) return "ELEVATED_RISK"; return tier; }
  if (bps >= BPS_ELEVATED && tier === "MALICIOUS_REPORT") return "NORMAL";
  if (bps < BPS_NEGLIGIBLE && (tier === "CRITICAL_BREACH" || tier === "ELEVATED_RISK")) return "NORMAL";
  if (bps < BPS_ELEVATED && tier === "CRITICAL_BREACH") return evidencePresent ? "ELEVATED_RISK" : "NORMAL";
  return tier;
}

export function localArbiter(bps: number | null, evidencePresent: boolean): { tier: Tier; rationale: string } {
  if (bps === null) return evidencePresent
    ? { tier: "ELEVATED_RISK", rationale: "No objective metric exists; evidence supports a partial finding." }
    : { tier: "NORMAL", rationale: "No metric and no evidence; allegation is unproven." };
  if (bps >= BPS_CRITICAL)  return { tier: "CRITICAL_BREACH", rationale: `Defendant failed ${bps / 100}% of calls: clear and unexcused breach.` };
  if (bps >= BPS_ELEVATED)  return { tier: "ELEVATED_RISK",   rationale: `Defendant failed ${bps / 100}% of calls: measurable deviation.` };
  if (bps >= BPS_NEGLIGIBLE) return { tier: "NORMAL",         rationale: `A ${bps / 100}% failure rate is within acceptable variance.` };
  return evidencePresent
    ? { tier: "NORMAL",         rationale: `Defendant served ${100 - bps / 100}% successfully; evidence insufficient.` }
    : { tier: "MALICIOUS_REPORT", rationale: `Defendant served ${100 - bps / 100}% successfully; no evidence: frivolous filing.` };
}

export function settleDispute(
  w: World,
  c: DisputeCase,
  verdict: { tier: Tier; rationale: string; by: VerdictSource; txHash?: string; allegation: string; evidenceUri: string },
  now: number,
): World {
  const ag = agreementById(w, c.agreement.id);
  const plaintiff = c.plaintiff.id, defendant = c.defendant.id;
  const plaintiffIsA = plaintiff === ag.partyA;
  const defendantBond = plaintiffIsA ? ag.bondB : ag.bondA;
  const plaintiffBond = plaintiffIsA ? ag.bondA : ag.bondB;
  let next = debitTreasury(w, plaintiff, c.bond, "dispute bond");
  next = { ...next, replay: [...next.replay, c.replayKey] };
  const fee = Math.min(VALIDATION_FEE, c.bond);
  let settlement: string;

  switch (verdict.tier) {
    case "CRITICAL_BREACH": {
      next = credit(next, plaintiff, r2(defendantBond + plaintiffBond + c.bond));
      next = credit(next, ag.partyA, ag.callBudget);
      next = patchNode(next, defendant, n => ({ ...n, status: "sanctioned" }));
      if (defendantBond >= MIN_REP_THROUGHPUT) next = repDelta(next, plaintiff, REP_REWARD_CRITICAL);
      next = patchAgreement(next, ag.id, x => ({ ...x, bondA: 0, bondB: 0, callBudget: 0, status: "settled" }));
      settlement = `${defendantBond} USDC slashed to ${c.plaintiff.name}; ${c.defendant.name} sanctioned; agreement settled`;
      next = log(next, now, "sanction", `${c.defendant.name} SANCTIONED for critical breach of agreement #${ag.id}`);
      break;
    }
    case "ELEVATED_RISK": {
      const defendantIsB = plaintiffIsA;
      const alreadySlashed = defendantIsB ? ag.elevatedSlashedB : ag.elevatedSlashedA;
      next = { ...next, reserves: r2(next.reserves + fee) };
      next = credit(next, plaintiff, r2(c.bond - fee));
      if (alreadySlashed) {
        next = credit(next, ag.partyA, r2(ag.bondA + ag.callBudget));
        next = credit(next, ag.partyB, ag.bondB);
        next = patchAgreement(next, ag.id, x => ({ ...x, bondA: 0, bondB: 0, callBudget: 0, status: "settled" }));
        settlement = "second elevated verdict: agreement settled, bonds returned";
      } else {
        const slash = r2((defendantBond * 25) / 100);
        next = { ...next, reserves: r2(next.reserves + slash) };
        next = patchAgreement(next, ag.id, x => defendantIsB
          ? { ...x, bondB: r2(x.bondB - slash), elevatedSlashedB: true }
          : { ...x, bondA: r2(x.bondA - slash), elevatedSlashedA: true });
        next = repDelta(next, defendant, -REP_DEBIT_ELEVATED);
        settlement = `25% of ${c.defendant.name}'s bond (${slash} USDC) slashed to reserves; agreement active`;
      }
      break;
    }
    case "NORMAL": {
      next = { ...next, reserves: r2(next.reserves + fee) };
      next = credit(next, plaintiff, r2(c.bond - fee));
      settlement = `dismissed; bond returned minus ${fee} USDC validation fee`;
      break;
    }
    case "MALICIOUS_REPORT": {
      next = { ...next, reserves: r2(next.reserves + c.bond) };
      next = repDelta(next, plaintiff, -REP_DEBIT_MALICIOUS);
      settlement = `frivolous: ${c.plaintiff.name}'s ${c.bond} USDC bond forfeited`;
      break;
    }
  }

  next = patchAgreement(next, ag.id, x => ({ ...x, lastDisputeAt: now }));
  const record: DisputeRecord = {
    id: next.nextDisputeId, agreementId: ag.id, plaintiff, defendant,
    allegation: verdict.allegation, evidenceUri: verdict.evidenceUri, bond: c.bond, metricBps: c.metricBps,
    tier: verdict.tier, rationale: verdict.rationale, by: verdict.by, txHash: verdict.txHash, ts: now, settlement,
  };
  next = { ...next, disputes: [record, ...next.disputes], nextDisputeId: next.nextDisputeId + 1 };
  return log(next, now, "verdict", `Arc Arbiter ruled ${verdict.tier} on agreement #${ag.id}: ${settlement}`);
}

// --- Autonomous agents --------------------------------------------------------
export const KINDS_BY_ARCHETYPE: Record<Archetype, AgreementKind[]> = {
  "Oracle Collective":  ["DATA_SHARING", "SERVICE"],
  "Liquidity Nexus":    ["SERVICE", "DATA_SHARING"],
  "Autonomous Arbiter": ["SERVICE", "NON_AGGRESSION"],
  "Defense Vanguard":   ["NON_AGGRESSION", "SERVICE"],
};

export interface Evaluation { accept: boolean; score: number; reasons: string[] }

export function evaluateProposal(w: World, ag: Agreement, evaluatorId: string): Evaluation {
  const me = nodeById(w, evaluatorId), peer = nodeById(w, ag.partyA);
  const reasons: string[] = [];
  let hardFail = false;
  if (!KINDS_BY_ARCHETYPE[me.archetype].includes(ag.kind))
    return { accept: false, score: 0, reasons: [`${KIND_LABEL[ag.kind]} is outside a ${me.archetype} charter`] };
  const cap = r2(me.treasury * 0.4);
  if (ag.bondA > me.treasury) { reasons.push(`bond ${ag.bondA} exceeds treasury ${me.treasury}`); hardFail = true; }
  else if (ag.bondA > cap) { reasons.push(`bond ${ag.bondA} exceeds 40% cap (${cap})`); hardFail = true; }
  if (peer.reputation < 35) { reasons.push(`peer rep ${peer.reputation} below floor`); hardFail = true; }
  if (ag.kind === "SERVICE" && me.price && ag.feePerCall < me.price * 0.8) { reasons.push(`fee under 80% of asking`); hardFail = true; }
  const bondScore = Math.max(0, 1 - Math.abs(ag.bondA - cap / 2) / Math.max(1, cap / 2));
  const repScore = peer.reputation / 100;
  const horizonScore = ag.durationMs / 3600_000 <= 2 ? 1 : Math.max(0, 1 - (ag.durationMs / 3600_000 - 2) / 22);
  const feeScore = ag.kind === "SERVICE" && me.price ? Math.min(1, ag.feePerCall / me.price) : 0.8;
  const score = Math.round((0.3 * bondScore + 0.3 * repScore + 0.2 * horizonScore + 0.2 * feeScore) * 100) / 100;
  reasons.push(`score ${score}`);
  const accept = !hardFail && score >= 0.45;
  return { accept, score, reasons };
}

export function composeTerms(kind: AgreementKind, provider: AgentNode, hirer: AgentNode): string {
  switch (kind) {
    case "SERVICE": return `${provider.name} serves ${hirer.name}'s ${provider.capability ?? "service"} requests. Every call must return a real non-empty result; a failed or fabricated response is a breach. ${hirer.name} pays the agreed USDC fee per successful call.`;
    case "DATA_SHARING": return `${provider.name} and ${hirer.name} keep each other's endpoints reachable and share telemetry without alteration. Withholding or tampering is a breach.`;
    case "NON_AGGRESSION": return `${provider.name} and ${hirer.name} will not undercut, impersonate, spam or front-run each other on the Arc network for the term of this agreement.`;
  }
}

export type AutoAction =
  | { type: "ratify";  agreementId: number; by: string; note: string }
  | { type: "reject";  agreementId: number; by: string; note: string }
  | { type: "invoke";  agreementId: number }
  | { type: "dispute"; agreementId: number; plaintiff: string; allegation: string }
  | { type: "claim";   nodeId: string }
  | { type: "propose"; input: ProposeInput };

const isAuto = (w: World, id: string) => nodeById(w, id).owner === "autonomous";

export function nextAutonomousAction(w: World, now: number, turn: number): AutoAction | null {
  const live = w.nodes.filter(n => n.status === "active");
  if (live.length < 2) return null;

  for (const ag of w.agreements) {
    if (ag.status === "proposed" && isAuto(w, ag.partyB) && now - ag.proposedAt > 2500) {
      const ev = evaluateProposal(w, ag, ag.partyB);
      return { type: ev.accept ? "ratify" : "reject", agreementId: ag.id, by: ag.partyB, note: ev.reasons.join("; ") };
    }
  }
  for (const ag of w.agreements) {
    if (ag.status !== "active" || ag.kind !== "SERVICE" || !isAuto(w, ag.partyA)) continue;
    const bps = defendantMetricBps(ag, ag.partyB);
    const cooled = !ag.lastDisputeAt || now - ag.lastDisputeAt >= DISPUTE_COOLDOWN_MS;
    const hirer = nodeById(w, ag.partyA);
    if (bps !== null && bps >= BPS_ELEVATED && cooled && hirer.status === "active" && hirer.treasury >= requiredDisputeBond(hirer.reputation)) {
      const failed = ag.calls.filter(c => !c.ok).length;
      return { type: "dispute", agreementId: ag.id, plaintiff: ag.partyA, allegation: `${nodeById(w, ag.partyB).name} failed ${failed} of ${ag.calls.length} calls.` };
    }
  }
  const invokable = w.agreements.filter(ag => canInvoke(ag) && isAuto(w, ag.partyA)
    && nodeById(w, ag.partyB).status === "active" && nodeById(w, ag.partyA).status === "active"
    && (ag.calls.length === 0 || now - ag.calls[ag.calls.length - 1].ts > 6000));
  if (invokable.length) return { type: "invoke", agreementId: invokable[turn % invokable.length].id };
  const owed = live.find(n => n.owner === "autonomous" && n.claimable > 0);
  if (owed) return { type: "claim", nodeId: owed.id };
  const open = w.agreements.filter(ag => ag.status === "proposed" || ag.status === "active").length;
  if (open >= Math.max(3, live.length)) return null;
  const proposers = live.filter(n => n.owner === "autonomous");
  if (!proposers.length) return null;
  const me = proposers[turn % proposers.length];
  const allied = new Set(w.agreements
    .filter(ag => (ag.status === "proposed" || ag.status === "active") && (ag.partyA === me.id || ag.partyB === me.id))
    .map(ag => ag.partyA === me.id ? ag.partyB : ag.partyA));
  const peers = live.filter(p => p.id !== me.id && !allied.has(p.id)).sort((a, b) => b.reputation - a.reputation || a.id.localeCompare(b.id));
  const peer = peers[turn % Math.max(1, peers.length)];
  if (!peer) return null;
  const kind = KINDS_BY_ARCHETYPE[peer.archetype].find(k => KINDS_BY_ARCHETYPE[me.archetype].includes(k) && (k !== "SERVICE" || !!peer.endpoint));
  if (!kind) return null;
  const bond = Math.floor(Math.min(me.treasury * 0.15, peer.treasury * 0.15, MAX_UNTRUSTED_BOND));
  if (bond < 5) return null;
  const fee = peer.price ?? 3;
  if (kind === "SERVICE" && me.treasury < bond + fee * 3) return null;
  return { type: "propose", input: { proposer: me.id, counterparty: peer.id, kind, bond, durationMs: 15 * 60_000, terms: kind === "SERVICE" ? composeTerms(kind, peer, me) : composeTerms(kind, me, peer), feePerCall: kind === "SERVICE" ? fee : undefined, maxCalls: kind === "SERVICE" ? 3 : undefined } };
}

// --- Aggregates ---------------------------------------------------------------
export function lockedEscrow(w: World): number {
  return r2(w.agreements.reduce((s, ag) => s + ag.bondA + ag.bondB + ag.callBudget, 0));
}
export function agreementsOf(w: World, id: string): Agreement[] {
  return w.agreements.filter(ag => ag.partyA === id || ag.partyB === id);
}
export function isContested(w: World, id: string, now: number): boolean {
  return w.disputes.some(d => (d.defendant === id || d.plaintiff === id) && now - d.ts < 20_000);
}
