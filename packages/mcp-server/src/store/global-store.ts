import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import { salvageLog } from "./salvage.js";
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
/** #406 — bounded wait for the ledger transaction lock. The critical section
 *  is one small JSON read + atomic replace; a second of contention means a
 *  wedged or crashed writer, so fail closed (ELOCKED) rather than block a
 *  daemon event loop longer. */
const LEDGER_LOCK_TIMEOUT_MS = 1000;

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

// H1-5 — the `.corrupt-<ts>` snapshot taken for the CURRENT corruption of each
// ledger path THIS process. Value = the actual backup file path (H1-5 R4 —
// honesty: the write-refusal message prints the real snapshot, not a stale
// reassurance). Dedup keeps read-only callers (query/get/size) from spraying a
// fresh snapshot per call at a persistently corrupt file. Cleared whenever the
// file is next read clean or written successfully, so a repair→re-corrupt
// cycle re-snapshots instead of pointing at bytes that no longer exist.
const corruptSnapshots = new Map<string, string>();


export class GlobalStore {
  private ledgerPath: string;
  // H1-5 — set by read() when the on-disk ledger couldn't be trusted at all
  // (unreadable / unparseable / wrong top-level shape). write() consults this to
  // REFUSE overwriting — silently persisting the empty shape would permanently
  // destroy all cross-project history.
  private lastReadCorrupt = false;
  // H2-1 — the human-readable reason the last read distrusted the file, so
  // getHealth() can report WHY the ledger is frozen (unparseable JSON, wrong
  // top-level shape, EACCES, …) without recomputing it. Set by markCorrupt,
  // cleared at the top of every read().
  private lastReadCorruptReason: string | undefined = undefined;
  // H1-5 R1 — set by read() when per-entry salvage had to DROP ≥1 unsalvageable
  // entry (zero recoverable instances). The top-level shape is valid so writes
  // stay allowed, but write() must snapshot the pre-drop bytes before it shrinks
  // the on-disk ledger — losing an entry is not the catastrophic reset, but we
  // never destroy an entry with no copy on disk.
  private lastReadDroppedEntries = false;

  constructor(ledgerPath?: string) {
    this.ledgerPath = ledgerPath ?? defaultLedgerPath();
  }

  getLedgerPath(): string {
    return this.ledgerPath;
  }

  /**
   * H2-1 — queryable ledger health. v0.1.6 made write() REFUSE to overwrite a
   * ledger it couldn't read (correct — it preserves months of irreplaceable
   * cross-project history), but recordInstance() returns void and every call
   * site swallows in try/catch, so a frozen ledger was INVISIBLE: present_* /
   * check_feedback reported success while nothing was recorded, forever, with
   * the only signal a console.error on daemon stderr no user ever sees. Freezing
   * is only defensible if the freeze is discoverable — this getter exposes the
   * state read() already tracks (lastReadCorrupt + the per-path corrupt-snapshot
   * map) so `dp doctor` and check_feedback can surface it. Does NOT recompute
   * corruption and does NOT change recordInstance's signature.
   *
   * "frozen" ⇒ the on-disk ledger is unreadable/unparseable/wrong-shape and
   * writes are being refused. `backupPath` is the `.corrupt-<ts>` snapshot when
   * one was captured this process; absent when even the copy failed.
   */
  getHealth(): { state: "ok" | "frozen"; ledgerPath: string; backupPath?: string; reason?: string } {
    this.read(); // refresh lastReadCorrupt + the per-path corrupt-snapshot map
    if (this.lastReadCorrupt) {
      const backupPath = corruptSnapshots.get(this.ledgerPath);
      return {
        state: "frozen",
        ledgerPath: this.ledgerPath,
        ...(backupPath ? { backupPath } : {}),
        ...(this.lastReadCorruptReason ? { reason: this.lastReadCorruptReason } : {}),
      };
    }
    return { state: "ok", ledgerPath: this.ledgerPath };
  }

  /** Copy the current on-disk ledger to `<path>.<prefix>-<ts>`. Returns the
   *  backup path on success, or null if the copy failed. */
  private snapshotLedger(prefix: "corrupt" | "removed" = "corrupt"): string | null {
    const backup = `${this.ledgerPath}.${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.copyFileSync(this.ledgerPath, backup);
      return backup;
    } catch {
      return null; // best-effort — caller decides how to degrade
    }
  }

  /**
   * H1-5 — whole-file corruption path: back the on-disk copy up to
   * `<path>.corrupt-<ts>` BEFORE we fall back to empty, and log LOUDLY. Mirrors
   * FileStore.loadJsonFile (which already does copy-then-fallback) — GlobalStore
   * was the one store that silently reset to empty with no backup, so the next
   * write() destroyed the ledger. Snapshot once per path per current corruption
   * so read-only callers hitting a persistently bad file don't storm snapshots.
   */
  private markCorrupt(err: unknown): void {
    this.lastReadCorrupt = true;
    const msg = (err as { message?: string })?.message ?? String(err);
    // H2-1 — remember the reason for getHealth() even when the snapshot was
    // already taken this corruption (the early-return below skips re-logging,
    // but a later getHealth() still needs to name why the ledger is frozen).
    this.lastReadCorruptReason = msg;
    const existing = corruptSnapshots.get(this.ledgerPath);
    if (existing) return; // this corruption is already snapshotted + logged
    const backup = this.snapshotLedger();
    if (backup) corruptSnapshots.set(this.ledgerPath, backup);
    console.error(
      `[deepPairing] GlobalStore: the philosophy ledger at ${this.ledgerPath} is corrupt/unreadable (${msg}). ` +
        (backup
          ? `Backed the on-disk copy up to ${backup} before falling back — your cross-project history is preserved there and can be hand-repaired. ` +
            `deepPairing will NOT overwrite the current file until you fix or remove it (writes are refused so the ledger isn't reset to empty).`
          : `WARNING: could NOT back it up either — refusing all writes so the only copy survives. Fix or remove the file to restore the ledger.`),
    );
  }

  /**
   * H1-5 R1 — per-entry salvage on read with RECONSTRUCTION. An entry is only
   * worthless if it carries ZERO recoverable instances (the instance log is the
   * irreplaceable data). If ≥1 instance survives, keep the entry and rebuild any
   * malformed scalar rather than dropping months of history over a bad
   * timestamp: `key`/`concept` fall back to the map key (always available),
   * `firstSeenAt`/`lastSeenAt` to the min/max of the surviving instance
   * timestamps. Returns `{ entry: null }` ONLY when nothing is salvageable.
   */
  private static salvageEntry(mapKey: string, raw: unknown): { entry: PhilosophyEntry | null; reconstructed: boolean } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { entry: null, reconstructed: false };
    const e = raw as Partial<PhilosophyEntry>;
    // Salvage the instance log FIRST — a hostile/hand-edited `instances`
    // (scalar, null, object) is the exact shape that 500s deriveStance/query.
    const rawInstances = Array.isArray(e.instances) ? e.instances : [];
    const instances = rawInstances.filter((i): i is PhilosophyInstance => {
      if (!i || typeof i !== "object") return false;
      const inst = i as Partial<PhilosophyInstance>;
      return (
        typeof inst.project === "string" &&
        typeof inst.sessionId === "string" &&
        (inst.verdict === "approved" || inst.verdict === "rejected") &&
        typeof inst.at === "string"
      );
    });
    // Nothing to lose — safe to drop silently.
    if (instances.length === 0) return { entry: null, reconstructed: false };

    let reconstructed = false;
    const key = typeof e.key === "string" && e.key.length > 0 ? e.key : mapKey;
    if (key !== e.key) reconstructed = true;
    const concept = typeof e.concept === "string" && e.concept.length > 0 ? e.concept : key;
    if (concept !== e.concept) reconstructed = true;
    const ats = instances.map((i) => i.at).sort();
    const firstSeenAt = typeof e.firstSeenAt === "string" && e.firstSeenAt.length > 0 ? e.firstSeenAt : ats[0]!;
    if (firstSeenAt !== e.firstSeenAt) reconstructed = true;
    const lastSeenAt = typeof e.lastSeenAt === "string" && e.lastSeenAt.length > 0 ? e.lastSeenAt : ats[ats.length - 1]!;
    if (lastSeenAt !== e.lastSeenAt) reconstructed = true;
    return { entry: { key, concept, instances, firstSeenAt, lastSeenAt }, reconstructed };
  }

  /** Load the entire ledger. Returns an empty shape on first run or corruption. */
  private read(): LedgerFile {
    // SEC1 — the concepts map is keyed by user/agent-supplied concept names.
    // Use a null-prototype map so a key of `__proto__`/`constructor` is a normal
    // own property (not Object.prototype / the constructor), which otherwise made
    // `concepts[key]` truthy-but-malformed and 500'd recordInstance.
    const emptyConcepts = (): Record<string, PhilosophyEntry> => Object.create(null);
    this.lastReadCorrupt = false;
    this.lastReadCorruptReason = undefined;
    this.lastReadDroppedEntries = false;

    // Truly fresh — no file. Writes allowed; forget any stale snapshot record.
    if (!fs.existsSync(this.ledgerPath)) {
      corruptSnapshots.delete(this.ledgerPath);
      return { version: LEDGER_VERSION, concepts: emptyConcepts() };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.ledgerPath, "utf-8");
    } catch (err) {
      // Unreadable (EACCES/EBUSY/…) — can't trust it; treat as corrupt so a
      // later write() doesn't reset the file we simply couldn't open.
      this.markCorrupt(err);
      return { version: LEDGER_VERSION, concepts: emptyConcepts() };
    }
    // H1-5 R3 — a 0-byte / whitespace-only file is FIRST RUN, not corruption.
    // It's exactly what an interrupted pre-atomic write or an ext4
    // delayed-allocation crash leaves behind; freezing writes on it would
    // preserve nothing (no history) yet silently stop the ledger from ever
    // learning again. Treat like the absent-file branch (writes allowed, no
    // backup, no freeze) — but log ONCE per path so it isn't silent.
    if (raw.trim() === "") {
      salvageLog(`philosophy-ledger-empty:${this.ledgerPath}`, `philosophy ledger at ${this.ledgerPath} was empty; starting fresh`);
      corruptSnapshots.delete(this.ledgerPath);
      return { version: LEDGER_VERSION, concepts: emptyConcepts() };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // H1-5 — was `catch { return empty }` with NO backup, NO log; the next
      // write() then persisted the empty shape over the ledger. Now: back up + log.
      this.markCorrupt(err);
      return { version: LEDGER_VERSION, concepts: emptyConcepts() };
    }
    // H1-5 R2 — route null / arrays / non-objects through markCorrupt too.
    // `JSON.parse("null")` succeeds and returns null; reading `parsed.version`
    // on it would throw OUTSIDE the try/catch above (a regression vs main,
    // which wrapped the whole body). Guard the root before dereferencing.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const rootKind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
      this.markCorrupt(new Error(`unexpected ledger root (${rootKind})`));
      return { version: LEDGER_VERSION, concepts: emptyConcepts() };
    }
    const top = parsed as Partial<LedgerFile>;
    if (top.version !== LEDGER_VERSION || typeof top.concepts !== "object" || !top.concepts) {
      // Parseable JSON but a wrong top-level shape — same treatment: preserve
      // and refuse to overwrite rather than silently reset.
      this.markCorrupt(new Error(`unexpected ledger shape (version=${JSON.stringify(top.version)})`));
      return { version: LEDGER_VERSION, concepts: emptyConcepts() };
    }
    // Top-level shape is sound (NOT corruption) — salvage per entry with
    // reconstruction. Reconstructing a malformed scalar loses nothing; DROPPING
    // an entry (only when it has zero recoverable instances) is real loss, so
    // write() snapshots the pre-drop bytes before it commits the shrunk ledger.
    const concepts = emptyConcepts();
    let dropped = 0;
    for (const [key, rawEntry] of Object.entries(top.concepts)) {
      const { entry } = GlobalStore.salvageEntry(key, rawEntry);
      if (entry) concepts[key] = entry;
      else dropped++;
    }
    if (dropped > 0) {
      salvageLog("philosophy-ledger", `dropped ${dropped} unsalvageable concept entry(ies) on read (no recoverable instances)`);
      this.lastReadDroppedEntries = true;
    } else {
      // Fully readable (clean or only reconstructed — no data lost). Any prior
      // corruption snapshot is stale now; forget it so future corruption of this
      // path re-snapshots (H1-5 R4).
      corruptSnapshots.delete(this.ledgerPath);
    }
    return { version: LEDGER_VERSION, concepts };
  }

  /**
   * #406 — every ledger mutation is ONE cross-process transaction: the read,
   * the mutation and the atomic replace all run under `<ledger>.lock` (the
   * shared file-lock.ts boundary). Concurrent project daemons each read the
   * whole file and rename a whole new one; without this, the later rename
   * erased the earlier daemon's append (measured: ~45% of 2×100 appends lost).
   * Readers (get/query/export/getHealth, the hooks) stay lock-free — the file
   * is always replaced atomically. A busy lock past LEDGER_LOCK_TIMEOUT_MS
   * throws ELOCKED; it is never broken by age (see file-lock.ts).
   */
  private transact<T>(mutate: () => T): T {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    return withFileLock(`${this.ledgerPath}.lock`, mutate, {
      label: "Philosophy ledger lock",
      timeoutMs: LEDGER_LOCK_TIMEOUT_MS,
      reentrant: true,
    });
  }

  /**
   * #486 — `<ledger>.removed.json`: `{ seq, removals: { [conceptKey]: seq } }`.
   * `seq` is a MONOTONIC removal counter (never a clock: a backward clock step
   * must not change which mirrors count as "older than the removal"). A
   * mirror queued while the ledger was busy carries the `seq` it saw before
   * its first attempt; on replay it is skipped if its concept was removed
   * after that. A sidecar, so the ledger's own format is unchanged.
   */
  private removalsPath(): string {
    return `${this.ledgerPath}.removed.json`;
  }

  /** Read the removal sidecar. A corrupt file is backed up and salvaged —
   *  never silently treated as empty (that would lose tombstones). */
  private readRemovals(): { seq: number; removals: Record<string, number> } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.removalsPath(), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { seq: 0, removals: {} };
      throw err;
    }
    const salvage = (text: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*(\d+)/g)) {
        try { const key = JSON.parse(`"${m[1]}"`) as string; if (key !== "seq") out[key] = Number(m[2]); } catch { /* skip */ }
      }
      return out;
    };
    try {
      const v = JSON.parse(raw) as { seq?: unknown; removals?: unknown };
      if (v && typeof v === "object" && Number.isInteger(v.seq) && v.removals && typeof v.removals === "object" && !Array.isArray(v.removals)) {
        const removals: Record<string, number> = {};
        let bad = false;
        for (const [k, n] of Object.entries(v.removals as Record<string, unknown>)) {
          if (Number.isInteger(n)) removals[k] = n as number; else bad = true;
        }
        if (!bad) return { seq: v.seq as number, removals };
      }
    } catch { /* fall through to salvage */ }
    const removals = salvage(raw);
    // The counter must never go backwards (a reused number would let a
    // removal look older than a mirror queued before it): take the larger of
    // a still-readable "seq" and the highest per-concept entry.
    const seqMatch = raw.match(/"seq"\s*:\s*(\d+)/);
    const seq = Math.max(0, seqMatch ? Number(seqMatch[1]) : 0, ...Object.values(removals));
    // One backup per corruption, not per read: the name is the content's
    // hash, so every later read of the same bad bytes (each mirror reads the
    // sequence) reuses it instead of piling up copies.
    const backup = `${this.removalsPath()}.corrupt-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
    if (!fs.existsSync(backup)) {
      try { fs.copyFileSync(this.removalsPath(), backup); } catch { /* best effort */ }
      console.error(
        `[deepPairing] GlobalStore: the removal record ${this.removalsPath()} is corrupt; backed up to ${backup} and salvaged ` +
        `${Object.keys(removals).length} removal(s). Check the backup if a removed stance reappears.`,
      );
    }
    return { seq, removals };
  }

  /** The current removal sequence — captured by a mirror before its first
   *  attempt, so its replay can tell whether a removal happened since. */
  removalSeq(): number {
    try { return this.readRemovals().seq; } catch { return 0; }
  }

  /** Called under the ledger lock (removeConcept). */
  private recordRemoval(key: string): void {
    const current = this.readRemovals();
    const seq = current.seq + 1;
    try {
      writeJsonAtomic(this.removalsPath(), { seq, removals: { ...current.removals, [key]: seq } });
    } catch (err) {
      console.error(`[deepPairing] could not record the removal of "${key}" (a queued mirror could re-add it):`, err);
    }
  }

  private write(ledger: LedgerFile): void {
    // H1-5 — REFUSE to overwrite a ledger the most recent read couldn't trust.
    // Writing the (empty) fallback shape here is exactly the permanent
    // data-loss bug: recordInstance reads empty-on-corruption, appends one
    // instance, and this write clobbers all cross-project history. The
    // timestamped `.corrupt-<ts>` backup (made in read/markCorrupt) is the
    // recovery copy; the file itself stays untouched until a human repairs it.
    if (this.lastReadCorrupt) {
      const snap = corruptSnapshots.get(this.ledgerPath);
      console.error(
        `[deepPairing] GlobalStore: refusing to write ${this.ledgerPath} — the current on-disk ledger is corrupt; ` +
          `not overwriting it with a reset shape. ` +
          (snap
            ? `A backup of the corrupt file is at ${snap}. `
            : `It could NOT be backed up (no snapshot of the current corrupt state exists on disk). `) +
          `Fix or remove the file to resume recording.`,
      );
      return;
    }
    // H1-5 R1 — never shrink the on-disk ledger (a per-entry DROP happened this
    // read) without first snapshotting the pre-drop bytes. writeJsonAtomic below
    // is about to overwrite the file that still holds the dropped entry.
    if (this.lastReadDroppedEntries) {
      this.snapshotLedger();
    }
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      // II4 — was a fixed `.tmp` suffix; two daemons on two projects writing
      // concurrently collided on the same temp path and one truncated the
      // other's tmp before its rename. Use writeJsonAtomic which appends
      // pid+ts+randomBytes so the temp filename is unique per write.
      writeJsonAtomic(this.ledgerPath, ledger);
      // The file on disk is valid again; forget any stale corruption snapshot so
      // a future corruption of this path is treated as new (H1-5 R4).
      corruptSnapshots.delete(this.ledgerPath);
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

  recordInstance(
    concept: string,
    instance: Omit<PhilosophyInstance, "at"> & { at?: string },
    opts: { exactOnce?: boolean; replayedFromSeq?: number } = {},
  ): void {
    if (!concept.trim()) return;
    this.transact(() => this.recordInstanceLocked(concept, instance, opts));
  }

  private recordInstanceLocked(
    concept: string,
    instance: Omit<PhilosophyInstance, "at"> & { at?: string },
    opts: { exactOnce?: boolean; replayedFromSeq?: number } = {},
  ): void {
    const key = normalizeKey(concept);
    const ledger = this.read();
    const now = instance.at ?? new Date().toISOString();
    const nowMs = Date.parse(now);

    const existing = ledger.concepts[key];
    // #486 — a REPLAYED mirror carries the timestamp of its first attempt, so
    // the (project, sessionId, verdict, at) signature identifies it exactly
    // (the same signature importLedger dedupes on). Already present ⇒ an
    // earlier replay landed it; never append it twice, whatever the age.
    // #486 — removal is authoritative over every project's queued mirrors:
    // an instance stamped BEFORE the concept was removed (a mirror queued
    // while the ledger was busy, replayed after the user's `philosophy
    // remove`) must not resurrect it. Checked here, under the ledger lock, so
    // a remove racing a replay cannot lose. A genuinely new instance (stamped
    // after the removal) still records.
    if (opts.replayedFromSeq !== undefined) {
      const removedSeq = this.readRemovals().removals[key];
      if (removedSeq !== undefined && removedSeq > opts.replayedFromSeq) {
        console.error(`[deepPairing] skipped a queued cross-project mirror for "${concept}": the concept was removed after it was queued.`);
        return;
      }
    }
    if (opts.exactOnce && existing?.instances.some((prior) =>
      prior.project === instance.project && prior.sessionId === instance.sessionId &&
      prior.verdict === instance.verdict && prior.at === now)) {
      return;
    }
    const finalized: PhilosophyInstance = {
      project: instance.project,
      sessionId: instance.sessionId,
      verdict: instance.verdict,
      reason: instance.reason,
      description: instance.description,
      at: now,
    };

    if (existing) {
      // Manual-seed idempotency (demo-ledger-isolation follow-through) —
      // the synthetic (project="manual", sessionId="seed") shape is
      // deterministic, so an identical (concept, verdict) seed arriving
      // again — the user re-pasting the same CLAUDE.md rule days later, or
      // any scripted flow re-run — is a retry by definition and dedupes
      // PERMANENTLY, not just inside the II6 5s window. Scoped strictly to
      // the manual-seed shape: genuine session rejections of the same
      // concept in different sessions carry distinct sessionIds and remain
      // appendable (that's the compounding signal). An opposite-verdict
      // seed is a genuine stance change and still appends.
      if (
        finalized.project === "manual" &&
        finalized.sessionId === "seed" &&
        existing.instances.some(
          (prior) =>
            prior.project === "manual" &&
            prior.sessionId === "seed" &&
            prior.verdict === finalized.verdict,
        )
      ) {
        return;
      }
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

  /**
   * First-class stance removal — deletes the WHOLE concept entry (all
   * instances). This is the missing counterpart to the override valve, which
   * is local-blocks-only and never touches the global ledger; before this the
   * only way out was hand-editing the JSON.
   *
   * Backup-before-mutate: EVERY removal snapshots the pre-removal bytes to a
   * fresh `.removed-<ts>` copy (same helper as the `.corrupt-<ts>` copies) so
   * removal is reversible — restore by copying the backup over the ledger, or
   * re-merge it with `philosophy import --merge`. Per-removal on purpose
   * (review #193): a process-lifetime first-snapshot reuse meant a long-lived
   * daemon that removed A, later recorded B, then removed B reported A-era
   * bytes as B's "backup" — B was unrecoverable while the UI promised "a
   * timestamped backup is written first". Removal is rare, filenames carry
   * ts+rand (no collisions), and the honest contract is one fresh copy each
   * time. (The corruptSnapshots dedupe map stays — that exists for read-spam
   * on a persistently bad file, a different problem.) If the backup cannot be
   * written, the removal is REFUSED (we never destroy the only copy of taste
   * history).
   *
   * Returns null (no write, no backup) when the concept isn't in the ledger.
   * Throws when the on-disk ledger is corrupt/frozen — write() would refuse
   * anyway, and a silent no-op would misreport "not found" for stances that
   * are actually preserved inside the unreadable file.
   */
  removeConcept(concept: string): { concept: string; instanceCount: number; backupPath: string } | null {
    return this.transact(() => this.removeConceptLocked(concept));
  }

  private removeConceptLocked(concept: string): { concept: string; instanceCount: number; backupPath: string } | null {
    const key = normalizeKey(concept);
    const ledger = this.read();
    if (this.lastReadCorrupt) {
      const snap = corruptSnapshots.get(this.ledgerPath);
      throw new Error(
        `the philosophy ledger at ${this.ledgerPath} is corrupt/unreadable — refusing to modify it. ` +
          (snap ? `A backup of the corrupt file is at ${snap}. ` : "") +
          `Fix or remove the file, then retry.`,
      );
    }
    const entry = ledger.concepts[key];
    if (!entry) return null;

    const backupPath = this.snapshotLedger("removed");
    if (!backupPath) {
      throw new Error(
        `could not back the ledger up before removal (${this.ledgerPath}) — refusing to delete taste history without a reversible copy.`,
      );
    }

    delete ledger.concepts[key];
    this.write(ledger);
    this.recordRemoval(key);
    return { concept: entry.concept, instanceCount: entry.instances.length, backupPath };
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
    return this.transact(() => this.importLocked(parsed));
  }

  private importLocked(parsed: LedgerFile): { conceptsAdded: number; conceptsMerged: number; instancesAdded: number } {
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
