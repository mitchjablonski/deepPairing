import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function defaultLedgerPath(): string {
  return path.join(os.homedir(), ".deeppairing", "philosophy", `v${LEDGER_VERSION}.json`);
}

function normalizeKey(concept: string): string {
  return concept.trim().toLowerCase().replace(/\s+/g, " ");
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
    try {
      if (!fs.existsSync(this.ledgerPath)) {
        return { version: LEDGER_VERSION, concepts: {} };
      }
      const raw = fs.readFileSync(this.ledgerPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<LedgerFile>;
      if (parsed.version !== LEDGER_VERSION || typeof parsed.concepts !== "object" || !parsed.concepts) {
        return { version: LEDGER_VERSION, concepts: {} };
      }
      return { version: LEDGER_VERSION, concepts: parsed.concepts };
    } catch {
      // Corrupted or unreadable — return empty rather than crash.
      return { version: LEDGER_VERSION, concepts: {} };
    }
  }

  private write(ledger: LedgerFile): void {
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      // Atomic write via tmp+rename so concurrent wrappers don't tear it.
      const tmp = `${this.ledgerPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
      fs.renameSync(tmp, this.ledgerPath);
    } catch {
      // Silent — losing the ledger is non-fatal for the current session.
    }
  }

  /**
   * Append a new instance to the ledger for `concept`. Creates the entry if
   * this concept hasn't been seen before.
   */
  recordInstance(concept: string, instance: Omit<PhilosophyInstance, "at"> & { at?: string }): void {
    if (!concept.trim()) return;
    const key = normalizeKey(concept);
    const ledger = this.read();
    const now = instance.at ?? new Date().toISOString();

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
