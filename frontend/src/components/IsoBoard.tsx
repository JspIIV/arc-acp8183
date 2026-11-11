/**
 * IsoBoard: canvas 2D isometric archipelago.
 * Each island is an address that took part in a job on the ACP contract. Arcs are jobs
 * between a client and a provider, coloured by job status; a travelling dot means the
 * work is submitted and waiting for the evaluator. Everything shown comes from
 * useArcWorld(), which reads Arc. Nothing is simulated.
 */
import { useEffect, useRef } from "react";
import { useArcWorld } from "../context/ArcWorldContext";
import { BIOME_BY_ROLE, ROLE_LABEL, type VisualStatus } from "../lib/world";
import type { ChainAgent, Deal } from "../lib/chain";
import {
  arcControl, drawBox, drawRoof, drawSlab, glow, quadPoint, rgba, roundRect, seeded, shade,
  type Pt,
} from "../lib/isoDraw";

// Island slots as a percentage of the canvas, hub in the middle.
const SLOT_POS: Pt[] = [[34, 24], [66, 24], [18, 50], [82, 50], [30, 76], [70, 76], [50, 88]];
const HUB_POS: Pt = [50, 46];

const STARS = Array.from({ length: 90 }, (_, i) => ({
  x: (i * 137.508) % 100, y: (i * 97.31) % 100, r: 0.5 + (i % 4) * 0.3, o: 0.15 + (i % 6) * 0.08, p: i * 0.7,
}));

const FALLBACK = { base: "#1061a6", ridge: "#4b9bf0", accent: "#85b1ed" };
const STATUS_RING: Record<VisualStatus, string | null> = { active: null, review: "#f59e0b" };

interface Hit { id: string; x: number; y: number; s: number }

export function IsoBoard() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const world = useArcWorld();
  const live = useRef(world);
  const hits = useRef<Hit[]>([]);
  const hover = useRef<string | null>(null);

  useEffect(() => { live.current = world; });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0, H = 0, raf = 0;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const frame = (ms: number) => {
      draw(ctx, W, H, reduce ? 0 : ms / 1000, live.current, hits.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>): string | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: string | null = null, bestD = Infinity;
    for (const h of hits.current) {
      const dx = (x - h.x) / (66 * h.s), dy = (y - (h.y - 14 * h.s)) / (56 * h.s);
      const d = dx * dx + dy * dy;
      if (d <= 1 && d < bestD) { best = h.id; bestD = d; }
    }
    return best;
  };

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0 }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Isometric map of addresses that take part in jobs, connected by jobs, around the Arc escrow hub"
        style={{ display: "block", cursor: hover.current ? "pointer" : "default" }}
        onMouseMove={(e) => {
          const id = pick(e);
          if (id !== hover.current) { hover.current = id; live.current.setHovered(id); }
          e.currentTarget.style.cursor = id ? "pointer" : "default";
        }}
        onMouseLeave={() => { hover.current = null; live.current.setHovered(null); }}
        onClick={(e) => {
          const id = pick(e);
          if (id) { live.current.setSelected(id); live.current.setFocusId(id); }
          else live.current.setSelected(null);
        }}
      />
    </div>
  );
}

// ─── Frame ──────────────────────────────────────────────────────────────────

type World = ReturnType<typeof useArcWorld>;

function draw(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, w: World, out: Hit[]) {
  ctx.clearRect(0, 0, W, H);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0d1b2f"); bg.addColorStop(1, "#16395c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const s = Math.max(0.55, Math.min(1.25, Math.min(W / 760, H / 520)));
  drawBackdrop(ctx, W, H, t);

  const nodes = w.agents.slice(0, SLOT_POS.length);
  const at = new Map<string, Pt>();
  nodes.forEach((n, i) => at.set(n.id, [(SLOT_POS[i][0] / 100) * W, (SLOT_POS[i][1] / 100) * H]));
  const hub: Pt = [(HUB_POS[0] / 100) * W, (HUB_POS[1] / 100) * H];

  const focus = w.hoveredId ?? w.selectedId;
  const agreements: Deal[] = w.deals;

  // Hub spokes first, then arcs, so islands sit on top.
  ctx.setLineDash([3, 6]);
  ctx.lineWidth = 1;
  for (const p of at.values()) {
    ctx.strokeStyle = "rgba(133,177,237,0.32)";
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(hub[0], hub[1]); ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const ag of agreements) drawArc(ctx, ag, at, focus, w.busyDeals.has(ag.id), t);

  // Painter's order: farther (smaller y) first, hub participates.
  const order: { y: number; paint: () => void }[] = [
    { y: hub[1], paint: () => drawHub(ctx, hub, s, t, w.escrow) },
  ];
  out.length = 0;
  nodes.forEach((n) => {
    const p = at.get(n.id)!;
    const bob = Math.sin(t * 1.1 + seeded(n.id, 0) * 6.28) * 3 * s;
    out.push({ id: n.id, x: p[0], y: p[1] + bob, s });
    order.push({
      y: p[1],
      paint: () => drawIsland(ctx, n, p[0], p[1] + bob, s, t, w.selectedId === n.id, w.hoveredId === n.id,
        w.statusOf(n.id)),
    });
  });
  order.sort((a, b) => a.y - b.y).forEach((o) => o.paint());
  drawNotes(ctx, W, H, s, hub, w);
}

/** Honest empty states and the overflow count, so a quiet board is never mistaken for a broken one. */
function drawNotes(ctx: CanvasRenderingContext2D, W: number, H: number, s: number, hub: Pt, w: World) {
  const fs = Math.round(11 * s + 1);
  let msg: string | null = null;
  if (!w.configured) msg = "Set VITE_ACP_ADDRESS to read jobs from Arc";
  else if (w.error) msg = `Could not read Arc: ${w.error.slice(0, 70)}`;
  else if (w.loading) msg = "Reading jobs from Arc…";
  else if (w.agents.length === 0) msg = "No jobs on this contract yet";
  ctx.textAlign = "center";
  if (msg) {
    ctx.font = `600 ${fs}px "DM Sans", system-ui, sans-serif`;
    ctx.fillStyle = "#cbdbf2";
    ctx.fillText(msg, hub[0], hub[1] - 82 * s);
  }
  const extra = w.agents.length - SLOT_POS.length;
  if (extra > 0) {
    ctx.textAlign = "left";
    ctx.font = `500 ${Math.max(9, fs - 2)}px "DM Sans", system-ui, sans-serif`;
    ctx.fillStyle = "#85b1ed";
    ctx.fillText(`+${extra} more ${extra === 1 ? "address" : "addresses"} not drawn`, 16, H - 14);
  }
}

function drawBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  for (const st of STARS) {
    ctx.fillStyle = `rgba(255,255,255,${st.o * (0.7 + 0.3 * Math.sin(t * 0.8 + st.p))})`;
    ctx.beginPath(); ctx.arc((st.x / 100) * W, (st.y / 100) * H, st.r, 0, Math.PI * 2); ctx.fill();
  }
  // Isometric floor grid.
  const tw = W / 22, th = tw / 2, cx = W / 2, cy = H * 0.5;
  const iso = (gx: number, gy: number): Pt => [cx + (gx - gy) * tw, cy + (gx + gy) * th];
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(133,177,237,0.16)";
  ctx.beginPath();
  for (let i = -9; i <= 9; i++) {
    const a = iso(i, -9), b = iso(i, 9), c = iso(-9, i), d = iso(9, i);
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
  }
  ctx.stroke();
  const v = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.25, cx, cy, Math.max(W, H) * 0.75);
  v.addColorStop(0, "rgba(13,27,47,0)");
  v.addColorStop(1, "rgba(13,27,47,0.7)");
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
}

function drawArc(ctx: CanvasRenderingContext2D, ag: Deal, at: Map<string, Pt>, focus: string | null, busy: boolean, t: number) {
  const a = at.get(ag.partyA), b = at.get(ag.partyB);
  if (!a || !b) return;
  const color = ag.color;
  const c = arcControl(a, b);
  const base = !focus ? 0.85 : focus === ag.partyA || focus === ag.partyB ? 1 : 0.12;
  const alpha = ag.live ? base : base * 0.5;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = focus && alpha === 1 ? 3 : 2.2;
  ctx.setLineDash(!ag.live ? [2, 6] : ag.status === "Open" ? [8, 5] : []);
  ctx.lineDashOffset = -t * 14;
  const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
  g.addColorStop(0, rgba(color, 0.55)); g.addColorStop(0.5, rgba(color, 1)); g.addColorStop(1, rgba(color, 0.55));
  ctx.strokeStyle = g;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); ctx.stroke();
  ctx.setLineDash([]);

  if (busy) {
    for (let k = 0; k < 2; k++) {
      const p = quadPoint(a, c, b, (t * 0.45 + k * 0.5) % 1);
      glow(ctx, p[0], p[1], 14, color, 0.8);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

function drawHub(ctx: CanvasRenderingContext2D, p: Pt, s: number, t: number, escrow: number) {
  const [x, y] = p;
  glow(ctx, x, y - 10 * s, 110 * s, "#85b1ed", 0.35);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath(); ctx.ellipse(x, y + 26 * s, 62 * s, 19 * s, 0, 0, Math.PI * 2); ctx.fill();

  drawSlab(ctx, x, y + 6 * s, 96 * s, 12 * s, { top: "#1f5f9e", left: "#144a7d", right: "#0d3459", edge: "#cbdbf2" });
  drawSlab(ctx, x, y - 4 * s, 64 * s, 10 * s, { top: "#4b9bf0", left: "#2a76c4", right: "#1b5a99", edge: "#e3ecf9" });

  // Orbital ring with a travelling bright arc.
  const oy = y - 34 * s + Math.sin(t * 1.6) * 3 * s;
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "rgba(203,219,242,0.55)";
  ctx.beginPath(); ctx.ellipse(x, oy, 54 * s, 20 * s, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#8dd89f"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(x, oy, 54 * s, 20 * s, 0, t * 0.9, t * 0.9 + 1.1); ctx.stroke();

  glow(ctx, x, oy, 40 * s, "#85b1ed", 0.75 + 0.2 * Math.sin(t * 2));
  ctx.fillStyle = "#f9faf3";
  ctx.beginPath(); ctx.arc(x, oy, 7 * s, 0, Math.PI * 2); ctx.fill();

  ctx.textAlign = "center";
  ctx.font = `700 ${Math.round(10 * s + 1)}px "DM Sans", system-ui, sans-serif`;
  ctx.fillStyle = "#cbdbf2";
  ctx.fillText("ARC ESCROW", x, y + 46 * s);
  ctx.font = `500 ${Math.round(9 * s + 1)}px "DM Sans", system-ui, sans-serif`;
  ctx.fillStyle = "#8dd89f";
  ctx.fillText(`${escrow.toFixed(2)} USDC LOCKED`, x, y + 60 * s);
}

function drawIsland(
  ctx: CanvasRenderingContext2D, n: ChainAgent, x: number, y: number, s: number, t: number,
  selected: boolean, hovered: boolean, status: VisualStatus,
) {
  const b = BIOME_BY_ROLE[n.role] ?? FALLBACK;
  const active = selected || hovered;
  const ringColor = STATUS_RING[status];

  ctx.fillStyle = "rgba(5,12,23,0.45)";
  ctx.beginPath(); ctx.ellipse(x, y + 44 * s, 58 * s, 18 * s, 0, 0, Math.PI * 2); ctx.fill();
  glow(ctx, x, y + 6 * s, 104 * s, b.accent, active ? 0.5 : 0.22);

  const layer = (top: string, left: string, right: string) => ({ top, left, right, edge: rgba(b.accent, 0.8) });
  drawSlab(ctx, x, y + 14 * s, 130 * s, 14 * s, layer(shade(b.ridge, 0.95), shade(b.base, 0.95), shade(b.base, 0.68)));
  drawSlab(ctx, x, y + 2 * s, 104 * s, 12 * s, layer(shade(b.ridge, 1.1), shade(b.base, 1.05), shade(b.base, 0.76)));
  drawSlab(ctx, x, y - 10 * s, 76 * s, 10 * s, layer(shade(b.ridge, 1.3), shade(b.base, 1.15), shade(b.base, 0.82)));

  // A few small structures, placed deterministically per agent.
  for (let i = 0; i < 3; i++) {
    const ox = (seeded(n.id, i + 1) - 0.5) * 44 * s;
    const oy = (seeded(n.id, i + 7) - 0.5) * 12 * s;
    const h = (6 + seeded(n.id, i + 13) * 10) * s;
    drawBox(ctx, x + ox, y - 10 * s + oy + 4 * s, 9 * s, h,
      { top: shade(b.accent, 0.95), left: shade(b.ridge, 0.95), right: shade(b.base, 0.9), edge: rgba(b.accent, 0.7) });
  }

  // Citadel tower and beacon.
  const baseY = y - 10 * s;
  drawBox(ctx, x, baseY + 3 * s, 22 * s, 34 * s, { top: shade(b.accent, 1.05), left: shade(b.ridge, 1.1), right: shade(b.base, 1.0), edge: b.accent });
  drawRoof(ctx, x, baseY - 31 * s, 22 * s, 14 * s, b.accent, b.accent);
  const pulse = active ? 0.75 + 0.25 * Math.sin(t * 5) : 0.55 + 0.15 * Math.sin(t * 2 + seeded(n.id, 3) * 6);
  glow(ctx, x, baseY - 48 * s, 20 * s, b.accent, pulse);
  ctx.fillStyle = b.accent;
  ctx.beginPath(); ctx.arc(x, baseY - 47 * s, 2.6 * s, 0, Math.PI * 2); ctx.fill();

  if (ringColor) {
    ctx.save();
    ctx.strokeStyle = ringColor; ctx.lineWidth = 1.6;
    ctx.setLineDash([2, 5]);
    ctx.lineDashOffset = -t * 20;
    ctx.beginPath(); ctx.ellipse(x, y + 12 * s, 76 * s, 30 * s, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  if (selected) {
    ctx.strokeStyle = b.accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(x, y + 12 * s, 70 * s, 28 * s, 0, 0, Math.PI * 2); ctx.stroke();
  }

  drawLabel(ctx, n, x, y - 74 * s, s, status, active, ringColor ?? b.accent);
}

function drawLabel(
  ctx: CanvasRenderingContext2D, n: ChainAgent, x: number, y: number, s: number,
  status: VisualStatus, active: boolean, accent: string,
) {
  const fs = Math.max(9, Math.round(10 * s + 1));
  const title = n.name.toUpperCase();
  const bond = n.bond !== null && n.roles.includes("provider") ? ` · BOND ${n.bond.toFixed(2)}` : "";
  const sub = `${ROLE_LABEL[n.role]} · ${n.jobs} ${n.jobs === 1 ? "JOB" : "JOBS"}${status === "review" ? " · AWAITING REVIEW" : ""}${bond}`;
  ctx.font = `700 ${fs}px "DM Sans", system-ui, sans-serif`;
  const tw = ctx.measureText(title).width;
  ctx.font = `500 ${fs - 2}px "DM Sans", system-ui, sans-serif`;
  const sw = ctx.measureText(sub).width;
  const w = Math.max(tw, sw) + 20, h = fs * 2 + 10;

  ctx.fillStyle = "rgba(13,27,47,0.92)";
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 4); ctx.fill();
  ctx.strokeStyle = rgba(accent, active ? 1 : 0.8); ctx.lineWidth = 1; ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = accent; ctx.font = `700 ${fs}px "DM Sans", system-ui, sans-serif`;
  ctx.fillText(title, x, y - 2);
  ctx.fillStyle = "#cbd5e1"; ctx.font = `500 ${fs - 2}px "DM Sans", system-ui, sans-serif`;
  ctx.fillText(sub, x, y + fs - 1);
}
