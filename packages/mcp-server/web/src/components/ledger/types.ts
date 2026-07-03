// F2 — shared types + the digest gate for the Ledger surface
// (split out of the 1,079-line YourTasteDrawer).

// O3: Weekly Digest is gated until real users have accumulated 4+ weeks of
// ledger activity — otherwise the "new / strengthened" lists look embarrassing
// and undersell the moat. Flip via `VITE_DP_SHOW_DIGEST=1`, or in tests via
// `window.__DP_FORCE_DIGEST__ = true`.
export function isDigestEnabled(): boolean {
  if (typeof window !== "undefined" && (window as any).__DP_FORCE_DIGEST__) return true;
  const env = (import.meta as any)?.env?.VITE_DP_SHOW_DIGEST;
  return Boolean(env && env !== "0" && env !== "false");
}

/**
 * N3.1 + N3.2 — "Your taste" drawer. Makes the invisible Philosophy Ledger
 * moat felt. Two tabs:
 *   - Stances: static view of every concept + its derived stance
 *   - Digest:  what changed in the last N days (new + strengthened)
 *
 * Read-only. Mutations happen implicitly during sessions (every rejected
 * approach + approved pattern flows to the ledger). The reason ledger
 * entries compound — they span projects and survive beyond any one session
 * — is why this view exists. Without it, the compounding is invisible.
 */


export interface PhilosophyEntry {
  key: string;
  concept: string;
  stance: "avoid" | "prefer" | "mixed";
  projectCount: number;
  projects: string[];
  instanceCount: number;
  approved: number;
  rejected: number;
  latestReason?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DigestData {
  window: { sinceDays: number; fromIso: string; toIso: string };
  totals: { concepts: number; instances: number; multiProjectConcepts: number };
  newThisPeriod: Array<{ key: string; concept: string; stance: string; projectCount: number; latestReason?: string }>;
  strengthenedThisPeriod: Array<{ key: string; concept: string; stance: string; projectCount: number; newInstancesInPeriod: number; latestReason?: string }>;
}

export interface TeamPreference {
  id: string;
  kind: "require" | "prefer" | "avoid";
  concept: string;
  rationale: string;
  scope?: { paths?: string[] };
  addedBy?: string;
  addedAt?: string;
}

export interface TeamPreferencesData {
  preferences: TeamPreference[];
  exists: boolean;
}

export type Filter = "all" | "avoid" | "prefer" | "mixed";
// AA5 — "ledger" tab is the cross-project moat surface unlocked by Z1's
// durable preflight traces. Aggregates how many proposals the ledger has
// shaped IN this project + cross-project totals, with top cited stances.
export type Tab = "stances" | "ledger" | "digest" | "team";

// Review NIT — the drawer carried its own copy of LedgerDigest since birth;
// the store's is the source of truth now.
export type { LedgerDigest } from "../../stores/ledger";
