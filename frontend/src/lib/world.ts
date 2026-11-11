import type { Role } from "./chain";

// Visual language of the board. Colours follow the Arc palette: blue for
// providers, green for clients, violet for evaluators, teal for addresses that
// play more than one role. Red is kept for rejected jobs and amber for work
// that is waiting on a decision, so no island uses them.

export type VisualStatus = "active" | "review";

export const STATUS_COLOR: Record<VisualStatus, string> = {
  active: "#8dd89f",
  review: "#f59e0b",
};

export const STATUS_LABEL: Record<VisualStatus, string> = {
  active: "ACTIVE",
  review: "AWAITING REVIEW",
};

export interface Biome { base: string; ridge: string; accent: string }

export const BIOME_BY_ROLE: Record<Role, Biome> = {
  provider:  { base: "#1061a6", ridge: "#4b9bf0", accent: "#85b1ed" },
  client:    { base: "#1a8047", ridge: "#46c47c", accent: "#8dd89f" },
  evaluator: { base: "#4f5bc4", ridge: "#8d98f2", accent: "#cbdbf2" },
  mixed:     { base: "#0f7c8a", ridge: "#3cc4d3", accent: "#9be7ef" },
};

export const ROLE_LABEL: Record<Role, string> = {
  provider:  "PROVIDER",
  client:    "CLIENT",
  evaluator: "EVALUATOR",
  mixed:     "MULTI-ROLE",
};
