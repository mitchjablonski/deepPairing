import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { normalizeConceptKey } from "@deeppairing/shared";

/**
 * GlobalStore — cross-project "philosophy ledger".
 *
 * Lives in `~/.deeppairing/philosophy/v1.json`. Collects every time the user
 * rejects or approves a concept across all deepPairing sessions and projects,
 * so future sessions can draw on the user's accumulated taste.
 *
 * Design principles:
 *  - Append-only instance log — never lose the story of why
 *  - Derived stance (avoid/prefer/mixed) computed from counts, not stored
 *  - Project hint is the basename of the projectRoot — never absolute paths
 *    (privacy; the ledger is portable across machines)
 *  - Concept normalization via lowercase + whitespace collapse for lookup;
 *    display uses the first-seen casing
 *
 * The session-scoped rejection memory (FileStore.recordRejectedApproach)
 * remains the source of truth for THIS project's pre-flight. GlobalStore is
 * additive context — "across all your projects, here's what you've done with
 * this concept."
 */

export type PhilosophyVerdict = "rejected" | "approved";
export type PhilosophyStance = "avoid" | "prefer" | "mixed";

export interface PhilosophyInstance {
  project: string;
  sessionId: string;
  verdict: PhilosophyVerdict;
  reason?: string;
  description?: string;
  at: string;
}

export interface PhilosophyEntry {
  /** Normalized key (lowercase, collapsed whitespace). */
  key: string;
  /** Original-casing concept name for display. */
  concept: string;
  instances: PhilosophyInstance[];
  firstSeenAt: string;
  lastSeenAt: string;
}

interface LedgerFile {
  version: 1;
  concepts: Record<string, PhilosophyEntry>;
}

const LEDGER_VERSION = 1 as const;

function realHomeLedgerPath(): string {
  return path.join(os.homedir(), ".deeppairing", "philosophy", `v${LEDGER_VERSION}.json`);
}

function defaultLedgerPath(): string {
  // J1 — defense in depth. Field incident: a unit suite (search.test.ts)
  // constructed a FileStore that mirrors rejected approaches into the global
  // ledger via getGlobalStore(), but never redirected the singleton with
  // setGlobalStoreForTests(...). The default path is the developer's REAL
  // ~/.deeppairing ledger, so 222 test runs wrote "Deploy: Railway" rejects
  // into cross-project memory. The server vitest setup (global-store-guard)
  // now redirects the singleton in a beforeEach for EVERY test — but if any
  // future test constructs the global store outside that guard (e.g. at
  // module-eval time, before hooks run), refuse the real HOME path loudly so
  // the offending test FAILS in CI instead of silently polluting real memory.
  // Review NIT — this also fires for a test that execSync-spawns a
  // deepPairing CLI which constructs a default GlobalStore (e.g. `philosophy
  // export/import` at cli/init.ts, which inherits VITEST from the parent).
  // No such test exists today; if one is added, scrub VITEST/NODE_ENV from
  // the spawned env (or pass an explicit ledger path) rather than relaxing
  // this guard — the whole point is that the real HOME ledger is untouchable
  // under any test context.
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    throw new Error(
      "GlobalStore refused to open the real ~/.deeppairing ledger under test " +
        `(${realHomeLedgerPath()}). A test constructed the global store without ` +
        "redirecting it. Call setGlobalStoreForTests(<tmpPath>) — the server " +
        "vitest setup (src/__tests__/global-store-guard.setup.ts) does this in a " +
        "beforeEach for every test, so this usually means the global store was " +
        "constructed at module-eval time before hooks ran.",
    );
  }
  return realHomeLedgerPath();
}

// D7 — delegates to the shared single source (5 copies existed; one drifted).
const normalizeKey = normalizeConceptKey;

/**
 * EE5 — single source of truth for "is this entry user-seeded?".
 * Pre-EE5 the predicate was hand-rolled at four call sites
 * (routes.ts, first-call-hint.ts, tools/recall.ts, query()) — drift
 * risk if the seed-marker semantics ever change. Use this everywhere.
 */
export function isSeededEntry(entry: PhilosophyEntry): boolean {
  return entry.instances.some((i) => i.project === "manual");
}

/** Derive a stance from an entry's instance counts. */
export function deriveStance(entry: PhilosophyEntry): PhilosophyStance {
  const rejections = entry.instances.filter((i) => i.verdict === "rejected").length;
  const approvals = entry.instances.filter((i) => i.verdict === "approved").length;
  if (rejections > approvals * 2 && rejections >= 1) return "avoid";
  if (approvals > rejections * 2 && approvals >= 1) return "prefer";
  return "mixed";
}

export class GlobalStore {
  private ledgerPath: string;

  constructor(ledgerPath?: string) {
    this.ledgerPath = ledgerPath ?? defaultLedgerPath();
  }

  getLedgerPath(): string {
    return this.ledgerPath;
  }

  /** Load the entire ledger. Returns an empty shape on first run or corruption. */
  private read(): LedgerFile {
    // SEC1 — the concepts map is keyed by user/agent-supplied concept names.
    // Use a null-prototype map so a key of `__proto__`/`constructor` is a normal
    // own property (not Object.prototype / the constructor), which otherwise made
    // `concepts[key]` truthy-but-malformed and 500'd recordInstance.
    const emptyConcepts = (): Record<string, PhilosophyEntry> => Object.create(null);
    try {
      if (!fs.existsSync(this.ledgerPath)) {
        return { version: LEDGER_VERSION, concepts: emptyConcepts() };
      }
      const raw = fs.readFileSync(this.ledgerPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<LedgerFile>;
      if (parsed.version !== LEDGER_VERSION || typeof parsed.concepts !== "object" || !parsed.concepts) {
        return { version: LEDGER_VERSION, concepts: emptyConcepts() };
      }
      // JSON.parse yields an Object.prototype-backed map; reparent to null.
      return { version: LEDGER_VERSION, concepts: Object.assign(emptyConcepts(), parsed.concepts) };
    } catch {
      // Corrupted or unreadable — return empty rather than crash.
      return { version: LEDGER_VERSION, concepts: emptyConcepts() };
    }
  }

  private write(ledger: LedgerFile): void {
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      // II4 — was a fixed `.tmp` suffix; two daemons on two projects writing
      // concurrently collided on the same temp path and one truncated the
      // other's tmp before its rename. Use writeJsonAtomic which appends
      // pid+ts+randomBytes so the temp filename is unique per write.
      writeJsonAtomic(this.ledgerPath, ledger);
    } catch {
      // Silent — losing the ledger is non-fatal for the current session.
    }
  }

  /**
   * Append a new instance to the ledger for `concept`. Creates the entry if
   * this concept hasn't been seen before.
   *
   * II6 — dedupe identical (project, sessionId, verdict) tuples that land
   * within DEDUPE_WINDOW_MS. Failure mode this closes: DaemonClient's
   * auto-recover replays the original POST after a 404
   * session_not_registered. If the original POST already flushed to disk
   * (the session FileStore's own dedupe-by-description catches that path),
   * the global ledger still got an instance for the original call. The
   * retry adds a SECOND instance with the same shape but a different
   * timestamp. Over a flaky network this compounds into N copies of the
   * same rejection in the cross-project ledger — which the agent then
   * cites N times in preflight.
   *
   * Session FileStore deduplicates by `description` (permanent — same
   * description never appended twice). The global ledger CAN'T dedupe by
   * description because two genuine rejections of the same concept in
   * different sessions are real data. So scope the window to a single
   * (project, sessionId) — within one session, identical instances 5s
   * apart are almost certainly a retry. Across sessions or after 5s,
   * treat as genuine.
   */
  private static readonly DEDUPE_WINDOW_MS = 5000;

  recordInstance(concept: string, instance: Omit<PhilosophyInstance, "at"> & { at?: string }): void {
    if (!concept.trim()) return;
    const key = normalizeKey(concept);
    const ledger = this.read();
    const now = instance.at ?? new Date().toISOString();
    const nowMs = Date.parse(now);

    const existing = ledger.concepts[key];
    const finalized: PhilosophyInstance = {
      project: instance.project,
      sessionId: instance.sessionId,
      verdict: instance.verdict,
      reason: instance.reason,
      description: instance.description,
      at: now,
    };

    if (existing) {
      // II6 — scan recent instances for a duplicate within the window.
      const isRetry = Number.isFinite(nowMs) && existing.instances.some((prior) => {
        if (prior.project !== finalized.project) return false;
        if (prior.sessionId !== finalized.sessionId) return false;
        if (prior.verdict !== finalized.verdict) return false;
        const priorMs = Date.parse(prior.at);
        if (!Number.isFinite(priorMs)) return false;
        return Math.abs(nowMs - priorMs) < GlobalStore.DEDUPE_WINDOW_MS;
      });
      if (isRetry) return;
      existing.instances.push(finalized);
      existing.lastSeenAt = now;
    } else {
      ledger.concepts[key] = {
        key,
        concept: concept.trim(),
        instances: [finalized],
        firstSeenAt: now,
        lastSeenAt: now,
      };
    }
    this.write(ledger);
  }

  /** Look up a single entry by concept (case-insensitive). */
  get(concept: string): PhilosophyEntry | null {
    const ledger = this.read();
    return ledger.concepts[normalizeKey(concept)] ?? null;
  }

  /**
   * Query the ledger. Filters by optional concept substring and derived
   * stance; orders by most-recent lastSeenAt; caps by limit.
   */
  query(opts: {
    concept?: string;
    stance?: PhilosophyStance;
    limit?: number;
    /**
     * DD5 — filter by instance origin. "user-seeded" returns entries
     * with at least one project="manual" instance (the AA9/CC7 seed
     * marker). "session" returns entries with at least one real-project
     * instance (any non-manual project). Lets the agent ask "what did
     * the user explicitly seed?" or "what came purely from sessions?"
     * without grepping prose. Team-source filtering would need a
     * different storage path (team prefs aren't in the global ledger);
     * not exposed here.
     */
    source?: "user-seeded" | "session";
  } = {}): Array<PhilosophyEntry & { stance: PhilosophyStance }> {
    const ledger = this.read();
    const q = opts.concept?.trim().toLowerCase();
    const entries = Object.values(ledger.concepts).map((e) => ({
      ...e,
      stance: deriveStance(e),
    }));
    let filtered = entries;
    if (q) {
      filtered = filtered.filter(
        (e) => e.key.includes(q) || e.concept.toLowerCase().includes(q),
      );
    }
    if (opts.stance) {
      filtered = filtered.filter((e) => e.stance === opts.stance);
    }
    if (opts.source === "user-seeded") {
      filtered = filtered.filter(isSeededEntry);
    } else if (opts.source === "session") {
      filtered = filtered.filter((e) => e.instances.some((i) => i.project !== "manual"));
    }
    filtered.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return filtered.slice(0, opts.limit ?? 50);
  }

  /** Total entry count (for metrics/debug). */
  size(): number {
    return Object.keys(this.read().concepts).length;
  }

  /**
   * P5 — dump the whole ledger. Returns the raw LedgerFile shape so callers
   * can write it to stdout, a pipe, or a file without re-serializing the
   * internal structure.
   */
  exportLedger(): LedgerFile {
    return this.read();
  }

  /**
   * P5 — merge an exported ledger into this one. For concepts that appear
   * in both, instances are deduplicated by `(project, sessionId, verdict, at)`
   * so re-importing the same file is idempotent. firstSeenAt keeps the
   * earlier; lastSeenAt keeps the later.
   *
   * Returns summary counts so the CLI can tell the user what landed.
   */
  importLedger(incoming: unknown): { conceptsAdded: number; conceptsMerged: number; instancesAdded: number } {
    const parsed = this.validateIncoming(incoming);
    if (!parsed) throw new Error("Import rejected: not a valid deepPairing ledger export (expected { version: 1, concepts: {...} })");

    const current = this.read();
    let conceptsAdded = 0;
    let conceptsMerged = 0;
    let instancesAdded = 0;

    for (const [key, inc] of Object.entries(parsed.concepts)) {
      const existing = current.concepts[key];
      if (!existing) {
        current.concepts[key] = inc;
        conceptsAdded += 1;
        instancesAdded += inc.instances.length;
        continue;
      }
      // Merge: dedup instances by (project, sessionId, verdict, at)
      const seen = new Set(
        existing.instances.map((i) => `${i.project}|${i.sessionId}|${i.verdict}|${i.at}`),
      );
      let added = 0;
      for (const inst of inc.instances) {
        const sig = `${inst.project}|${inst.sessionId}|${inst.verdict}|${inst.at}`;
        if (seen.has(sig)) continue;
        existing.instances.push(inst);
        seen.add(sig);
        added += 1;
      }
      if (added > 0) conceptsMerged += 1;
      instancesAdded += added;
      // First-seen: earliest across both; last-seen: latest.
      if (inc.firstSeenAt < existing.firstSeenAt) existing.firstSeenAt = inc.firstSeenAt;
      if (inc.lastSeenAt > existing.lastSeenAt) existing.lastSeenAt = inc.lastSeenAt;
    }

    this.write(current);
    return { conceptsAdded, conceptsMerged, instancesAdded };
  }

  private validateIncoming(raw: unknown): LedgerFile | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Partial<LedgerFile>;
    if (obj.version !== LEDGER_VERSION) return null;
    if (!obj.concepts || typeof obj.concepts !== "object") return null;
    // Minimal per-entry validation so a corrupted file doesn't poison the ledger.
    for (const entry of Object.values(obj.concepts)) {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as Partial<PhilosophyEntry>;
      if (typeof e.key !== "string" || typeof e.concept !== "string") return null;
      if (!Array.isArray(e.instances)) return null;
      if (typeof e.firstSeenAt !== "string" || typeof e.lastSeenAt !== "string") return null;
      for (const inst of e.instances) {
        if (!inst || typeof inst !== "object") return null;
        const i = inst as Partial<PhilosophyInstance>;
        if (typeof i.project !== "string" || typeof i.sessionId !== "string") return null;
        if (i.verdict !== "rejected" && i.verdict !== "approved") return null;
        if (typeof i.at !== "string") return null;
      }
    }
    return { version: LEDGER_VERSION, concepts: obj.concepts };
  }
}

// Module-level singleton — the ledger is user-global, not session-scoped.
let _singleton: GlobalStore | null = null;

/** Shared global store. Tests can reset with resetGlobalStoreForTests(). */
export function getGlobalStore(): GlobalStore {
  if (!_singleton) _singleton = new GlobalStore();
  return _singleton;
}

/** Test-only: point the singleton at a custom ledger path. */
export function setGlobalStoreForTests(path: string | null): void {
  _singleton = path ? new GlobalStore(path) : null;
}
