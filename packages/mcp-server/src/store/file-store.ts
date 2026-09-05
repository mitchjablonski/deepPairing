import fs from "node:fs";
import path from "node:path";
import type { Artifact, ArtifactType, ArtifactStatus, Comment, CommentSuggestion, SessionAnnotation, TeamPreference, PreflightTrace, Request, RequestIntent, RequestScope, RequestSource } from "@deeppairing/shared";
import { suggestionSummary, isLateCommentableStatus, isClosedArtifactStatus, errorMessage, errorCode } from "@deeppairing/shared";
import { nanoid } from "nanoid";
import { getGlobalStore } from "./global-store.js";
import { capConceptLength } from "./concept-hygiene.js";
import { writeJsonAtomic, writeStringAtomic } from "./atomic-write.js";
import { salvageArray, salvageRecord, salvageLog } from "./salvage.js";
import { senseProjectGuardrails, loadTeamPreferences } from "./project-signals.js";
import type { ProjectGuardrail } from "./project-signals.js";
import { computeEngagementMetrics } from "./engagement-metrics.js";
import { scanForSecrets, scanContentForSecrets } from "../secret-scan.js";
import { listSessions, searchAll, listAllDecisions, groupByFeature, normalizeFeatureId } from "./session-scan.js";
import { ledgerDigest, invalidateLedgerDigestCache } from "./ledger-digest.js";
import { detectAndRecordGateEscape } from "./preflight-residual.js";
import { isCrossTerminalVerdictFlip } from "./verdict-guard.js";
import { readPostedReviews, appendPostedReview, type PostedReviewRecord } from "./posted-reviews.js";
import { ReviewPostJournal } from "./review-post-journal.js";
import type { IStore, DecisionRecord, PlanReviewRecord, RejectedApproach, RenderFailureRecord, StatusTransitionReason , RecordDecisionParams } from "./store-interface.js";

export type { DecisionRecord, PlanReviewRecord };
// Re-exported so existing `import { ProjectGuardrail } from "./file-store.js"`
// consumers keep working after the G10 extraction into project-signals.ts.
export type { ProjectGuardrail };

/**
 * #193 E2 — artifact types whose rejection captures NO cross-project taste
 * stance. Both are comprehension surfaces, not proposed approaches: the
 * EXPLAINER teaches how existing code already works, and the DEBRIEF accounts
 * for work already done. Rejecting either is a "redo this write-up" gesture, not
 * "never do it this way again" — so the reject-concept ledger (project-local
 * rejectedApproaches AND the global philosophy mirror) must never be written for
 * them. Enforced store-authoritatively in `recordRejectedApproach` and echoed at
 * the HTTP status route so no `ledger_write` is even broadcast.
 */
export const LEDGER_EXEMPT_REJECT_TYPES: ReadonlySet<ArtifactType> = new Set<ArtifactType>([
  "explainer",
  "debrief",
]);

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
  // #176 (Option A) — client-reported Mermaid render failures, keyed in-array by
  // (artifactId, visualId). Backed by render-failures.json (written only when
  // non-empty, like metrics.json), so a clean session's dir is byte-unchanged.
  private renderFailures: RenderFailureRecord[] = [];
  // G1 (#198b) — human-initiated REQUESTS to the agent, backed by requests.json
  // (written only when non-empty, like render-failures.json). Session-scoped and
  // reloaded across runs so a request survives a daemon restart.
  private requests: Request[] = [];
  // R1 (#279) — reviews this session has already POSTED to GitHub, backed by
  // posted-reviews.json (written only on the first post, so a session that
  // never posted has a byte-unchanged directory). Read by the authorization
  // gate to refuse a duplicate post; never sent anywhere.
  private postedReviews: PostedReviewRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string;
  /**
   * Demo isolation — `demo_`-prefixed sessions are the daemon's scripted,
   * throwaway demo (`POST /api/demo/run` + runDemoScript; the prefix is the
   * load-bearing demo marker across the daemon: broadcast tap, metrics guard,
   * session eviction). Field bug: the demo walked its scripted rejection
   * through this REAL store, so (a) recordRejectedApproach mirrored the
   * demo's example stance into the user's real ~/.deeppairing philosophy
   * ledger whenever the project had publish on — and non-idempotently, since
   * each run's fresh demo_<ts> sessionId defeats the II6 dedupe (6 runs → 6
   * duplicate instances the advisory tier then cited in real sessions) — and
   * (b) the scripted rejection landed in the project's preferences.json,
   * arming the REAL preflight with demo-fiction. Demo sessions therefore keep
   * preferences purely in memory (demoPreferences below) and never mirror
   * into the global ledger. Derived from the sessionId prefix (not a
   * constructor flag) so no future call site can construct a demo session
   * that leaks.
   */
  private readonly isDemoSession: boolean;
  /** In-memory preferences for demo sessions — never read from or written to
   *  the project's preferences.json. Null for real sessions. */
  private demoPreferences: Record<string, unknown> | null = null;
  private autonomyLevel: "supervised" | "balanced" | "autonomous" = "supervised";
  // #139 / X1 — detail density (verbosity). Default "terse" == plain-by-default,
  // so a preferences.json with no `detailDensity` field loads as terse. Terse
  // shortens PROSE only (never a review surface, never Evidence, never artifact
  // count); rich is the explicit opt-in for fuller explanatory prose.
  private detailDensity: "rich" | "terse" = "terse";
  // Explanation persona (the WHO axis) — orthogonal to autonomy (how many) and
  // detailDensity (how much). Default "auto" == let the agent infer the audience
  // from the work, so a session with no `persona` set reads as "auto" and
  // contributes nothing to the hint. A set value pins the audience frame.
  //
  // SCOPE: PER-SESSION. Persisted in this session's OWN bucket
  // (`sessions/<id>/session-prefs.json`), NOT the project-level
  // preferences.json — the v0.1.44 session split made each Claude session its
  // own bucket, so an override set in one session never leaks to another and
  // never touches the project moat (rejectedApproaches / guardrails /
  // globalLedgerPublish all stay in projectRoot/.deeppairing/preferences.json,
  // which persona does not read or write). See readSessionPrefs/writeSessionPrefs
  // below — that pair is the single swap point if the scope ever changes again.
  private persona: "auto" | "fluent-engineer" | "new-to-this-code" | "stakeholder" = "auto";

  // PP2 — last serialized bytes we wrote per file, so flush() can skip the disk
  // write (and the temp+rename) when a file is byte-identical to what's already
  // there. Kills the write-amplification where a single comment rewrote the
  // multi-MB artifacts.json: now only the file(s) that actually changed hit disk.
  // Cost: holds a serialized copy of each session file in RAM (grows with
  // artifacts.json size) — an accepted trade for the I/O savings. flush() drops
  // an entry whenever readIfChanged detects an external write, so the skip can
  // never defeat the U1 merge self-heal.
  private lastSerialized: Record<string, string> = {};
  // Exact observed bytes are both the three-way merge baseline and the change
  // detector. Metadata cannot detect equal-length edits with the same mtime.
  // Unlike the write-skip cache this survives external-change invalidation.
  private lastObserved: Record<string, string> = {};

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
    this.isDemoSession = this.sessionId.startsWith("demo_");
    if (this.isDemoSession) this.demoPreferences = {};
    this.ensureDir();
    this.load();
    this.loadPreferences();
    this.loadSessionPrefs();
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
    // FAIL CLOSED: this dial arms the auto-approve countdown, so an
    // unrecognized value (a poisoned file, or one written before the route was
    // enum-validated) must land on `supervised` (MOST supervision), never
    // survive as garbage that ArtifactStatusActions reads as "not supervised"
    // and arms auto-approve. Enum-guard the load like the density field below;
    // the `supervised` default (set at the field declaration) is the fallback,
    // so an invalid file self-heals to fail-safe on next write.
    if (
      prefs.autonomyLevel === "supervised" ||
      prefs.autonomyLevel === "balanced" ||
      prefs.autonomyLevel === "autonomous"
    ) {
      this.autonomyLevel = prefs.autonomyLevel;
    }
    // #139 / X1 — absent field keeps the "terse" default (plain-by-default;
    // an existing preferences.json written before this feature has no
    // `detailDensity`, so it also reads as terse).
    if (prefs.detailDensity === "rich" || prefs.detailDensity === "terse") {
      this.detailDensity = prefs.detailDensity;
    }
    // NOTE: persona is NOT loaded here — it is PER-SESSION, so it loads from the
    // session's own bucket in loadSessionPrefs() (called from the constructor),
    // never from the project-level preferences.json.
  }

  // Explanation persona is PER-SESSION: it lives in the session's own bucket
  // (sessions/<id>/session-prefs.json), so it neither reads from nor writes to
  // the project-level preferences.json (which holds the cross-session moat).
  private loadSessionPrefs(): void {
    // Demo sessions keep persona in memory only (default "auto") — nothing to
    // load, and nothing written to disk (see setPersona).
    if (this.isDemoSession) return;
    const prefs = this.readSessionPrefs();
    // Absent `persona` keeps the "auto" default (a session created before this
    // feature has no session-prefs.json, so it reads as "auto").
    if (
      prefs.persona === "auto" ||
      prefs.persona === "fluent-engineer" ||
      prefs.persona === "new-to-this-code" ||
      prefs.persona === "stakeholder"
    ) {
      this.persona = prefs.persona;
    }
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
    // #176 — rehydrate render failures. The salvage key is a synthetic
    // artifactId+visualId compound so a hand-edited duplicate collapses on load;
    // the compound is stripped back off before the record lands in memory.
    const rawFailures = this.loadJsonFile<unknown>(path.join(dir, "render-failures.json"), []);
    const keyedFailures = (Array.isArray(rawFailures) ? (rawFailures as RenderFailureRecord[]) : []).map((r) => ({
      ...r,
      __key: `${r?.artifactId} ${r?.visualId}`,
    }));
    this.renderFailures = FileStore.salvageArray<RenderFailureRecord & { __key: string }>(
      `${this.sessionId}:render-failures.json`,
      keyedFailures,
      "__key",
    ).map(({ __key, ...r }) => r);
    // G1 (#198b) — rehydrate human-initiated requests (id-keyed, salvage-tolerant).
    this.requests = FileStore.salvageArray<Request>(
      `${this.sessionId}:requests.json`, this.loadJsonFile<unknown>(path.join(dir, "requests.json"), []), "id");
    // R1 (#279) — rehydrate the posted-review record so the duplicate-post
    // refusal survives a daemon restart (the round-13 repeat was five calls in
    // one session, but a restart between them must not re-arm the post).
    this.postedReviews = readPostedReviews(this.projectRoot, this.sessionId);
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

  /** Load a JSON file with graceful error handling. Records exact bytes so a
   *  later flush can detect external writes and merge instead of clobber. */
  private loadJsonFile<T>(filePath: string, fallback: T): T {
    try {
      if (!fs.existsSync(filePath)) {
        delete this.lastObserved[filePath];
        return fallback;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      this.lastObserved[filePath] = raw;
      return parsed;
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        delete this.lastObserved[filePath];
        return fallback;
      }
      console.error(`[deepPairing] Corrupted file ${filePath}: ${errorMessage(err)}`);
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
   * Read the bytes even when metadata matches: "approved" and "rejected"
   * have the same length, and timestamps can be coarse or restored. This
   * adds reads at flush time, but unchanged bytes need no parsing or write.
   * It is change detection, not a lock across concurrent read/modify/write.
   */
  private readIfChanged<T>(filePath: string): T | null {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      if (raw === this.lastObserved[filePath]) return null;
      const parsed = JSON.parse(raw);
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
        // Swallow — the next mutation reschedules. ENOENT is the EXPECTED
        // teardown/eviction race (the session dir was rm'd out from under a
        // pending flush — demo-session eviction, test tmpdir cleanup); it's
        // benign and NOT logged: a stray console.error firing after a test's
        // env is torn down trips vitest's rpc-teardown error (flake #134), and
        // there is nothing actionable. But log GENUINE failures (EACCES,
        // ENOSPC, …) once per streak — a bare swallow of those turns a real
        // write failure into silent permanent data loss.
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT" && !this.flushFailureLogged) {
          this.flushFailureLogged = true;
          console.error(`[deepPairing] debounced flush failed for session ${this.sessionId}:`, err);
        }
      }
      this.flushTimer = null;
    }, 100);
  }

  /** Atomic write: delegates to writeJsonAtomic (PID+TS+random temp suffix
   *  so concurrent flushes to the same path can't truncate each other's tmp).
   *  Refreshes the byte baseline only after a successful rename. */
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
    this.lastObserved[filePath] = serialized;
  }

  /**
   * Merge against the last observed version, field by field. Unchanged local
   * fields adopt external edits; actual local edits win a same-field conflict.
   * Thus an unrelated local edit cannot restore a stale human verdict.
   */
  private mergeArrayById<T extends Record<string, any>>(
    inMemory: T[],
    onDisk: T[] | null,
    keyField: string,
    filePath: string,
  ): T[] {
    if (!onDisk || !Array.isArray(onDisk)) return inMemory;
    const baseline = JSON.parse(this.lastObserved[filePath] ?? "[]") as T[];
    const before = new Map((Array.isArray(baseline) ? baseline : []).map(r => [r?.[keyField], r]));
    const disk = new Map(onDisk.map(r => [r[keyField], r]));
    const seen = new Set(inMemory.map((r) => r[keyField]).filter(Boolean));
    const additions = onDisk.filter((r) => r[keyField] && !seen.has(r[keyField]));
    return [...additions, ...inMemory.map(local => {
      const base = before.get(local[keyField]);
      const external = disk.get(local[keyField]);
      if (!base || !external) return local;
      const merged = { ...external } as Record<string, unknown>;
      for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
        if (JSON.stringify(local[key]) !== JSON.stringify(base[key])) {
          if (key in local) merged[key] = local[key];
          else delete merged[key];
        }
      }
      return merged as T;
    })];
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
    // swallowed it, and — because the byte baseline only advances on a
    // successful load/write — EVERY subsequent flush re-read and re-threw:
    // persistence for the session silently stopped until the file was fixed.
    const diskArtifacts = this.readIfChanged<unknown>(artifactsPath);
    if (diskArtifacts) {
      this.artifacts = this.mergeArrayById(
        this.artifacts,
        FileStore.salvageArray<Artifact>(`${this.sessionId}:artifacts.json (external)`, diskArtifacts, "id"),
        "id",
        artifactsPath,
      );
      delete this.lastSerialized[artifactsPath];
    }
    const diskComments = this.readIfChanged<unknown>(commentsPath);
    if (diskComments) {
      this.comments = this.mergeArrayById(
        this.comments,
        FileStore.salvageArray<Comment>("comments.json (external)", diskComments, "id"),
        "id",
        commentsPath,
      );
      delete this.lastSerialized[commentsPath];
    }
    const diskDecisions = this.readIfChanged<unknown>(decisionsPath);
    if (diskDecisions) {
      this.decisions = new Map(this.mergeArrayById(Array.from(this.decisions.values()),
        FileStore.salvageArray<DecisionRecord>("decisions.json (external)", diskDecisions, "decisionId"),
        "decisionId", decisionsPath).map(d => [d.decisionId, d]));
      delete this.lastSerialized[decisionsPath];
    }
    const diskPlans = this.readIfChanged<unknown>(plansPath);
    if (diskPlans) {
      this.planReviews = new Map(this.mergeArrayById(Array.from(this.planReviews.values()),
        FileStore.salvageArray<PlanReviewRecord>("plan-reviews.json (external)", diskPlans, "artifactId"),
        "artifactId", plansPath).map(p => [p.artifactId, p]));
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
    // #176 — persist render failures only when there are any, so a session that
    // never had a broken diagram keeps a byte-identical dir (same rule as
    // metrics.json). Low-stakes + append-mostly; skips the U1 external-merge
    // dance the artifacts/comments files need.
    if (this.renderFailures.length > 0) {
      this.atomicWrite(path.join(dir, "render-failures.json"), this.renderFailures);
    }
    // G1 (#198b) — persist requests only when there are any (same tidy-dir rule
    // as metrics.json / render-failures.json). Append-mostly, low-stakes → skips
    // the U1 external-merge dance the artifacts/comments files need.
    if (this.requests.length > 0) {
      this.atomicWrite(path.join(dir, "requests.json"), this.requests);
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

  /** Cancel any pending debounced flush WITHOUT writing — for teardown or
   *  session eviction, so a timer can't fire against a dir that's about to be
   *  (or has been) removed. Unlike forceFlush(), this deliberately discards the
   *  pending write; the caller is disposing the store. Idempotent. */
  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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
    feature?: string | null;
  }): Artifact {
    const now = new Date().toISOString();
    // #206 (I1) — normalize the raw feature tag to a stable slug at the single
    // create choke point (parity with the secret scan below). An empty/
    // unsluggable tag yields undefined → the field is OMITTED from the stored
    // artifact, keeping clean JSON byte-identical to pre-#206.
    const featureId = normalizeFeatureId(params.feature)?.slug;
    // #162 — the store scans AUTHORITATIVELY, mirroring addComment. Pre-#162
    // the tool handlers pre-scanned and passed `secretWarnings` in, and this
    // method trusted the param — so a bearer-authed caller POSTing straight to
    // /api/internal/.../artifacts with a secret in `content` and no warnings
    // persisted unwarned (and could equally forge warnings onto clean
    // content). Now every create path — present_* handlers, revise_artifact's
    // supersede, the demo script, direct internal-route POSTs — converges on
    // this one scan; anything a caller claims (still possible via the
    // internal route's .passthrough() body) is ignored and recomputed.
    // Handlers that broadcast `secret_warning` read the result back off the
    // returned artifact, so there is exactly ONE scan per artifact.
    const secretWarnings = scanContentForSecrets(params.content);
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
      // V4/#158 — persist scanner matches ONLY when present so the stored
      // JSON for clean artifacts stays byte-identical to before.
      ...(secretWarnings.length > 0 ? { secretWarnings } : {}),
      // #206 (I1) — same omit-when-empty discipline for the feature tag.
      ...(featureId ? { featureId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.push(artifact);
    if (params.type === "code_change") this.touchCodeChangeMarker(now);
    // #176 — a revise (supersede) mints this v2 with parentId set; the parent's
    // render-failure records now describe a version the human no longer sees, so
    // clear them. The re-presented diagram will report afresh if it's still broken.
    if (params.parentId) this.clearRenderFailuresFor(params.parentId);
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

  /** G1 (#198c) — stamp the withdrawal reason onto the artifact's content so the
   *  status panel renders "↩ Retracted by agent — <reason>" inline (the reason
   *  also rides an agent comment for thread history). In-content patch, same
   *  mechanism update_plan_progress / changeset review use. No-op on a missing
   *  artifact. */
  setRetractReason(artifactId: string, reason: string): void {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (art) {
      (art.content as Record<string, unknown>).retractReason = reason;
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
      // O3 (#231) — cross-tab last-wins verdict guard (backstop). The HTTP
      // verdict route pre-checks this and returns a 409, but guard it here too
      // so NO path (a future caller, the daemon-internal route) can silently
      // reverse an already-final human verdict: refuse a human verdict flip from
      // one terminal verdict state to a DIFFERENT one (approved↔rejected↔revised).
      // Agent lifecycle transitions (supersede/retract/obsolete/revise/elicit)
      // carry non-human reasons and are never guarded; draft→terminal and
      // same-verdict re-asserts pass through untouched. See verdict-guard.ts.
      if (isCrossTerminalVerdictFlip(art.status, status, reason)) {
        console.error(
          `[deepPairing] refused cross-tab verdict flip on ${artifactId}: ` +
          `${art.status} → ${status} (reason=${reason}). A human verdict is already ` +
          `final; the stale tab keeps its current status. Reopen is not a supported gesture.`,
        );
        return;
      }
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
        // V-fix — flag this HUMAN-driven draft→terminal transition as an
        // UN-reported status change so the next check_feedback can surface
        // it BY ID (the field bug: the agent could only infer a v2-draft
        // approval from an aggregate count moving). Set in the exact same
        // human-review branch as the metrics record; agent-driven
        // (supersede/retract/obsolete) transitions deliberately skip it —
        // the agent caused those, so reporting them back is noise.
        (art as { statusChangeUnreported?: boolean }).statusChangeUnreported = true;
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
    // #162 — statusNote is free text, and this is the ONLY path that mutates
    // artifact content after creation (revise/supersede creates a NEW
    // artifact; renameArtifact touches the title; updateArtifactStatus is
    // status-only). A secret pasted into a note must trip the same
    // authoritative scan createArtifact runs. Recompute-and-replace over the
    // whole content: deterministic, so unchanged fields keep their warnings
    // and a cleaned note honestly clears its own. Key stays OMITTED (never an
    // empty array) so clean stored JSON is unchanged.
    const secretWarnings = scanContentForSecrets(art.content);
    if (secretWarnings.length > 0) {
      art.secretWarnings = secretWarnings;
    } else {
      delete art.secretWarnings;
    }
    art.updatedAt = new Date().toISOString();
    this.scheduleFlush();
    return art;
  }

  /** #171 — mark ONE file of a changeset reviewed/skipped, in place. See
   *  store-interface.ts. Human-driven review PROGRESS (not a decision record):
   *  it lives on the artifact content so it rides getArtifacts()/check_feedback
   *  and the WS full-artifact patch — the same in-content pattern
   *  updatePlanProgress uses. Reversible: passing `null` clears the file's
   *  state (e.g. un-checking "File looks right"). */
  setChangesetFileReview(
    artifactId: string,
    filePath: string,
    state: "reviewed" | "needs_changes" | "skipped" | null,
    reason?: string,
  ): Artifact | null {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (!art || art.type !== "changeset") return null;
    const content = art.content as {
      files?: Array<{ path?: string }>;
      reviewState?: Record<string, "reviewed" | "needs_changes" | "skipped">;
      reviewReasons?: Record<string, string>;
    };
    // Only accept a path that's actually part of the changeset — a review flag
    // for a phantom file is the caller's bug, not something to persist.
    if (!Array.isArray(content.files) || !content.files.some((f) => f.path === filePath)) return null;
    const reviewState = content.reviewState ?? {};
    const reviewReasons = content.reviewReasons ?? {};
    if (state === null) {
      delete reviewState[filePath];
      delete reviewReasons[filePath];
    } else {
      reviewState[filePath] = state;
      // #175 — a reason belongs only to a needs_changes flag; any other
      // disposition clears a stale reason so it can't leak into a later send-back.
      if (state === "needs_changes" && reason && reason.trim()) {
        reviewReasons[filePath] = reason.trim();
      } else {
        delete reviewReasons[filePath];
      }
    }
    content.reviewState = reviewState;
    content.reviewReasons = reviewReasons;
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
    ].map((f) => `${f}=${t[f] ?? ""}`).join("|")
      // #140 — two same-text comments on DIFFERENT regions of the same visualId
      // must NOT collapse. Key off the region's labels (the stable anchor; ids
      // are render-unique). A label-less region falls back to its rounded rect
      // so distinct blank-area drags still stay distinct.
      + `|region=${FileStore.regionKey(t.region)}`;
  }

  private static regionKey(region: unknown): string {
    if (!region || typeof region !== "object") return "";
    const r = region as { x?: number; y?: number; w?: number; h?: number; labels?: unknown };
    const labels = Array.isArray(r.labels)
      ? r.labels.filter((l): l is string => typeof l === "string").map((l) => l.trim().replace(/\s+/g, " ").toLowerCase())
      : [];
    if (labels.length > 0) return [...labels].sort().join(",");
    const round = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : "");
    return `rect:${round(r.x)},${round(r.y)},${round(r.w)},${round(r.h)}`;
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
    suggestion?: CommentSuggestion;
    verdictFeedback?: boolean;
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

    // #160 — scan the comment body for secret shapes at the single choke-point
    // every comment creator converges on (web POST /api/comments, verdict-
    // feedback comments, agent comments via the daemon's internal route). The
    // scanner's own threat model has named comment bodies since V4, but only
    // artifacts were ever scanned — a key pasted into a comment landed on disk
    // and flowed into agent context (check_feedback) with zero warning.
    // Labels/pattern/line only, NEVER the matched value.
    const secretWarnings = scanForSecrets(params.content);
    // #187 — STORE-AUTHORITATIVE follow-up flag. A HUMAN comment landing on an
    // already-CLOSED-but-commentable (approved) artifact is a late follow-up on a
    // standing verdict, not review feedback. The store owns the artifact status,
    // so it stamps the flag here (mirroring the #162 secret-scan choke-point) —
    // the client can neither forge it (a tab claiming followUp on a draft) nor
    // suppress it (a tab hiding it on an approved artifact). Only "approved"
    // qualifies (isLateCommentableStatus), so a SEND-BACK/REJECT verdict-feedback
    // comment — posted the instant status flips to revised/rejected — is NEVER
    // mis-stamped. Agent comments are excluded: the lane is about human input.
    // #187 — `verdictFeedback` excludes the ONE trap the status enum can't catch:
    // an APPROVE-WITH-FEEDBACK note (status is ALREADY `approved` when the status
    // handler posts it), which is a review verdict, not a late follow-up. That
    // flag is server-only (the status handler sets it; the public comment route
    // never forwards it and the internal daemon route strips it).
    const targetArtifact =
      params.artifactId && params.artifactId !== "__session__"
        ? this.artifacts.find((a) => a.id === params.artifactId)
        : undefined;
    const isFollowUp =
      params.author === "human" &&
      !params.verdictFeedback &&
      !!targetArtifact &&
      isLateCommentableStatus(targetArtifact.status);
    const comment: Comment = {
      id: params.id,
      sessionId: this.sessionId,
      target: { artifactId: params.artifactId, ...params.target },
      parentCommentId: params.parentCommentId ?? null,
      author: params.author,
      content: params.content,
      intent: params.intent,
      // #160 — spread so the field is simply absent on clean comments
      // (back-compat: stored JSON for clean comments stays byte-identical).
      ...(secretWarnings.length > 0 ? { secretWarnings } : {}),
      // FN1 — persist attached code evidence (answer_question). Spread so the
      // field is simply absent when there's none (back-compat with stored data).
      ...(params.codeReferences && params.codeReferences.length > 0
        ? { codeReferences: params.codeReferences }
        : {}),
      // #172 — persist the first-class suggested edit. Spread so a plain comment
      // stays byte-identical on disk.
      ...(params.suggestion ? { suggestion: params.suggestion } : {}),
      // #187 — spread so a normal draft-review comment is byte-identical on disk.
      ...(isFollowUp ? { followUp: true } : {}),
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

  /** #192 — ALL comments, in-memory (no disk read). Mirrors getArtifacts() so the
   *  daemon's per-poll unanswered-question count can avoid getFullState()'s
   *  preferences.json re-read (the PP4 anti-pattern the pendingCount path
   *  deliberately dodges). */
  getComments(): Comment[] {
    return this.comments;
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

  /**
   * #172 — patch a comment's suggestion state machine. Records the ledger
   * side-effects when — and only when — a suggestion first gets an
   * `appliedInVersion` stamp:
   *
   *   - APPLIED (verbatim/extension of the HUMAN's edit, no counter) + a genuine
   *     "why" note → the why becomes an approved pattern (a durable preference).
   *   - INSISTED (the human overrode the agent's counter) → the override is
   *     recorded regardless of a note, using the human's reason when present.
   *   - APPLIED with a `counter` present (the human took the AGENT's counter) →
   *     nothing recorded: the human's original edit did not win.
   *
   * All ledger writes go through recordApprovedPattern, which already honors
   * demo-session isolation (#193, in-memory only) and the global-ledger publish
   * gate — so a demo run stays in-memory and no global write happens beyond what
   * the existing gate allows.
   */
  updateCommentSuggestion(commentId: string, update: import("./store-interface.js").SuggestionUpdate): Comment | undefined {
    const comment = this.comments.find((c) => c.id === commentId);
    if (!comment?.suggestion) return undefined;
    const prev = comment.suggestion;
    const prevAppliedVersion = prev.appliedInVersion;

    const next: CommentSuggestion = {
      ...prev,
      ...(update.state !== undefined ? { state: update.state } : {}),
      ...(update.appliedInVersion !== undefined ? { appliedInVersion: update.appliedInVersion } : {}),
      ...(update.counter !== undefined ? { counter: update.counter } : {}),
    };
    comment.suggestion = next;

    // A human take-counter / insist re-queues the comment so the agent's next
    // check_feedback poll picks up the new obligation.
    if (update.resetAcknowledged) {
      comment.acknowledged = false;
      this.notifyFeedbackWaiters();
    }

    // Ledger: fire once, at the moment the edit first ships in a version.
    const newlyApplied = next.appliedInVersion != null && prevAppliedVersion == null;
    if (newlyApplied) {
      // A genuine "why" is any content that isn't the auto-generated summary the
      // composer falls back to when the note is left blank.
      const summary = suggestionSummary(comment.target.filePath, next.lineStart, next.lineEnd);
      const why = comment.content.trim();
      const hasWhy = why.length > 0 && why !== summary;

      if (next.state === "insisted") {
        // The human overrode the agent's counter — record the override with
        // their reason (the why note), or a generic override line when blank.
        this.recordApprovedPattern({
          description: hasWhy
            ? why
            : `Human insisted on their exact edit at ${summary.replace(/^Suggested edit to /, "")}`,
        });
      } else if (!next.counter && hasWhy) {
        // The human's own edit was applied (verbatim or with extension) and they
        // told us why → a durable preference.
        this.recordApprovedPattern({ description: why });
      }
      // else: took-the-counter (counter present) or no why → this-edit-only, no
      // ledger entry.
    }

    this.scheduleFlush();
    return comment;
  }

  // --- Status changes (V-fix) ---

  /**
   * V-fix — artifacts whose HUMAN-driven draft→terminal transition
   * (approved / rejected / changes_requested) check_feedback has not yet
   * reported. Mirrors getUnacknowledgedComments / getResolvedDecisions:
   * the caller reports them once, then acknowledgeStatusChanges drains the
   * flag. Agent-driven transitions never set the flag, so they never
   * appear here. Old artifacts lacking the field simply don't match.
   */
  getUnacknowledgedStatusChanges(): Artifact[] {
    return this.artifacts.filter(
      (a) => (a as { statusChangeUnreported?: boolean }).statusChangeUnreported === true,
    );
  }

  /**
   * V-fix — clear the un-reported flag for the given artifact ids after
   * check_feedback has surfaced them once. Mirrors acknowledgeComments /
   * acknowledgeDecisions exactly (same loop + same debounced flush).
   */
  acknowledgeStatusChanges(ids: string[]): void {
    for (const a of this.artifacts) {
      if (ids.includes(a.id)) {
        (a as { statusChangeUnreported?: boolean }).statusChangeUnreported = false;
      }
    }
    this.scheduleFlush();
  }

  // --- Render failures (#176, Option A) ---

  /**
   * #176 — record a client-reported Mermaid render failure, upserting by
   * (artifactId, visualId). The browser dedupes per MOUNT, but that ref is
   * per-component-instance, so a remount (scroll a still-broken diagram out of
   * view and back, a virtualized-list recycle) spawns a fresh instance that
   * re-POSTs the SAME error. The store is the only place that can dedupe across
   * remounts: re-arm for check_feedback ONLY when this is a genuinely-new
   * failure — the record didn't exist, was still pending (unacknowledged), or
   * the error CHANGED. A re-report of an ALREADY-acknowledged, UNCHANGED error
   * leaves the record acknowledged (just refreshes `at`) so the agent isn't
   * re-notified about a diagram it already heard was broken.
   *
   * AUTHORITATIVE secret scan (mirrors createArtifact's #162 scan): a mermaid
   * PARSER error commonly echoes the offending source line — which can carry a
   * node-label secret — and a title is agent-authored text. Either that trips
   * the scanner is REDACTED before it's stored (and thus before it can reach
   * the agent via check_feedback). The scanner is a detector, not a surgical
   * redactor, so on any hit we drop the whole field to a safe placeholder — the
   * agent still learns WHICH visual broke, just not the sensitive detail.
   *
   * Redaction is BEST-EFFORT on the same precision-over-recall `scanForSecrets`
   * (~14 vendor-prefixed shapes) that guards artifact content: a non-prefixed
   * secret echoed in an error (a `postgres://` URL, a bare high-entropy token)
   * is NOT caught here. The PRIMARY mitigations live upstream — the client
   * sends only the error's FIRST line (mermaid's `Parse error on line N:`), so
   * the echoed source excerpt on the following lines is dropped, and the wire
   * never carries full source. Broadening the scanner is a separate repo-wide
   * decision, deliberately out of scope.
   */
  recordRenderFailure(params: { artifactId: string; visualId: string; error: string; title?: string }): void {
    const safeError = scanForSecrets(params.error).length > 0
      ? "[render error withheld — a secret-shaped value was detected in it]"
      : params.error;
    const safeTitle = params.title && scanForSecrets(params.title).length > 0 ? undefined : params.title;
    const at = new Date().toISOString();
    const existing = this.renderFailures.find(
      (r) => r.artifactId === params.artifactId && r.visualId === params.visualId,
    );
    if (existing) {
      // Re-arm only for a genuinely-new failure: still pending, or the error
      // changed. A remount re-POSTing the SAME already-acknowledged error must
      // NOT re-deliver — refresh the timestamp and leave it acknowledged.
      const isNewFailure = !existing.acknowledged || existing.error !== safeError;
      existing.error = safeError;
      existing.title = safeTitle;
      existing.at = at;
      if (isNewFailure) {
        existing.acknowledged = false;
        this.scheduleFlush();
        this.notifyFeedbackWaiters();
      } else {
        this.scheduleFlush();
      }
      return;
    }
    this.renderFailures.push({
      artifactId: params.artifactId,
      visualId: params.visualId,
      ...(safeTitle ? { title: safeTitle } : {}),
      error: safeError,
      at,
      acknowledged: false,
    });
    this.scheduleFlush();
    // Wake any parked check_feedback long-poll (same as a human comment) so the
    // agent hears about the broken diagram promptly, not on the next 30s tick.
    this.notifyFeedbackWaiters();
  }

  getUnacknowledgedRenderFailures(): RenderFailureRecord[] {
    return this.renderFailures.filter((r) => !r.acknowledged);
  }

  acknowledgeRenderFailures(keys: Array<{ artifactId: string; visualId: string }>): void {
    for (const r of this.renderFailures) {
      if (keys.some((k) => k.artifactId === r.artifactId && k.visualId === r.visualId)) {
        r.acknowledged = true;
      }
    }
    this.scheduleFlush();
  }

  // --- G1 (#198b) — human-initiated requests ------------------------------
  /** Persist a human-composed request. `notifyFeedbackWaiters` wakes a live
   *  agent's check_feedback long-poll exactly like a new human comment does. */
  addRequest(params: { text: string; intent: RequestIntent; source?: RequestSource; scope?: RequestScope }): Request {
    // #204 (code lens F1) — scan the request's free text at the single choke-point
    // every request creator converges on (mirroring the #160 comment scan). A
    // request is HUMAN-authored text that flows into agent context via
    // check_feedback and lands on disk — the SAME risk the comment/artifact/
    // render-failure scans already cover — yet it was the last human-text ingress
    // that bypassed the store-authoritative scan. Labels/pattern/line only, NEVER
    // the matched value.
    const secretWarnings = scanForSecrets(params.text);
    const request: Request = {
      id: `req_${nanoid(10)}`,
      text: params.text,
      intent: params.intent,
      createdAt: new Date().toISOString(),
      // #204 — spread so the field is simply absent on clean requests (back-compat:
      // stored JSON for clean requests stays byte-identical, and old persisted
      // requests without the field load unchanged).
      ...(secretWarnings.length > 0 ? { secretWarnings } : {}),
      // P2 (round-11 MED 3) — the request's PROVENANCE + SCOPE as data. Spread
      // so both keys are simply ABSENT on a plain composer request: stored JSON
      // for every pre-P2-shaped request stays byte-identical, and old persisted
      // requests without them load unchanged.
      ...(params.source ? { source: params.source } : {}),
      ...(params.scope && Object.keys(params.scope).length > 0 ? { scope: params.scope } : {}),
    };
    this.requests.push(request);
    this.scheduleFlush();
    this.notifyFeedbackWaiters();
    return request;
  }

  getRequests(): Request[] {
    return this.requests;
  }

  /** Unserved requests — the agent still owes a response (drives the check_feedback
   *  priority line + the first-call obligations inventory + the composer's
   *  unserved badge). */
  getPendingRequests(): Request[] {
    return this.requests.filter((r) => !r.servedByArtifactId);
  }

  /** Link a request to the artifact that fulfilled it (idempotent — a re-serve
   *  updates the link). Returns false (no write) when the id isn't found, so the
   *  caller doesn't claim a link that didn't happen. */
  markRequestServed(requestId: string, artifactId: string): boolean {
    const req = this.requests.find((r) => r.id === requestId);
    if (!req) return false;
    req.servedByArtifactId = artifactId;
    this.scheduleFlush();
    return true;
  }

  /** #176 — drop every render-failure record for a superseded artifact id. A
   *  revise (present a new version) mints a fresh artifact, so the OLD one's
   *  broken-diagram records are stale — clear them so a resolved diagram can't
   *  keep haunting check_feedback. No-op when the id has no records. */
  private clearRenderFailuresFor(artifactId: string): void {
    const before = this.renderFailures.length;
    this.renderFailures = this.renderFailures.filter((r) => r.artifactId !== artifactId);
    if (this.renderFailures.length !== before) this.scheduleFlush();
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
    // #209 (J1) — the resolution and the status advance land in ONE store call
    // so there is no observable window where the decision is resolved-but-draft.
    // The human actively PICKED an option — that IS the approval — so the backing
    // decision artifact advances to the terminal `approved` state, and every
    // status-derived surface (header pill, sidebar dot, Features chip,
    // pendingCount/TurnIndicator, getPendingDecisions) follows automatically off
    // an honest status. This is the SINGLE unification point for the two
    // resolution paths: the public /api/decisions route AND the daemon-internal
    // /resolve route both funnel through here, so neither can leave the artifact
    // stranded in draft. Only advance a still-open (draft/reviewing) artifact:
    // never clobber one already closed (retracted/superseded/…) or already
    // approved. updateArtifactStatus schedules the SAME debounced flush, so the
    // response and the status persist together (atomic to any on-disk reader).
    // Q3 review (LOW 11) — this `draft || reviewing` test is NOT the closed-set
    // predicate wearing a different hat, and must not be "unified" into it. The
    // closed set answers "can the human still act on this record?"; this answers
    // the narrower "may I ADVANCE this artifact to approved right now?", for
    // which `revised` is deliberately excluded — a sent-back artifact is still
    // OPEN (isClosedArtifactStatus says so, correctly) but resolving a decision
    // must not silently overwrite the human's request-changes verdict with an
    // approval. Different question, different answer, on purpose.
    const backing = this.artifacts.find((a) => a.id === dec.artifactId);
    if (backing && (backing.status === "draft" || backing.status === "reviewing")) {
      this.updateArtifactStatus(dec.artifactId, "approved", "ui_decision_resolve");
    }
    this.scheduleFlush();
    this.notifyFeedbackWaiters();
  }

  getDecisionResponse(decisionId: string): { optionId: string; reasoning?: string } | null {
    return this.decisions.get(decisionId)?.response ?? null;
  }

  /** An artifact whose review can never resolve normally any more — it was
   *  superseded by a newer version, retracted, rejected, marked obsolete, or
   *  (P3) already APPROVED. A pending decision/plan-review record pointing at
   *  such an artifact is an orphan and must NOT keep reporting as "waiting" (it
   *  would block check_feedback forever). A record with no backing artifact is
   *  left as-is (artifacts are never deleted in production; only their status
   *  changes), so unknown ids stay pending rather than vanishing.
   *
   *  P3 — `approved` was the omission, and it was live in three surfaces: the
   *  check_feedback WAITING nag, the project decisions modal's permanent amber
   *  "Awaiting your decision", and the Features open-items count. A record only
   *  reaches this branch UNRESOLVED (getPendingDecisions/getPendingPlanReviews
   *  filter on `!response` / `!verdict` first), and the normal paths always
   *  write the resolution: resolveDecision records the response in the SAME
   *  call that advances the artifact to approved, and the /status route calls
   *  resolvePlanReview alongside every non-obsolete verdict. So nothing
   *  legitimately-open is dropped here — only genuine orphans, whose artifact
   *  went terminal by another path (the /api/decisions no-record fallback, a
   *  straight Approve on the card) and which the human can no longer act on.
   *  Q3 — the status SET itself no longer lives here. THIS QUESTION ("can the
   *  human still act on the record hanging off this artifact?") was expressed
   *  three times (here; CLOSED_ARTIFACT_STATUSES in session-scan.ts; and —
   *  disagreeing on `revised` — check_feedback's `openArtifactIds`, which read
   *  openness as `draft || reviewing` and so DROPPED a pending decision this
   *  method kept). Those three now call the ONE shared `isClosedArtifactStatus`
   *  (@deeppairing/shared); the session-scan parity pin in
   *  list-all-decisions.test.ts stays as the guard.
   *
   *  Q3 review (LOW 11) — scoped claim, deliberately. `draft || reviewing` also
   *  appears in resolveDecision above, and that one is a DIFFERENT semantic —
   *  "may I advance this artifact to approved right now?", which excludes
   *  `revised` on purpose. It is not a fourth copy and must not be folded in;
   *  see the note at that call site. */
  private isArtifactClosed(artifactId: string): boolean {
    const art = this.artifacts.find((a) => a.id === artifactId);
    if (!art) return false;
    return isClosedArtifactStatus(art.status);
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
   * one-time `init` prompt (or `node packages/mcp-server/dist/cli/init.js philosophy publish on/off`).
   */
  private globalLedgerPublishEnabled(): boolean {
    return this.readPreferences().globalLedgerPublish === true;
  }

  /**
   * III8 — flip the per-project publish opt-in. Used by the `init`
   * prompt, by the `node packages/mcp-server/dist/cli/init.js philosophy publish on/off` command,
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
    // #193 E2 — STORE-AUTHORITATIVE ledger guard (mirrors the #187 follow-up
    // stamping: the store owns the invariant so the client can neither forge
    // nor suppress it). The comprehension artifacts are NOT proposed approaches:
    // an EXPLAINER teaches how existing code works, a DEBRIEF accounts for work
    // already done. Rejecting either captures NO taste-stance — there is no
    // approach being weighed — so we refuse to write a cross-project ledger key
    // (or the project-local rejectedApproaches entry) for them. The plain
    // `rejected` STATUS still lands (updateArtifactStatus ran earlier); only the
    // stance capture is suppressed. Resolved from the source artifact's type so
    // the guard holds no matter which route reaches here (the HTTP status route
    // guards too, but this is the last word).
    if (sourceArtifactId) {
      const src = this.artifacts.find((a) => a.id === sourceArtifactId);
      if (src && LEDGER_EXEMPT_REJECT_TYPES.has(src.type)) return;
      // INTENTIONAL fail-open: an unresolvable sourceArtifactId (not in the
      // in-memory set) does NOT block the write — it records, matching the
      // gate's fail-open convention. Today the only caller is the HTTP /status
      // route, which resolves-and-short-circuits the exempt types BEFORE
      // calling us, so an exempt artifact never reaches here with an
      // unresolvable id. Do NOT "harden" this into fail-closed: a future
      // pre-load reject path (one that records before the artifact is in
      // `this.artifacts`) would then silently drop every stance. If such a path
      // is ever added, thread the type explicitly rather than flipping this.
    }
    // Phase-1 (D) — before recording, check whether this rejection is a "gate
    // escape": the human is re-flagging an artifact the gate ADMITTED, with
    // ZERO lexical overlap against everything the gate weighed. That's the
    // embeddings-justifying signal. Best-effort telemetry; never blocks the
    // write. Only meaningful when the rejection points at a source artifact.
    if (sourceArtifactId) {
      try {
        const trace = this.getPreflightTrace(sourceArtifactId);
        detectAndRecordGateEscape({
          projectRoot: this.projectRoot,
          rejectedConcept: concept?.trim() || description.trim(),
          reason,
          trace,
        });
      } catch {
        // Telemetry only — never let it interfere with the rejection.
      }
    }
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
    // Demo isolation — a demo session's scripted rejection must NEVER reach
    // the real cross-project ledger. NOTE: the three `!this.isDemoSession`
    // gates (here + approved + override) are the BELT — the in-memory
    // demoPreferences layer (which never carries the publish flag) is the
    // suspenders, so removing just these gates stays green today. They are
    // deliberate defense-in-depth, not dead code: they keep the invariant
    // even if demo prefs ever get seeded from disk. Don't strip them.
    const conceptKey = concept?.trim() || description.trim();
    if (conceptKey && !this.isDemoSession && this.globalLedgerPublishEnabled()) {
      try {
        // Q2 review H2 — publish the MINIMUM that makes the stance usable
        // elsewhere: the concept, the reason, and the attribution. `description`
        // (the artifact TITLE) is deliberately NO LONGER published. It was a
        // second unbounded agent-authored string riding into a shared file —
        // and agents title artifacts after the file they touched, which is how
        // "packages/api/src/auth/session-store.ts — swap Redis for a Map"
        // reached the ledger from a UI promising no file paths leave the
        // project. It also had no reader anywhere in the codebase: write-only
        // data whose only effect was to widen the disclosure surface. Dropping
        // it makes the consent copy true as written. The field stays on the
        // TYPE so existing ledgers that carry it still parse.
        //
        // The cap is the other half: a ledger key is a short phrase you could
        // say out loud, and an unbounded one published into a shared file is
        // both a storage and a disclosure hazard. Applied at EVERY publish site
        // or an approval and its rejection would bucket under different keys.
        getGlobalStore().recordInstance(capConceptLength(conceptKey), {
          project: this.projectHint,
          sessionId: this.sessionId,
          verdict: "rejected",
          reason,
        });
      } catch {
        // Non-fatal — losing a ledger append doesn't break the session.
      }
    }

    const prefs = this.readPreferences();
    const rejected = this.normalizeRejectedApproaches(prefs.rejectedApproaches ?? []);
    // Dedupe on the EXACT description. P3 note (deliberate, not an oversight):
    // this means a pre-P3 decision key ("<background paragraph>: Redis") and its
    // post-P3 equivalent ("Cache backend: Redis") can coexist as two rows for
    // the same stance in a long-lived project. That is the conservative choice —
    // deduping on the post-colon noun instead would silently MERGE genuinely
    // different stances that happen to share a noun ("Deploy: Railway" vs
    // "Logging: Railway"), and merging is lossy where a duplicate is only
    // cosmetic. The gate is unaffected either way: both rows match the same
    // proposals (same specificNoun, same concept), so the extra row costs a
    // little display/near-miss noise, never a wrong block. If the duplicate ever
    // bothers a user, `deeppairing philosophy remove <concept>` drops it.
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
    // Demo isolation — same never-mirror gate as the rejected path.
    const conceptKey = concept?.trim() || description.trim();
    if (conceptKey && !this.isDemoSession && this.globalLedgerPublishEnabled()) {
      try {
        // Q2 review H2 — same minimum-payload + cap rule as the rejected path.
        getGlobalStore().recordInstance(capConceptLength(conceptKey), {
          project: this.projectHint,
          sessionId: this.sessionId,
          verdict: "approved",
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
    // Demo isolation — same never-mirror gate as the record paths.
    const conceptKey = concept?.trim() || description?.trim() || "";
    if (conceptKey && !this.isDemoSession && this.globalLedgerPublishEnabled()) {
      try {
        // Q2 review LOW — the stored reason said "not my taste", the label of a
        // button that no longer exists. It is written into the user's own data
        // and read back in the Ledger drawer, so it has to match what they
        // clicked: "Retire this stance". Same minimum-payload + cap rule.
        getGlobalStore().recordInstance(capConceptLength(conceptKey), {
          project: this.projectHint,
          sessionId: this.sessionId,
          verdict: "approved",
          reason: "Retired by you — the gate was blocking something you wanted",
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
    // Demo isolation — demo sessions read their own in-memory copy, never the
    // project's real preferences.json (whose rejectedApproaches feed the REAL
    // preflight, and whose globalLedgerPublish flag arms the global mirror).
    if (this.demoPreferences) return this.demoPreferences;
    const prefsPath = path.join(this.basePath, "preferences.json");
    return FileStore.salvageRecord("preferences.json", this.loadJsonFile<unknown>(prefsPath, {}), {} as Record<string, any>);
  }

  private writePreferences(prefs: Record<string, any>): void {
    // Demo isolation — a demo run must leave preferences.json byte-identical.
    if (this.demoPreferences) {
      this.demoPreferences = prefs;
      return;
    }
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

  // --- Posted reviews (R1 #279) ---

  /** Fresh journal reads and short disk claims are shared with CLI processes. */
  get reviewPosts(): ReviewPostJournal {
    return new ReviewPostJournal(this.projectRoot, this.sessionId);
  }

  /**
   * R1 (#279) — record that a review LANDED on a PR. Called only after `gh`
   * returned success, by whichever door posted; the authorization gate reads
   * it back through getFullState and refuses a second post to the same PR
   * unless the human said "post again".
   *
   * Written straight through (writeJsonAtomic) rather than via the debounced
   * flush, like annotations: the fact it records already happened in the
   * outside world, so it must be on disk before the tool returns — a crash
   * between the post and the flush would re-arm a duplicate.
   */
  recordPostedReview(record: PostedReviewRecord): void {
    this.postedReviews = appendPostedReview(this.projectRoot, this.sessionId, record);
  }

  /**
   * R1 (#279) F1 — RE-READ the sidecar, don't trust the cache.
   *
   * The idempotency store is shared by TWO processes with TWO separate
   * FileStore instances over the same directory: the daemon holds a long-lived
   * per-session FileStore (daemon/routes.ts), while `deeppairing post-pr-review`
   * runs in its own process and constructs its own. When the CLI door posts, it
   * appends to posted-reviews.json — but the daemon's in-memory `postedReviews`,
   * loaded once at hydration, never learns of it, so a subsequent MCP post to
   * the same PR would be authorized as a first post (a duplicate). The sidecar
   * IS the shared source of truth the design intends; this makes the read honour
   * that. Cheap (one small JSON read per authorize), and fail-open: a missing or
   * unreadable file returns [], which can only ALLOW a duplicate, never refuse a
   * legitimate post — while the verdict checks it feeds stay fail-closed.
   */
  getPostedReviews(): PostedReviewRecord[] {
    this.postedReviews = readPostedReviews(this.projectRoot, this.sessionId);
    return this.postedReviews;
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

  // --- Detail Density (#139) ---

  setDetailDensity(density: "rich" | "terse"): void {
    this.detailDensity = density;
    const prefs = this.readPreferences();
    prefs.detailDensity = density;
    this.writePreferences(prefs);
  }

  getDetailDensity(): "rich" | "terse" {
    return this.detailDensity;
  }

  // --- Explanation persona (the WHO axis) ---
  //
  // SCOPE: PER-SESSION. Persisted in this session's own bucket
  // (sessions/<id>/session-prefs.json) via readSessionPrefs/writeSessionPrefs —
  // NOT the project-level preferences.json. Two sessions in the same project
  // hold independent personas, and a persona set never touches the project moat.
  // This pair (plus the mirror field + loadSessionPrefs above) is the single
  // swap point if the scope ever changes again.

  setPersona(persona: "auto" | "fluent-engineer" | "new-to-this-code" | "stakeholder"): void {
    this.persona = persona;
    // Demo sessions keep persona in memory only — never write to disk (keeps a
    // demo run's on-disk footprint unchanged), mirroring the demoPreferences
    // discipline for the project prefs.
    if (this.isDemoSession) return;
    const prefs = this.readSessionPrefs();
    prefs.persona = persona;
    this.writeSessionPrefs(prefs);
  }

  getPersona(): "auto" | "fluent-engineer" | "new-to-this-code" | "stakeholder" {
    return this.persona;
  }

  // Per-session preferences bucket (currently just `persona`). Separate from the
  // project-level readPreferences/writePreferences on purpose: this file lives
  // under the SESSION dir, so it never carries — or risks clobbering — the
  // cross-session moat (rejectedApproaches / approvedPatterns / guardrails /
  // globalLedgerPublish) that project preferences.json owns.
  private sessionPrefsPath(): string {
    return path.join(this.sessionDir(), "session-prefs.json");
  }

  private readSessionPrefs(): Record<string, unknown> {
    return FileStore.salvageRecord(
      // Session-scope the salvage suppression key (F10's sid:file format).
      `${this.sessionId}:session-prefs.json`,
      this.loadJsonFile<unknown>(this.sessionPrefsPath(), {}),
      {} as Record<string, unknown>,
    );
  }

  private writeSessionPrefs(prefs: Record<string, unknown>): void {
    writeJsonAtomic(this.sessionPrefsPath(), prefs);
  }

  // --- Feedback notification (for long-poll) ---

  private feedbackWaiters: Array<() => void> = [];

  /** Register a waiter that resolves when new feedback arrives */
  waitForFeedback(timeoutMs = 30000): Promise<void> {
    return new Promise((resolve) => {
      // H1-1 — the array holds `wrappedResolve`, NOT `resolve`. Filtering on
      // `resolve` never matched, so every timed-out 30s long-poll leaked its
      // wrappedResolve closure into feedbackWaiters unbounded (a human who
      // walks away while the agent keeps polling grows the array forever, and
      // notifyFeedbackWaiters then fan-outs to thousands of dead waiters).
      // Filter on the value actually pushed.
      const timer = setTimeout(() => {
        this.feedbackWaiters = this.feedbackWaiters.filter((w) => w !== wrappedResolve);
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
      // G1 (#198b) — requests ride the full-state hydration so the web UI and
      // the agent surfaces (check_feedback carryover, first-call obligations)
      // read them the same way. Empty by default → byte-compatible for sessions
      // that never used the composer.
      requests: this.requests,
      // R1 (#279) — the posted-review record rides full-state hydration so BOTH
      // doors (the MCP tool via getFullState, the CLI via loadSession) see the
      // same "already posted" fact with no extra round-trip. Spread-when-present
      // keeps the payload byte-identical for every session that never posted.
      // Read through getPostedReviews (NOT the cached field): the daemon holds
      // one long-lived FileStore per session, so a post made by the CLI's OWN
      // separate FileStore lands in the sidecar the daemon's in-memory copy
      // never saw — getPostedReviews re-reads it (R1 F1 cross-door fix).
      ...(() => { const pr = this.getPostedReviews(); return pr.length > 0 ? { postedReviews: pr } : {}; })(),
      autonomyLevel: this.autonomyLevel,
      detailDensity: this.detailDensity,
      // Explanation persona (the WHO axis) rides full-state hydration so the
      // companion UI can show + flip it without a second round trip. "auto" by
      // default → byte-compatible for every session that never set a persona.
      persona: this.persona,
      // Q2 — the cross-project publish opt-in rides full-state hydration so
      // the companion UI can SHOW it (and the first-reject card can decide
      // whether to offer the enable). Reads from the global ledger are always
      // on; this flag gates WRITES only.
      globalLedgerPublish: this.globalLedgerPublishEnabled(),
      sessionMemory: this.getSessionMemory(),
      engagementMetrics: this.getEngagementMetrics(),
    };
  }

  // --- Static methods for multi-session access ---
  // G10 — the cross-session read helpers (listSessions / searchAll) and the
  // AA5 ledger digest with its BB2 cache now live in session-scan.ts and
  // ledger-digest.ts. The statics below are byte-compatible delegates so every
  // FileStore.* call site — HTTP routes, CLI, tests — keeps working unchanged.

  static listSessions = listSessions;

  static loadSession(projectRoot: string, sessionId: string) {
    const store = new FileStore(projectRoot, sessionId);
    return store.getFullState();
  }

  static searchAll = searchAll;

  /** #138 — project-wide decisions (every session's decisions.json, flattened
   *  newest-first, with a partial-data report). See session-scan.ts. */
  static listAllDecisions = listAllDecisions;

  /** #203 (H2) — the derived Features read-model: every artifact across every
   *  session grouped into features by title-prefix + parentId chains. See
   *  session-scan.ts. */
  static groupByFeature = groupByFeature;

  // BB2 — targeted cache invalidation for the digest below.
  static invalidateLedgerDigestCache = invalidateLedgerDigestCache;

  /** AA5 — project-wide preflight-trace digest; see ledger-digest.ts. */
  static ledgerDigest = ledgerDigest;
}
