// Canvas 2D helpers for the isometric board. Pure drawing functions, no React.
// Projection is 2:1 dimetric: a slab of width w has half-width w/2 and half-height w/4.

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** f < 1 darkens toward black, f > 1 lightens toward white. */
export function shade(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number) => {
    const v = f <= 1 ? c * f : c + (255 - c) * (f - 1);
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function poly(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

export interface SlabColors { top: string; left: string; right: string; edge: string }

/** An extruded diamond. (cx, cy) is the center of the TOP face. */
export function drawSlab(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, depth: number, c: SlabColors) {
  const hw = w / 2;
  const hh = w / 4;
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = c.edge;

  poly(ctx, [[cx - hw, cy], [cx, cy + hh], [cx, cy + hh + depth], [cx - hw, cy + depth]]);
  ctx.fillStyle = c.left; ctx.fill(); ctx.stroke();

  poly(ctx, [[cx + hw, cy], [cx, cy + hh], [cx, cy + hh + depth], [cx + hw, cy + depth]]);
  ctx.fillStyle = c.right; ctx.fill(); ctx.stroke();

  poly(ctx, [[cx, cy - hh], [cx + hw, cy], [cx, cy + hh], [cx - hw, cy]]);
  ctx.fillStyle = c.top; ctx.fill(); ctx.stroke();
}

/** A box standing on the ground point (cx, baseY). */
export function drawBox(ctx: CanvasRenderingContext2D, cx: number, baseY: number, w: number, height: number, c: SlabColors) {
  drawSlab(ctx, cx, baseY - height, w, height, c);
}

export function drawRoof(ctx: CanvasRenderingContext2D, cx: number, topY: number, w: number, rise: number, color: string, edge: string) {
  const hw = w / 2;
  const hh = w / 4;
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = edge;
  poly(ctx, [[cx - hw, topY], [cx, topY + hh], [cx, topY - rise]]);
  ctx.fillStyle = shade(color, 0.7); ctx.fill(); ctx.stroke();
  poly(ctx, [[cx + hw, topY], [cx, topY + hh], [cx, topY - rise]]);
  ctx.fillStyle = shade(color, 0.5); ctx.fill(); ctx.stroke();
}

export function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export type Pt = [number, number];

export function quadPoint(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
}

/** Control point that lifts the arc above the straight line between two islands. */
export function arcControl(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lift = Math.min(140, Math.hypot(dx, dy) * 0.32);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - lift];
}

/** Stable pseudo-random in [0,1) from a string and an index. */
export function seeded(id: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
