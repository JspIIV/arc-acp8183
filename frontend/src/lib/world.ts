import type { Archetype, AgreementKind as ContractKind } from "./engine";

// Archipelago geometry — islands sit on concentric rings around Arc Escrow Hub.
// Pure functions of seed so the board renders identically on every mount.

export const VOXEL_H = 0.32;
export const HUB = { floatY: 1.4, radius: 4 };

export type VisualStatus = "active" | "contested" | "sanctioned";

// Arc brand palette: accent blue, success green, danger red
export const STATUS_COLOR: Record<VisualStatus, string> = {
  active:    "#8dd89f",   // Arc success green
  contested: "#acc6e9",  // Arc accent blue
  sanctioned:"#e86d7a",  // Arc danger red
};

export const STATUS_LABEL: Record<VisualStatus, string> = {
  active:    "ACTIVE",
  contested: "UNDER REVIEW",
  sanctioned:"SUSPENDED",
};

export const KIND_COLOR: Record<ContractKind, string> = {
  SERVICE:        "#85b1ed",  // Arc focus blue
  DATA_SHARING:   "#8dd89f",  // Arc green
  NON_AGGRESSION: "#cbdbf2",  // Arc light blue
};

export interface Biome { base: string; ridge: string; accent: string }

export const BIOME_BY_ARCHETYPE: Record<Archetype, Biome> = {
  // Vivid Arc-family hues: Arc blue, Arc green, periwinkle and teal. Red is reserved
  // for danger/sanctioned and amber for "under review", so no biome uses them.
  "Oracle Collective":  { base: "#1061a6", ridge: "#4b9bf0", accent: "#85b1ed" },
  "Liquidity Nexus":    { base: "#1a8047", ridge: "#46c47c", accent: "#8dd89f" },
  "Autonomous Arbiter": { base: "#4f5bc4", ridge: "#8d98f2", accent: "#cbdbf2" },
  "Defense Vanguard":   { base: "#0f7c8a", ridge: "#3cc4d3", accent: "#9be7ef" },
};

// ── Noise helpers (pure, seed-stable) ─────────────────────────────────────────
function hash2(x: number, y: number, seed: number): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ Math.imul(x | 0, 0x85ebca6b), 0xc2b2ae35);
  h = Math.imul(h ^ Math.imul(y | 0, 0x27d4eb2f), 0x165667b1);
  h ^= h >>> 15;
  return (h >>> 0) / 0xffffffff;
}
const smooth = (t: number) => t * t * (3 - 2 * t);
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = smooth(x - xi), v = smooth(y - yi);
  const a = hash2(xi, yi, seed) + (hash2(xi+1, yi, seed) - hash2(xi, yi, seed)) * u;
  const b = hash2(xi, yi+1, seed) + (hash2(xi+1, yi+1, seed) - hash2(xi, yi+1, seed)) * u;
  return a + (b - a) * v;
}
export function fbm(x: number, y: number, seed: number, octaves = 3): number {
  let total = 0, amp = 1, freq = 1, max = 0;
  for (let o = 0; o < octaves; o++) {
    total += valueNoise(x * freq, y * freq, seed + o * 131) * amp;
    max += amp; amp *= 0.5; freq *= 2;
  }
  return total / max;
}
function pseudo(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

// ── Island layout ──────────────────────────────────────────────────────────────
export interface IslandLayout {
  id: string; x: number; z: number; floatY: number; radius: number; ring: number;
}

function orbitSlot(index: number) {
  const rings = [{ cap: 4, radius: 20 }, { cap: 6, radius: 32 }, { cap: 8, radius: 44 }];
  let start = 0, ring = 0, cap = 0, radius = 0;
  for (;;) {
    const def = rings[ring] ?? { cap: 10 + (ring-2)*2, radius: 44 + (ring-2)*11 };
    if (index < start + def.cap) { cap = def.cap; radius = def.radius; break; }
    start += def.cap; ring++;
  }
  const local = index - start;
  const angle = (2*Math.PI*local)/cap + (pseudo(index)*2-1)*(Math.PI/cap)*0.35 + ring*0.4;
  const r = radius + (pseudo(index+99)*2-1)*2;
  return { ring: ring+1, x: Math.cos(angle)*r, z: Math.sin(angle)*r, floatY: (pseudo(index+7)*2-1)*0.8 };
}

export function buildLayouts(agents: { id: string }[]): IslandLayout[] {
  return [...agents]
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((e, i) => {
      const s = orbitSlot(i);
      return { id: e.id, x: s.x, z: s.z, floatY: s.floatY, radius: s.ring===1?6:s.ring===2?5:4, ring: s.ring };
    });
}

export const islandTopY = (floatY: number) => floatY + 5 * VOXEL_H;

export interface IslandTile { dx: number; dz: number; height: number; rune: boolean }

export function generateIslandTiles(radius: number, seed: number): IslandTile[] {
  const tiles: IslandTile[] = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dist = Math.hypot(dx, dz);
      if (dist > radius + 0.35) continue;
      let height = 1 + Math.round(fbm((dx+40)*0.19, (dz+40)*0.19, seed, 4)*5);
      if (dist > radius-1) height = Math.max(1, height-3);
      else if (dist > radius-2) height = Math.max(1, height-1);
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) height = 5;
      const rune = fbm((dx-12)*0.33, (dz+5)*0.33, seed+71, 2) > 0.74 && dist < radius-0.5 && height >= 2;
      tiles.push({ dx, dz, height, rune });
    }
  }
  return tiles;
}
