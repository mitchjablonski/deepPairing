import fs from "node:fs";
import path from "node:path";
import { salvageRecord } from "./salvage.js";
import { writeJsonAtomic } from "./atomic-write.js";
import { getGlobalStore } from "./global-store.js";

/**
 * AA5 — ledger digest. Aggregates every preflight-traces.json across
 * every session in this project + cross-references the global
 * Philosophy Ledger. Drives the cross-project moat surface that Z1's
 * durable traces unlocked.
 *
 * Headline: "N proposals shaped this project; M cross-project stances."
 * Detail: top stances by citation count (with sample artifact + session
 * for jump-back), and the count of near-misses caught.
 *
 * Pure read — no side effects, safe to call from a public route.
 * Bounded: at most 200 stances returned (capped after sort), and the
 * per-trace iteration is O(traces × stances-per-trace) which in
 * practice is small (≤25 considered concepts × ≤50 sessions).
 */
// BB2 — short-TTL cache + targeted invalidation. The YourTaste drawer
// re-mounts on every open and React re-renders within a single mount
// can call this multiple times. The walk is sync fs (readdir + per-
// session readFileSync + JSON.parse) and blocks the event loop. Cache
// for DIGEST_CACHE_TTL_MS so a burst of polls is one fs walk; bust on
// recordPreflightTrace so newly persisted traces show up immediately.
const ledgerDigestCache = new Map<
  string,
  { computedAt: number; result: ReturnType<typeof ledgerDigest> }
>();
const DIGEST_CACHE_TTL_MS = 2000;

export function invalidateLedgerDigestCache(projectRoot: string): void {
  ledgerDigestCache.delete(projectRoot);
}

export function ledgerDigest(projectRoot: string): {
  shapedThisProject: number;
  nearMissesThisProject: number;
  blockedThisProject: number;
  sessionsTouched: number;
  topCitedStances: Array<{
    concept: string;
    source: "session" | "team";
    citationCount: number;
    sampleArtifactId?: string;
    sampleSessionId?: string;
  }>;
} {
  const cached = ledgerDigestCache.get(projectRoot);
  if (cached && Date.now() - cached.computedAt < DIGEST_CACHE_TTL_MS) {
    return cached.result;
  }
  const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
  if (!fs.existsSync(sessionsDir)) {
    const empty = {
      shapedThisProject: 0,
      nearMissesThisProject: 0,
      blockedThisProject: 0,
      sessionsTouched: 0,
      topCitedStances: [],
    };
    ledgerDigestCache.set(projectRoot, { computedAt: Date.now(), result: empty });
    return empty;
  }
  let shapedThisProject = 0;
  let nearMissesThisProject = 0;
  let blockedThisProject = 0;
  let sessionsTouched = 0;
  // concept → { citationCount, source, sample artifactId/sessionId }
  type Cite = { concept: string; source: "session" | "team"; citationCount: number; sampleArtifactId?: string; sampleSessionId?: string };
  const cites = new Map<string, Cite>();

  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const tracesPath = path.join(sessionsDir, entry.name, "preflight-traces.json");
    if (!fs.existsSync(tracesPath)) continue;
    let map: Record<string, any>;
    try {
      map = salvageRecord("preflight-traces.json", JSON.parse(fs.readFileSync(tracesPath, "utf-8")), {});
    } catch { continue; }
    const traceIds = Object.keys(map);
    if (traceIds.length === 0) continue;
    sessionsTouched++;
    for (const artifactId of traceIds) {
      const t = map[artifactId];
      if (!t || typeof t !== "object") continue;
      // Only count "shaped this project" when there was something to
      // weigh — empty consideredCount is the bootstrap state, not a
      // real moat moment.
      if (Array.isArray(t.consideredConcepts) && t.consideredConcepts.length > 0) {
        shapedThisProject++;
      }
      if (t.decision === "blocked") blockedThisProject++;
      if (Array.isArray(t.nearMisses) && t.nearMisses.length > 0) {
        nearMissesThisProject += t.nearMisses.length;
      }
      // Tally citations per considered concept.
      for (const c of t.consideredConcepts ?? []) {
        if (!c?.concept) continue;
        const key = `${c.source}:${c.concept}`;
        const existing = cites.get(key);
        if (existing) {
          existing.citationCount++;
        } else {
          cites.set(key, {
            concept: c.concept,
            source: c.source ?? "session",
            citationCount: 1,
            sampleArtifactId: artifactId,
            sampleSessionId: entry.name,
          });
        }
      }
    }
  }

  // GG5 — raised from 50 to 200. Pre-GG5 the cap meant FF1's seeded-row
  // sample lookup silently dropped seeds whose concept wasn't in the
  // top 50 by citation count — a power user with a busy project saw
  // inconsistent jump affordances on the seeded list ("why does THIS
  // seed click but that one doesn't?"). PMF council called the lift
  // the most-leveraged GG move because it makes the seeded → real
  // citation causal-graph link universal across the seeded panel.
  // 200 covers virtually every project (a user with 200+ distinct
  // concepts in one project is a 99.9th percentile case); the digest
  // walk is already O(traces × concepts-per-trace) so the slice
  // size doesn't change the dominant cost.
  const topCitedStances = Array.from(cites.values())
    .sort((a, b) => b.citationCount - a.citationCount)
    .slice(0, 200);

  const result = {
    shapedThisProject,
    nearMissesThisProject,
    blockedThisProject,
    sessionsTouched,
    topCitedStances,
  };
  ledgerDigestCache.set(projectRoot, { computedAt: Date.now(), result });
  return result;
}

/**
 * Phase-1 (C) — materialize a plain-text digest of the GLOBAL philosophy
 * ledger's derived-'avoid' concepts to `.deeppairing/hooks/ledger-digest.json`.
 *
 * WHY a materialized file instead of a live read: the hot PreToolUse hook
 * (cli/preflight-hook-core.ts, run via plain `node` from .deeppairing/hooks/)
 * MUST stay fast, synchronous, and free of `@deeppairing/shared` / the global
 * store at runtime. It can't call getGlobalStore(). So the DAEMON (which has
 * full deps and reads the global store anyway) writes this small sidecar, and
 * the hook's readRejectedApproaches() unions the strings in. That keeps the
 * hook deterministic (it reads a plain file) while still hard-blocking a
 * stance the user rejected in a PRIOR PROJECT — the whole point of (C).
 *
 * Shape: `{ version: 1, avoidConcepts: string[] }`. Reads of the global ledger
 * are unfiltered by the per-project publish opt-in (III8 gates WRITES only), so
 * every project gets the cross-project avoid overlay in its hook.
 *
 * Fail-open + idempotent: any error is swallowed (the hook still enforces
 * session + team from the on-disk ledgers), and an unchanged concept set skips
 * the write so we don't churn the file on every daemon tick.
 */
export function hookLedgerDigestPath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", "hooks", "ledger-digest.json");
}

export function materializeHookLedgerDigest(projectRoot: string): void {
  try {
    const avoidConcepts = getGlobalStore()
      .query({ stance: "avoid", limit: 200 })
      .map((e) => e.concept?.trim())
      .filter((c): c is string => Boolean(c));
    const target = hookLedgerDigestPath(projectRoot);
    // Skip the write when the set is unchanged (avoid file churn / needless
    // fs pressure on a busy daemon).
    try {
      const prev = JSON.parse(fs.readFileSync(target, "utf-8"));
      const prevList = Array.isArray(prev?.avoidConcepts) ? prev.avoidConcepts : [];
      if (
        prevList.length === avoidConcepts.length &&
        prevList.every((c: unknown, i: number) => c === avoidConcepts[i])
      ) {
        return;
      }
    } catch {
      // No prior digest (or unreadable) — fall through and write.
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeJsonAtomic(target, { version: 1, avoidConcepts });
  } catch {
    // Non-fatal — the hook still enforces session + team ledgers.
  }
}
