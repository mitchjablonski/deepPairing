import fs from "node:fs";
import path from "node:path";
import type { Artifact, ArtifactType, ArtifactStatus, Comment, SessionAnnotation, TeamPreference, PreflightTrace } from "@deeppairing/shared";
import { nanoid } from "nanoid";
import { getGlobalStore } from "./global-store.js";
import { writeJsonAtomic, writeStringAtomic } from "./atomic-write.js";
import { salvageArray, salvageRecord, salvageLog } from "./salvage.js";
import { senseProjectGuardrails, loadTeamPreferences } from "./project-signals.js";
import type { ProjectGuardrail } from "./project-signals.js";
import { computeEngagementMetrics } from "./engagement-metrics.js";
import { listSessions, searchAll, findPastPredictions, addRetrospective } from "./session-scan.js";
import { ledgerDigest, invalidateLedgerDigestCache } from "./ledger-digest.js";
import type { IStore, DecisionRecord, PlanReviewRecord, RejectedApproach, StatusTransitionReason , RecordDecisionParams } from "./store-interface.js";

export type { DecisionRecord, PlanReviewRecord };
// Re-exported so existing `import { ProjectGuardrail } from "./file-store.js"`
// consumers keep working after the G10 extraction into project-signals.ts.
export type { ProjectGuardrail };

/**
 * File-based store for deepPairing artifacts, comments, and decisions.
 * Stores data in .deeppairing/ directory within the project root.
 * In-memory cache with debounced disk flush.
 */
export class FileStore implements IStore {
  private basePath: string;
  private projectHint: string;
  private guardrails: ProjectGuardrail[];
  private teamPreferences: TeamPreference[];
  private artifacts: Artifact[] = [];
  private comments: Comment[] = [];
  private decisions: Map<string, DecisionRecord> = new Map();
  private planReviews: Map<string, PlanReviewRecord> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string;
  private autonomyLevel: "supervised" | "balanced" | "autonomous" = "supervised";

  /**
   * U1 — per-file change watermarks tracked since last load. Before each
   * flush we re-stat each session JSON; if EITHER mtime has advanced OR
   * size has changed beyond what we last saw, another writer (CLI command,
   * second daemon during a race, external editor) has touched the file
   * and our in-memory copy is no longer the full truth. We re-read the
   * disk version and merge by id before writing — in-memory wins on key
   * collisions because those are the user's latest actions, but records
   * added by the other writer survive instead of being clobbered.
   *
   * Why two signals: mtime granularity is FS-dependent (WSL2 and some
   * older Linux/Windows give second-only resolution), so two writes in
   * the same second produce identical mtimeMs even though content
   * differs. Falling back to size catches that — it's not a perfect
   * checksum, but two distinct sets of artifacts almost always serialize
   * to different lengths. Together they give good-enough defense in depth
   * on top of the U0.6 deterministic-sessionId fix that already
   * collapses intra-daemon races to zero.
   */
  private fileMtimeMs: Record<string, number> = {};
  private fileSizes: Record<string, number> = {};
  // PP2 — last serialized bytes we wrote per file, so flush() can skip the disk
  // write (and the temp+rename) when a file is byte-identical to what's already
  // there. Kills the write-amplification where a single comment rewrote the
  // multi-MB artifacts.json: now only the file(s) that actually changed hit disk.
  // Cost: holds a serialized copy of each session file in RAM (grows with
  // artifacts.json size) — an accepted trade for the I/O savings. flush() drops
  // an entry whenever readIfChanged detects an external write, so the skip can
  // never defeat the U1 merge self-heal.
  private lastSerialized: Record<string, string> = {};

  // BB2 — held for FileStore.invalidateLedgerDigestCache, which is keyed
  // by projectRoot so all sessions in this project bust the same cache.
  // BB4 — also read by the recall mode='ledger' handler to call
  // FileStore.ledgerDigest(projectRoot) for the agent-facing moat surface.
  readonly projectRoot: string;

  constructor(projectRoot: string, sessionId?: string) {
    this.projectRoot = projectRoot;
    this.basePath = path.join(projectRoot, ".deeppairing");
    // Project hint for the global philosophy ledger — basename only so the
    // ledger stays portable across machines (never store absolute paths).
    this.projectHint = path.basename(projectRoot);
    // J6: sense filesystem signals for guardrails (migrations, workflows,
    // infra, secrets). The agent gets these on first tool call so it knows
    // to escalate for changes in those paths even when global autonomy is
    // "autonomous" — zero user configuration.
    this.guardrails = senseProjectGuardrails(projectRoot);
    // N6.2: load committable team preferences from .deeppairing/team.json.
    // Cached for the lifetime of the FileStore — the file is meant to be
    // edited via PR, so a session reload is the right reload point.
    this.teamPreferences = loadTeamPreferences(this.basePath);
    this.sessionId = sessionId ?? `session_${Date.now()}`;
    // Prevent path traversal via sessionId
    if (this.sessionId.includes("..") || this.sessionId.includes("/") || this.sessionId.includes("\\")) {
      throw new Error("Invalid session ID");
    }
    this.ensureDir();
    this.load();
    this.loadPreferences();
  }

  private ensureDir(): void {
    const sessionDir = path.join(this.basePath, "sessions", this.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  private sessionDir(): string {
    return path.join(this.basePath, "sessions", this.sessionId);
  }

  private loadPreferences(): void {
    const prefsPath = path.join(this.basePath, "preferences.json");
    const prefs = FileStore.salvageRecord(
      // G6 — labels are the once-per-process suppression KEY: session-scope
      // them (F10's sid:file format) so a second corrupt session still logs.
      `${this.sessionId}:preferences.json`, this.loadJsonFile<unknown>(prefsPath, {}), {} as Record<string, any>);
    if (prefs.autonomyLevel) this.autonomyLevel = prefs.autonomyLevel;
  }

  private load(): void {
    const dir = this.sessionDir();
    this.artifacts = FileStore.salvageArray<Artifact>(
      `${this.sessionId}:artifacts.json`, this.loadJsonFile<unknown>(path.join(dir, "artifacts.json"), []), "id");
    this.comments = FileStore.salvageArray<Comment>(
      `${this.sessionId}:comments.json`, this.loadJsonFile<unknown>(path.join(dir, "comments.json"), []), "id");
    const decArr = FileStore.salvageArray<DecisionRecord>(
      `${this.sessionId}:decisions.json`, this.loadJsonFile<unknown>(path.join(dir, "decisions.json"), []), "decisionId");
    this.decisions = new Map(decArr.map((d) => [d.decisionId, d]));
    const planArr = FileStore.salvageArray<PlanReviewRecord>(
      `${this.sessionId}:plan-reviews.json`, this.loadJsonFile<unknown>(path.join(dir, "plan-reviews.json"), []), "artifactId");
    this.planReviews = new Map(planArr.map((p) => [p.artifactId, p]));
    // AA3 — rehydrate reviewLatencies. Pre-AA3 they were in-memory only,
    // dropped on every daemon idle-shutdown — review-latency metrics
    // would silently reset to zero and the engagement view in YourTaste
    // looked broken. Now they round-trip through metrics.json on flush.
    // F10 (G1) — the ONE load D1 missed: any parseable non-array ({}, "hi")
    // landed here as-is, and the .push in recordArtifactReviewed then threw
    // on EVERY human approve/reject (500s, and the corrupt file never
    // self-healed because flush only writes when length > 0). Latency
    // entries carry no id field, so this is an element-shape salvage rather
    // than salvageArray.
    const rawMetrics = this.loadJsonFile<unknown>(path.join(dir, "metrics.json"), []);
    if (Array.isArray(rawMetrics)) {
      const kept = rawMetrics.filter(
        (e): e is { type: string; latencyMs: number } =>
          !!e && typeof e === "object" &&
          typeof (e as { type?: unknown }).type === "string" &&
          typeof (e as { latencyMs?: unknown }).latencyMs === "number" &&
          Number.isFinite((e as { latencyMs: number }).latencyMs),
      );
      if (kept.length !== rawMetrics.length) {
        FileStore.salvageLog(`${this.sessionId}:metrics.json`, `dropped ${rawMetrics.length - kept.length} malformed latency entr(ies)`);
      }
      this.reviewLatencies = kept;
    } else {
      if (rawMetrics != null) {
        FileStore.salvageLog(`${this.sessionId}:metrics.json`, `expected an array, got ${typeof rawMetrics} — using []`);
      }
      this.reviewLatencies = [];
    }
  }

  // D1 — the salvage helpers (disk trust boundary) live in salvage.ts since
  // the G10 decomposition. These statics are byte-compatible delegates so
  // every existing FileStore.salvage* call site keeps working unchanged.
  private static salvageLog = salvageLog;
  static salvageArray = salvageArray;
  static salvageRecord = salvageRecord;

  /** Load a JSON file with graceful error handling. Records mtime + size so a
   *  later flush can detect external writes and merge instead of clobber. */
  private loadJsonFile<T>(filePath: string, fallback: T): T {
    try {
      if (!fs.existsSync(filePath)) {
        delete this.fileMtimeMs[filePath];
        delete this.fileSizes[filePath];
        return fallback;
      }
      const stat = fs.statSync(filePath);
      this.fileMtimeMs[filePath] = stat.mtimeMs;
      this.fileSizes[filePath] = stat.size;
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        delete this.fileMtimeMs[filePath];
        delete this.fileSizes[filePath];
        return fallback;
      }
      console.error(`[deepPairing] Corrupted file ${filePath}: ${err.message}`);
      try {
        fs.copyFileSync(filePath, filePath + ".corrupt");
      } catch { /* best-effort backup */ }
      return fallback;
    }
  }

  /**
   * U1 — return the on-disk version of `filePath` IFF the file was modified
   * by another writer since we last loaded it; otherwise null. Caller uses
   * the result to merge external changes into in-memory state before flush.
   *
   * Change detection is OR(mtimeMs > lastSeen, size != lastSeen). Either
   * signal alone is unreliable (WSL2 mtime is second-resolution; size
   * could match by coincidence on a same-length swap), but together they
   * catch the realistic external-write cases we care about.
   */
  private readIfChanged<T>(filePath: string): T | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      const lastMtime = this.fileMtimeMs[filePath] ?? 0;
      const lastSize = this.fileSizes[filePath];
      const mtimeAdvanced = stat.mtimeMs > lastMtime;
      const sizeChanged = lastSize !== undefined && stat.size !== lastSize;
      const sizeFirstSeen = lastSize === undefined;
      if (!mtimeAdvanced && !sizeChanged && !sizeFirstSeen) return null;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return parsed as T;
    } catch {
      return null;
    }
  }

  private flushFailureLogged = false;

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      // C3 — a throwing timer callback is an UNCAUGHT EXCEPTION that kills
      // the whole node process. This debounced flush can race directory
      // removal (demo-session eviction rm -rf's the session dir; tests remove
      // tmpdirs) and ENOENT out of writeFileSync. Losing one best-effort
      // flush is fine; taking down the daemon is not.
      try {
        this.flush();
        this.flushFailureLogged = false;
      } catch (err) {
        // Swallow — the next mutation reschedules. But log once per failure
        // STREAK (review-caught: a bare swallow turns persistent EACCES/ENOSPC
        // into silent permanent data loss; only teardown-race ENOENT is truly
        // expected here).
        if (!this.flushFailureLogged) {
          this.flushFailureLogged = true;
          console.error(`[deepPairing] debounced flush failed for session ${this.sessionId}:`, err);
        }
      }
      this.flushTimer = null;
    }, 100);
  }

  /** Atomic write: delegates to writeJsonAtomic (PID+TS+random temp suffix
   *  so concurrent flushes to the same path can't truncate each other's tmp).
   *  Refreshes mtime+size watermark after rename so the next external-change
   *  check uses the new baseline. */
  private atomicWrite(filePath: string, data: unknown): void {
    // PP2 — serialize once, and skip the disk write entirely when the bytes are
    // identical to our last write. A debounced flush re-writes ALL session files
    // on every mutation; this means a comment only rewrites comments.json, not
    // the (often multi-MB, diff-bearing) artifacts.json that didn't change.
    // Safe: we only skip when the content is byte-for-byte what we already
    // persisted — never a real change. Same indent (2) as writeJsonAtomic.
    const serialized = JSON.stringify(data, null, 2);
    if (this.lastSerialized[filePath] === serialized) return;
    writeStringAtomic(filePath, serialized);
    this.lastSerialized[filePath] = serialized;
    try {
      const stat = fs.statSync(filePath);
      this.fileMtimeMs[filePath] = stat.mtimeMs;
      this.fileSizes[filePath] = stat.size;
    } catch { /* swallow — watermark refresh is best-effort */ }
  }

  /**
   * U1 — merge-by-id helper. If another writer touched the file, union the
   * on-disk records with our in-memory ones; in-memory wins on key
   * collisions because those are the user's most recent actions. Records
   * the other writer added that we never saw still survive instead of
   * being overwritten.
   */
  private mergeArrayById<T extends Record<string, any>>(
    inMemory: T[],
    onDisk: T[] | null,
    keyField: string,
  ): T[] {
    if (!onDisk || !Array.isArray(onDisk)) return inMemory;
    const seen = new Set(inMemory.map((r) => r[keyField]).filter(Boolean));
    const additions = onDisk.filter((r) => r[keyField] && !seen.has(r[keyField]));
    if (additions.length === 0) return inMemory;
    return [...additions, ...inMemory];
  }

  private flush(): void {
    const dir = this.sessionDir();
    const artifactsPath = path.join(dir, "artifacts.json");
    const commentsPath = path.join(dir, "comments.json");
    const decisionsPath = path.join(dir, "decisions.json");
    const plansPath = path.join(dir, "plan-reviews.json");

    // U1 — merge any external changes since our last load before clobbering
    // each file. The deterministic-sessionId fix from U0.6 already makes
    // intra-daemon races vanishingly rare, but CLI commands and a daemon
    // restart race could still touch the same files.
    // PP2 — when readIfChanged detects an external write, drop that file's
    // skip-cache entry so atomicWrite CANNOT skip below. Critical for the U1
    // self-heal: an external writer that shrank/clobbered the file is merged
    // into memory here, but if the merge nets back to our last-written bytes the
    // skip would leave the external (lossy) version on disk and our merged copy
    // only in RAM. Forcing the rewrite restores it (and keeps in-memory-wins).
    // D1 review — the EXTERNAL reads must be salvaged too: a null element in a
    // hand-edited file threw inside mergeArrayById's filter, the flush catch
    // swallowed it, and — because the mtime watermark only advances on a
    // successful load/write — EVERY subsequent flush re-read and re-threw:
    // persistence for the session silently stopped until the file was fixed.
    const diskArtifacts = this.readIfChanged<unknown>(artifactsPath);
    if (diskArtifacts) {
      this.artifacts = this.mergeArrayById(
        this.artifacts,
        FileStore.salvageArray<Artifact>(`${this.sessionId}:artifacts.json (external)`, diskArtifacts, "id"),
        "id",
      );
      delete this.lastSerialized[artifactsPath];
    }
    const diskComments = this.readIfChanged<unknown>(commentsPath);
    if (diskComments) {
      this.comments = this.mergeArrayById(
        this.comments,
        FileStore.salvageArray<Comment>("comments.json (external)", diskComments, "id"),
        "id",
      );
      delete this.lastSerialized[commentsPath];
    }
    const diskDecisions = this.readIfChanged<unknown>(decisionsPath);
    if (diskDecisions) {
      for (const d of FileStore.salvageArray<DecisionRecord>("decisions.json (external)", diskDecisions, "decisionId")) {
        if (!this.decisions.has(d.decisionId)) {
          this.decisions.set(d.decisionId, d);
        }
      }
      delete this.lastSerialized[decisionsPath];
    }
    const diskPlans = this.readIfChanged<unknown>(plansPath);
    if (diskPlans) {
      for (const p of FileStore.salvageArray<PlanReviewRecord>("plan-reviews.json (external)", diskPlans, "artifactId")) {
        if (!this.planReviews.has(p.artifactId)) {
          this.planReviews.set(p.artifactId, p);
        }
      }
      delete this.lastSerialized[plansPath];
    }

    this.atomicWrite(artifactsPath, this.artifacts);
    this.atomicWrite(commentsPath, this.comments);
    this.atomicWrite(decisionsPath, Array.from(this.decisions.values()));
    this.atomicWrite(plansPath, Array.from(this.planReviews.values()));
    // AA3 — persist reviewLatencies so a daemon idle-shutdown doesn't
    // wipe them. Only write when we have data; an empty array is still
    // useful (signals "no reviews yet"), but skipping the write keeps
    // session dirs tidy on first use.
    if (this.reviewLatencies.length > 0) {
      this.atomicWrite(path.join(dir, "metrics.json"), this.reviewLatencies);
    }
  }

  /** Force an immediate flush — call before process exit */
  forceFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // --- Artifacts ---

  createArtifact(params: {
    id: string;
    type: ArtifactType;
    title: string;
    content: Record<string, unknown>;
    agentReasoning?: string;
    relatedArtifactIds?: string[];
    parentId?: string | null;
    version?: number;
  }): Artifact {
    const now = new Date().toISOString();
    const artifact: Artifact = {
      id: params.id,
      sessionId: this.sessionId,
      type: params.type,
      version: params.version ?? 1,
      parentId: params.parentId ?? null,
      title: params.title,
      status: "draft",
      content: params.content,
      agentReasoning: params.agentReasoning ?? null,
      relatedArtifactIds: params.relatedArtifactIds,
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.push(artifact);
    if (params.type === "code_change") this.touchCodeChangeMarker(now);
    this.scheduleFlush();
    return artifact;
  }

  /**
   * PP1 — a tiny project-level marker the per-edit checkpoint hook reads instead
   * of readdir-ing + JSON.parsing every session's (potentially multi-MB,
   * diff-bearing) artifacts.json on every Write/Edit. Last write wins = the
   * most-recent code_change across all sessions, which is exactly what the
   * checkpoint's freshness rule needs. Best-effort: if it's missing the hook
   * just falls back to nagging (the safe default).
   */
  private touchCodeChangeMarker(at: string): void {
    try {
      // atomic (temp+rename) so a concurrent checkpoint read can't see a torn
      // file; basePath already exists (constructor). Best-effort — never let a
      // marker write break artifact creation.
      writeJsonAtomic(path.join(this.basePath, "last-code-change.json"), { at });
    } catch {
      /* hint only */
    }
  }

  renameArtifact(artifactId: string, title: string): void {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (art) {
      art.title = title;
      art.updatedAt = new Date().toISOString();
      this.scheduleFlush();
    }
  }

  updateArtifactStatus(
    artifactId: string,
    status: ArtifactStatus,
    reason: StatusTransitionReason = "unspecified",
  ): void {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (art) {
      const wasDraft = art.status === "draft";
      const now = new Date().toISOString();
      const fromStatus = art.status;
      art.status = status;
      art.updatedAt = now;
      // Append to statusHistory so replay can reconstruct the trail faithfully.
      // Lazy-init so older sessions opt into the richer format on first
      // transition — old records keep working via the fallback in timeline.ts.
      const history = (art as any).statusHistory ?? [];
      if (history.length === 0 && art.createdAt) {
        history.push({ status: "draft", at: art.createdAt });
      }
      // U7 — append `reason` so the audit trail records WHO/WHAT caused the
      // transition. A future timeline view shows these tags inline; the
      // daemon log already does, so silent transitions surface immediately.
      history.push({ status, at: now, reason });
      (art as any).statusHistory = history;

      // U7 — sentinel alarm. Comments must NEVER drive status. If a caller
      // ever tags a transition `comment_side_effect`, scream loudly so the
      // bug surfaces in dev/test instead of riding to prod.
      if (reason === "comment_side_effect") {
        console.error(
          `[deepPairing] BUG: comment_side_effect transition fired for ` +
          `artifact ${artifactId} (${fromStatus} → ${status}). ` +
          `Comments must never change artifact status.`,
        );
      }

      // FN4 — only count HUMAN reviews. An agent self-superseding/retracting/
      // obsoleting its own still-draft artifact (agent_*), or the demo script,
      // is not a review — counting it inflated avgReviewLatency/reviewsByType
      // with agent-paced, non-human samples.
      const agentDriven = reason.startsWith("agent_") || reason === "demo_script";
      if (wasDraft && status !== "draft" && !agentDriven) {
        // F10 (split-state) — the status/history mutation above already
        // happened; a metrics throw here used to 500 the route AFTER the
        // in-memory flip, so the UI rolled back + toasted failure while a
        // LATER flush persisted the phantom approval. Metrics must never
        // block a review verdict.
        try {
          this.recordArtifactReviewed(artifactId);
        } catch (err) {
          console.error(`[deepPairing] metrics recording failed (verdict unaffected): ${err}`);
        }
      }
      this.scheduleFlush();
      this.notifyFeedbackWaiters();
    }
  }

  /** D10 (H2) — patch plan step statuses in place. See store-interface.ts. */
  updatePlanProgress(
    artifactId: string,
    updates: Array<{ stepIndex: number; status: "pending" | "in_progress" | "done" | "skipped"; statusNote?: string }>,
  ): Artifact | null {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (!art || art.type !== "plan") return null;
    const content = art.content as { steps?: Array<Record<string, unknown>> };
    if (!Array.isArray(content.steps)) return null;
    let touched = false;
    for (const u of updates) {
      const step = content.steps[u.stepIndex];
      if (!step) continue; // out-of-range indexes are the caller's bug, not a crash
      step.status = u.status;
      if (u.statusNote !== undefined) step.statusNote = u.statusNote;
      touched = true;
    }
    if (!touched) return null;
    art.updatedAt = new Date().toISOString();
    this.scheduleFlush();
    return art;
  }

  getArtifacts(): Artifact[] {
    return this.artifacts;
  }

  // --- Comments ---

  /**
   * U0.1 — server-side dedupe window. Field bug: a single comment posted
   * ~13 times in a row because the client's `if (sending) return` guard read
   * stale React state during rapid Enter presses, and there was no
   * server-side gate. Two duplicates within DEDUPE_WINDOW_MS for the same
   * (artifact, author, content, parent) tuple collapse to one — we return
   * the original comment so the caller's optimistic UI still gets a record.
   *
   * 5 seconds is the sweet spot: catches every rapid-fire mode I've seen
   * (double-Enter, retry-on-timeout, websocket loop), short enough that a
   * user genuinely posting the same content twice on purpose isn't blocked
   * (wait 6s and try again).
   */
  private static readonly DEDUPE_WINDOW_MS = 5000;

  /**
   * F3 — the dedupe must distinguish comments anchored to DIFFERENT parts of
   * the same artifact. Pre-F3 the key was only (author, artifactId, content,
   * parent), so two terse same-content comments ("why?", "fix this") posted on
   * different lines / findings / steps / visuals within the 5s window silently
   * collapsed to one — real human input lost (and not even broadcast). Fold the
   * target's discriminating fields into the key. artifactId is compared
   * separately, so it's excluded here.
   */
  private static targetKey(target: Record<string, unknown> | undefined): string {
    const t = target ?? {};
    // Every anchor field in CommentTargetSchema (comment.ts) except artifactId,
    // which is compared separately. Listing them all — including ones the UI
    // doesn't construct today (lineNumber) — guarantees no two distinct anchors
    // ever collapse. `?? ""` (nullish, not ||) so index 0 stays distinct.
    return [
      "lineNumber", "lineStart", "lineEnd", "filePath",
      "findingIndex", "evidenceIndex", "stepIndex", "alternativeIndex",
      "optionId", "sectionId", "visualId",
      // D8 review — added with the schema fields; without them two
      // same-content answers ("yes") on DIFFERENT open questions inside the
      // dedupe window collapsed into one (the exact F3 class this key exists
      // to prevent).
      "requirementId", "questionIndex",
    ].map((f) => `${f}=${t[f] ?? ""}`).join("|");
  }

  addComment(params: {
    id: string;
    artifactId: string;
    content: string;
    author: "human" | "agent";
    target?: Record<string, unknown>;
    intent?: "comment" | "question" | "suggestion";
    parentCommentId?: string | null;
    codeReferences?: Array<{ filePath: string; lineStart: number; lineEnd: number; snippet?: string }>;
  }): Comment {
    const now = Date.now();
    const parentKey = params.parentCommentId ?? "";
    const newTargetKey = FileStore.targetKey(params.target);
    const dupe = this.comments.find((c) => {
      if (c.author !== params.author) return false;
      if (c.target.artifactId !== params.artifactId) return false;
      if (c.content !== params.content) return false;
      if ((c.parentCommentId ?? "") !== parentKey) return false;
      // F3 — only a dupe if it targets the SAME anchor (line/finding/step/etc).
      if (FileStore.targetKey(c.target as Record<string, unknown>) !== newTargetKey) return false;
      const t = new Date(c.createdAt).getTime();
      return Number.isFinite(t) && now - t < FileStore.DEDUPE_WINDOW_MS;
    });
    if (dupe) {
      // Return the existing comment so the caller's response/broadcast logic
      // still wires the UI to a valid record. The duplicate POST silently
      // resolves to the original — invisible to the user, gold for the field
      // bug we're closing.
      return dupe;
    }

    const comment: Comment = {
      id: params.id,
      sessionId: this.sessionId,
      target: { artifactId: params.artifactId, ...params.target },
      parentCommentId: params.parentCommentId ?? null,
      author: params.author,
      content: params.content,
      intent: params.intent,
      // FN1 — persist attached code evidence (answer_question). Spread so the
      // field is simply absent when there's none (back-compat with stored data).
      ...(params.codeReferences && params.codeReferences.length > 0
        ? { codeReferences: params.codeReferences }
        : {}),
      answeredByCommentId: null,
      acknowledged: params.author === "agent",
      createdAt: new Date(now).toISOString(),
    };
    this.comments.push(comment);
    this.scheduleFlush();
    if (params.author === "human") this.notifyFeedbackWaiters();
    return comment;
  }

  getCommentsForArtifact(artifactId: string): Comment[] {
    return this.comments.filter((c) => c.target.artifactId === artifactId);
  }

  getUnacknowledgedComments(): Comment[] {
    return this.comments.filter((c) => !c.acknowledged);
  }

  acknowledgeComments(ids: string[]): void {
    for (const c of this.comments) {
      if (ids.includes(c.id)) c.acknowledged = true;
    }
    this.scheduleFlush();
  }

  getComment(commentId: string): Comment | undefined {
    return this.comments.find((c) => c.id === commentId);
  }

  markCommentAnswered(commentId: string, answerCommentId: string): void {
    const parent = this.comments.find((c) => c.id === commentId);
    if (parent) {
      parent.answeredByCommentId = answerCommentId;
      this.scheduleFlush();
    }
  }

  markCommentHumanResolved(commentId: string, resolvedAt?: string): void {
    const comment = this.comments.find((c) => c.id === commentId);
    if (comment) {
      comment.humanResolvedAt = resolvedAt ?? new Date().toISOString();
      this.scheduleFlush();
    }
  }

  // --- Decisions ---

  // C6c review — the interface narrowed options to DecisionOption[] but this
  // inline param type still said any[], leaving the WRITE site unenforced.
  recordDecisionRequest(params: RecordDecisionParams): void {
    this.decisions.set(params.decisionId, {
      ...params,
      createdAt: new Date().toISOString(),
    });
    this.scheduleFlush();
  }

  resolveDecision(
    decisionId: string,
    optionId: string,
    reasoning?: string,
    prediction?: { confidence?: "low" | "medium" | "high"; predictedOutcome?: string },
  ): void {
    const dec = this.decisions.get(decisionId);
    if (!dec) return;
    // F2 — reject an optionId that isn't one of this decision's options. The
    // public/internal HTTP routes pass optionId straight through unvalidated; if
    // a malformed/buggy client sent an unknown id we'd set a response that
    // check_feedback then acknowledges (consuming the decision) but can't match
    // to an option, silently dropping the ledger learning. Fail-closed: leave it
    // pending so it re-surfaces rather than vanishing.
    const opts = (dec as { options?: Array<{ id?: string }> }).options;
    if (Array.isArray(opts) && opts.length > 0 && !opts.some((o) => o?.id === optionId)) {
      return;
    }
    dec.response = {
      optionId,
      reasoning,
      confidence: prediction?.confidence,
      predictedOutcome: prediction?.predictedOutcome,
    };
    dec.resolvedAt = new Date().toISOString();
    this.scheduleFlush();
    this.notifyFeedbackWaiters();
  }

  getDecisionResponse(decisionId: string): { optionId: string; reasoning?: string } | null {
    return this.decisions.get(decisionId)?.response ?? null;
  }

  /** An artifact whose review can never resolve normally any more — it was
   *  superseded by a newer version, retracted, rejected, or marked obsolete.
   *  A pending decision/plan-review record pointing at such an artifact is an
   *  orphan and must NOT keep reporting as "waiting" (it would block
   *  check_feedback forever). A record with no backing artifact is left as-is
   *  (artifacts are never deleted in production; only their status changes), so
   *  unknown ids stay pending rather than vanishing. */
  private isArtifactClosed(artifactId: string): boolean {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (!art) return false;
    return (
      art.status === "superseded" ||
      art.status === "retracted" ||
      art.status === "rejected" ||
      art.status === "obsolete"
    );
  }

  getPendingDecisions(): DecisionRecord[] {
    return Array.from(this.decisions.values()).filter(
      (d) => !d.response && !this.isArtifactClosed(d.artifactId),
    );
  }

  getDecision(decisionId: string): DecisionRecord | undefined {
    return this.decisions.get(decisionId);
  }

  getResolvedDecisions(): DecisionRecord[] {
    return Array.from(this.decisions.values()).filter((d) => d.response && !d.acknowledged);
  }

  acknowledgeDecisions(decisionIds: string[]): void {
    for (const id of decisionIds) {
      const dec = this.decisions.get(id);
      if (dec) dec.acknowledged = true;
    }
    this.scheduleFlush();
  }

  // --- Plan Reviews ---

  recordPlanReview(artifactId: string): void {
    this.planReviews.set(artifactId, {
      artifactId,
      createdAt: new Date().toISOString(),
    });
    this.scheduleFlush();
  }

  resolvePlanReview(artifactId: string, verdict: "approved" | "revised" | "rejected", feedback?: string): void {
    const review = this.planReviews.get(artifactId);
    if (review) {
      review.verdict = verdict;
      review.feedback = feedback;
      review.resolvedAt = new Date().toISOString();
      this.scheduleFlush();
      this.notifyFeedbackWaiters();
    }
  }

  getPlanReviewVerdict(artifactId: string): { verdict: string; feedback?: string } | null {
    const review = this.planReviews.get(artifactId);
    if (!review?.verdict) return null;
    return { verdict: review.verdict, feedback: review.feedback };
  }

  getPendingPlanReviews(): PlanReviewRecord[] {
    return Array.from(this.planReviews.values()).filter(
      (p) => !p.verdict && !this.isArtifactClosed(p.artifactId),
    );
  }

  // --- Engagement Metrics ---

  private reviewLatencies: { type: string; latencyMs: number }[] = [];

  /** Record that an artifact was reviewed (status changed from draft) */
  recordArtifactReviewed(artifactId: string): void {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (art) {
      const latencyMs = Date.now() - new Date(art.createdAt).getTime();
      this.reviewLatencies.push({ type: art.type, latencyMs });
    }
  }

  getEngagementMetrics(): {
    avgReviewLatencyMs: number;
    commentDensity: number;
    approvalRate: number;
    reviewsByType: Record<string, { avgLatencyMs: number; count: number }>;
    decisionsWithPredictions: number;
    highStakesDecisions: number;
  } {
    // G10 — the FN4/K2 computation is a pure function of session state;
    // extracted to engagement-metrics.ts. This method just feeds it.
    return computeEngagementMetrics({
      artifacts: this.artifacts,
      comments: this.comments,
      decisions: this.decisions.values(),
      reviewLatencies: this.reviewLatencies,
    });
  }

  // --- Session Memory (persists across sessions) ---

  /**
   * Record a rejected approach so it's never proposed again.
   * Stored in .deeppairing/preferences.json under "rejectedApproaches".
   * Records are enriched objects; legacy string[] entries are migrated on next write.
   */
  /**
   * III8 — true when this project has opted in to PUBLISH its rejected /
   * approved instances into the cross-project ~/.deeppairing/philosophy/
   * ledger. Default is false (opt-in). Reads from the global ledger are
   * always unfiltered — users still get cross-project context they've
   * accumulated from any project they opted in for.
   *
   * Failure mode this closes: any project the user opens with deepPairing
   * could previously seed avoid-stances ("validate untrusted input",
   * "use parameterized queries") that every other project then cited.
   * Single-write poisoning by a malicious dependency that triggers
   * recordRejectedApproach via the agent. With opt-in publish, the
   * malicious dep can only poison its own project's ledger, not the
   * global one.
   *
   * Reads `globalLedgerPublish` from preferences.json. Set via the
   * one-time `init` prompt (or `npx deeppairing philosophy publish on/off`).
   */
  private globalLedgerPublishEnabled(): boolean {
    return this.readPreferences().globalLedgerPublish === true;
  }

  /**
   * III8 — flip the per-project publish opt-in. Used by the `init`
   * prompt, by the `npx deeppairing philosophy publish on/off` command,
   * and by tests that want to exercise the cross-project mirror path.
   * Idempotent. Persists to preferences.json.
   */
  setGlobalLedgerPublish(enabled: boolean): void {
    const prefs = this.readPreferences();
    if (prefs.globalLedgerPublish === enabled) return;
    prefs.globalLedgerPublish = enabled;
    this.writePreferences(prefs);
  }

  getGlobalLedgerPublish(): boolean {
    return this.globalLedgerPublishEnabled();
  }

  recordRejectedApproach(params: {
    description: string;
    reason?: string;
    sourceArtifactId?: string;
    concept?: string;
  }): void {
    const { description, reason, sourceArtifactId, concept } = params;
    // Mirror into the user-global philosophy ledger. The session-scoped
    // preferences.json remains the source of truth for THIS project's
    // pre-flight; the global ledger is additive context for future sessions
    // across all projects.
    // AA1 — concept (when present) is the cross-project ledger key, NOT
    // description. Pre-AA1 server.ts:824 was passing `option.description`
    // as the concept arg, so the global ledger keyed on prose strings
    // and never compounded across projects. Typed-object signature here
    // makes the next refactor's regression visible.
    // III8 — gate on the per-project publish opt-in. Reads still work,
    // local preferences.json is still updated below; only the global
    // mirror is gated.
    const conceptKey = concept?.trim() || description.trim();
    if (conceptKey && this.globalLedgerPublishEnabled()) {
      try {
        getGlobalStore().recordInstance(conceptKey, {
          project: this.projectHint,
          sessionId: this.sessionId,
          verdict: "rejected",
          reason,
          description,
        });
      } catch {
        // Non-fatal — losing a ledger append doesn't break the session.
      }
    }

    const prefs = this.readPreferences();
    const rejected = this.normalizeRejectedApproaches(prefs.rejectedApproaches ?? []);
    const existing = rejected.find((r) => r.description === description);
    if (existing) {
      // Enrich incrementally — each new signal (reason, concept, source) is
      // additive so we never overwrite prior context with a blank update.
      let changed = false;
      if (reason && !existing.reason) { existing.reason = reason; changed = true; }
      if (concept && !existing.concept) { existing.concept = concept; changed = true; }
      if (sourceArtifactId && !existing.sourceArtifactId) { existing.sourceArtifactId = sourceArtifactId; changed = true; }
      if (changed) {
        existing.rejectedAt = existing.rejectedAt ?? new Date().toISOString();
        prefs.rejectedApproaches = rejected;
        this.writePreferences(prefs);
      }
      return;
    }
    rejected.push({
      description,
      reason: reason || undefined,
      concept: concept || undefined,
      rejectedAt: new Date().toISOString(),
      sourceArtifactId,
    });
    prefs.rejectedApproaches = rejected;
    this.writePreferences(prefs);
  }

  /** Migrate legacy string[] into RejectedApproach[] so downstream code sees one shape. */
  private normalizeRejectedApproaches(raw: unknown): RejectedApproach[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) =>
      typeof entry === "string"
        ? { description: entry }
        : {
            description: String((entry as any)?.description ?? ""),
            reason: (entry as any)?.reason,
            rejectedAt: (entry as any)?.rejectedAt,
            sourceArtifactId: (entry as any)?.sourceArtifactId,
            concept: (entry as any)?.concept,
          },
    ).filter((r) => r.description);
  }

  /**
   * Record an approved pattern the human prefers.
   * Stored in .deeppairing/preferences.json under "approvedPatterns".
   */
  recordApprovedPattern(params: { description: string; concept?: string }): void {
    const { description, concept } = params;
    // AA1 — symmetric with recordRejectedApproach: concept (when present)
    // is the cross-project ledger key. Pre-AA1 the approved path passed
    // raw description strings into the global ledger, so an "argon2id for
    // password hashing" approval in project A never bucketed with the
    // same approval in project B.
    // III8 — same per-project publish opt-in gate as the rejected path.
    const conceptKey = concept?.trim() || description.trim();
    if (conceptKey && this.globalLedgerPublishEnabled()) {
      try {
        getGlobalStore().recordInstance(conceptKey, {
          project: this.projectHint,
          sessionId: this.sessionId,
          verdict: "approved",
          description,
        });
      } catch {
        // Non-fatal
      }
    }

    const prefs = this.readPreferences();
    const approved: string[] = prefs.approvedPatterns ?? [];
    if (!approved.includes(description)) {
      approved.push(description);
      prefs.approvedPatterns = approved;
      this.writePreferences(prefs);
    }
  }

  /**
   * Scope-down (override) a personal rejected-approach that the pre-flight gate
   * matched as a false positive. The gate is fuzzy by design, so wrong blocks
   * are guaranteed — this is the safety valve that keeps a wrong block from
   * being permanent.
   *
   * Two writes, mirroring recordRejectedApproach in reverse:
   *   1) Retire the matching local entry from preferences.json so the block
   *      clears in THIS project immediately (the pre-flight reads this list).
   *   2) Record an `approved` counter-instance in the global ledger so the
   *      DERIVED stance shifts off "avoid" (deriveStance counts approvals vs
   *      rejections) and the same shape stops tripping in future projects.
   *      Append-only history is preserved — we never delete the concept's
   *      instance log, so "the story of why" survives and a later genuine
   *      rejection can swing the stance back.
   *
   * The global write is gated on the same publish opt-in as the rejection
   * mirror: if you never published the rejection, there's nothing to counter
   * globally and the local retire alone suffices.
   *
   * Matches local entries by exact description OR concept, covering both the
   * surface- and concept-via blocks the matcher can produce. Returns the
   * number of local entries retired.
   */
  overrideRejectedApproach(params: { description?: string; concept?: string }): { retired: number } {
    const { description, concept } = params;
    const conceptKey = concept?.trim() || description?.trim() || "";
    if (conceptKey && this.globalLedgerPublishEnabled()) {
      try {
        getGlobalStore().recordInstance(conceptKey, {
          project: this.projectHint,
          sessionId: this.sessionId,
          verdict: "approved",
          reason: "Overridden — not my taste (pre-flight false positive)",
          description,
        });
      } catch {
        // Non-fatal — losing a ledger append doesn't break the override; the
        // local retire below is what clears the block in this project.
      }
    }

    const prefs = this.readPreferences();
    const rejected = this.normalizeRejectedApproaches(prefs.rejectedApproaches ?? []);
    const keep = rejected.filter(
      (r) =>
        !((description && r.description === description) || (concept && r.concept === concept)),
    );
    const retired = rejected.length - keep.length;
    if (retired > 0) {
      prefs.rejectedApproaches = keep;
      this.writePreferences(prefs);
    }
    return { retired };
  }

  /**
   * Get session memory context for the agent.
   * Returns rejected approaches and approved patterns from previous sessions.
   */
  getSessionMemory(): { rejectedApproaches: RejectedApproach[]; approvedPatterns: string[] } {
    const prefs = this.readPreferences();
    return {
      rejectedApproaches: this.normalizeRejectedApproaches(prefs.rejectedApproaches ?? []),
      approvedPatterns: prefs.approvedPatterns ?? [],
    };
  }

  getProjectGuardrails(): ProjectGuardrail[] {
    return this.guardrails;
  }

  getTeamPreferences(): TeamPreference[] {
    return this.teamPreferences;
  }

  private readPreferences(): Record<string, any> {
    const prefsPath = path.join(this.basePath, "preferences.json");
    return FileStore.salvageRecord("preferences.json", this.loadJsonFile<unknown>(prefsPath, {}), {} as Record<string, any>);
  }

  private writePreferences(prefs: Record<string, any>): void {
    const prefsPath = path.join(this.basePath, "preferences.json");
    // II4 — preferences.json holds the rejected-approach memory used by every
    // preflight. A torn write here silently wipes the moat, so use the atomic
    // helper instead of the raw writeFileSync this used to do.
    writeJsonAtomic(prefsPath, prefs);
  }

  // --- Session annotations (learner's replay notes) ---

  /**
   * Annotations live in a separate annotations.json file per session. They
   * never reach the agent — they're the human re-reading their own past
   * work. Keeping the channel separate prevents "learning notes" from
   * accidentally becoming agent context.
   */
  private annotationsPath(): string {
    return path.join(this.sessionDir(), "annotations.json");
  }

  getAnnotations(): SessionAnnotation[] {
    return this.loadJsonFile<SessionAnnotation[]>(this.annotationsPath(), []);
  }

  addAnnotation(params: { targetEventId: string; note: string; tags?: string[] }): SessionAnnotation {
    const annotation: SessionAnnotation = {
      id: `ann_${nanoid(10)}`,
      sessionId: this.sessionId,
      targetEventId: params.targetEventId,
      note: params.note,
      tags: params.tags,
      createdAt: new Date().toISOString(),
    };
    const existing = this.getAnnotations();
    existing.push(annotation);
    writeJsonAtomic(this.annotationsPath(), existing);
    return annotation;
  }

  deleteAnnotation(annotationId: string): boolean {
    const existing = this.getAnnotations();
    const next = existing.filter((a) => a.id !== annotationId);
    if (next.length === existing.length) return false;
    writeJsonAtomic(this.annotationsPath(), next);
    return true;
  }

  // --- Ledger digest (BB4) ---

  /**
   * BB4 — agent-facing wrapper around the static ledgerDigest. Pairs the
   * project-scoped digest with global-ledger totals (filtered for AA9
   * synthetic project="manual" markers, same as /api/ledger/digest).
   * Lets the recall mode='ledger' tool open with "your ledger has shaped
   * N proposals" without two round trips.
   */
  getLedgerDigest() {
    const project = FileStore.ledgerDigest(this.projectRoot);
    const entries = getGlobalStore().query({ limit: 10000 });
    const projects = new Set<string>();
    // FF4 — same concept→cross-project-citation map the HTTP route uses
    // (EE3) so the agent-facing path also surfaces "cited N× here, M×
    // cross-project" via recall mode='ledger'. Pre-FF4 this method
    // returned topCitedStances unaugmented; the wire endpoint had the
    // augmentation but agents in standalone mode (no daemon) lost it.
    const globalCitationByConcept = new Map<string, number>();
    for (const e of entries) {
      const realCount = e.instances.filter((i) => i.project !== "manual").length;
      if (realCount > 0) globalCitationByConcept.set(e.concept, realCount);
      for (const inst of e.instances) {
        if (inst.project !== "manual") projects.add(inst.project);
      }
    }
    const multiProjectConcepts = entries.filter(
      (e) => new Set(e.instances.filter((i) => i.project !== "manual").map((i) => i.project)).size > 1,
    ).length;
    const topCitedStancesWithGlobal = project.topCitedStances.map((s) => ({
      ...s,
      globalCitationCount: globalCitationByConcept.get(s.concept) ?? s.citationCount,
    }));
    return {
      ...project,
      topCitedStances: topCitedStancesWithGlobal,
      globalLedger: {
        concepts: entries.length,
        projects: projects.size,
        multiProjectConcepts,
      },
    };
  }

  // --- Preflight traces (Y1') ---

  /**
   * Y1' — sidecar storage for preflight consult traces. One JSON file per
   * session, keyed by artifactId. Kept off the artifact body because
   * traces describe a one-time consult event (council architecture
   * round 2: Artifact stays the immutable creative payload, trace
   * evolves separately if needed).
   */
  private preflightTracesPath(): string {
    return path.join(this.sessionDir(), "preflight-traces.json");
  }

  recordPreflightTrace(artifactId: string, trace: PreflightTrace): void {
    const map = FileStore.salvageRecord(
      "preflight-traces.json", this.loadJsonFile<unknown>(this.preflightTracesPath(), {}), {} as Record<string, PreflightTrace>);
    map[artifactId] = trace;
    // Z4 — atomic write. Pre-Z4 a SIGKILL during this rewrite (which
    // fires per `present_*` and twice for `revise_artifact`) could
    // truncate the file mid-write — the next read fell back to {} and
    // ALL prior trace history vanished silently. writeJsonAtomic uses
    // the .tmp + renameSync pattern so readers see either the old map
    // or the new map, never a half-written byte stream.
    writeJsonAtomic(this.preflightTracesPath(), map);
    // BB2 — bust the ledgerDigest cache so the YourTaste drawer's next
    // poll reflects this new trace immediately.
    FileStore.invalidateLedgerDigestCache(this.projectRoot);
  }

  getPreflightTrace(artifactId: string): PreflightTrace | null {
    const map = FileStore.salvageRecord(
      "preflight-traces.json", this.loadJsonFile<unknown>(this.preflightTracesPath(), {}), {} as Record<string, PreflightTrace>);
    return map[artifactId] ?? null;
  }

  // --- Autonomy Level ---

  setAutonomyLevel(level: "supervised" | "balanced" | "autonomous"): void {
    this.autonomyLevel = level;
    const prefs = this.readPreferences();
    prefs.autonomyLevel = level;
    this.writePreferences(prefs);
  }

  getAutonomyLevel(): "supervised" | "balanced" | "autonomous" {
    return this.autonomyLevel;
  }

  // --- Feedback notification (for long-poll) ---

  private feedbackWaiters: Array<() => void> = [];

  /** Register a waiter that resolves when new feedback arrives */
  waitForFeedback(timeoutMs = 30000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.feedbackWaiters = this.feedbackWaiters.filter((w) => w !== resolve);
        resolve();
      }, timeoutMs);

      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };

      this.feedbackWaiters.push(wrappedResolve);
    });
  }

  /** Notify all waiters that feedback has arrived */
  private notifyFeedbackWaiters(): void {
    const waiters = this.feedbackWaiters;
    this.feedbackWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // --- Full state (for web UI hydration) ---

  getFullState() {
    return {
      sessionId: this.sessionId,
      artifacts: this.artifacts,
      comments: this.comments,
      decisions: Array.from(this.decisions.values()),
      planReviews: Array.from(this.planReviews.values()),
      autonomyLevel: this.autonomyLevel,
      sessionMemory: this.getSessionMemory(),
      engagementMetrics: this.getEngagementMetrics(),
    };
  }

  // --- Static methods for multi-session access ---
  // G10 — the cross-session read helpers (listSessions / searchAll /
  // findPastPredictions / addRetrospective) and the AA5 ledger digest with
  // its BB2 cache now live in session-scan.ts and ledger-digest.ts. The
  // statics below are byte-compatible delegates so every FileStore.* call
  // site — HTTP routes, CLI, tests — keeps working unchanged.

  static listSessions = listSessions;

  static loadSession(projectRoot: string, sessionId: string) {
    const store = new FileStore(projectRoot, sessionId);
    return store.getFullState();
  }

  static searchAll = searchAll;

  /** N3.3 — see findPastPredictions in session-scan.ts. */
  static findPastPredictions = findPastPredictions;

  /** P2 — see addRetrospective in session-scan.ts. */
  static addRetrospective = addRetrospective;

  // BB2 — targeted cache invalidation for the digest below.
  static invalidateLedgerDigestCache = invalidateLedgerDigestCache;

  /** AA5 — project-wide preflight-trace digest; see ledger-digest.ts. */
  static ledgerDigest = ledgerDigest;
}
