import fs from "node:fs";
import path from "node:path";
import type { Artifact, Retrospective, RetrospectiveVerdict } from "@deeppairing/shared";
import { nanoid } from "nanoid";
import { salvageArray } from "./salvage.js";
import { writeJsonAtomic } from "./atomic-write.js";
import type { DecisionRecord } from "./store-interface.js";

/**
 * Cross-session READ helpers — every function here walks
 * `.deeppairing/sessions/` on disk and never touches a live FileStore
 * instance. (#151: listAllDecisions additionally accepts plain-data
 * SNAPSHOTS of live sessions from the daemon — still no store coupling.)
 * Extracted from file-store.ts; the FileStore statics
 * (listSessions/searchAll/findPastPredictions/addRetrospective) delegate
 * here so existing call sites stay byte-compatible.
 */

export function listSessions(projectRoot: string): Array<{
  id: string;
  createdAt: string;
  lastActivity: string;
  summary: string;
  artifactCount: number;
  hasDecisions: boolean;
}> {
  const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const sessions: Array<{
    id: string;
    createdAt: string;
    lastActivity: string;
    summary: string;
    artifactCount: number;
    hasDecisions: boolean;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const sessionDir = path.join(sessionsDir, entry.name);
    try {
      const artFile = path.join(sessionDir, "artifacts.json");
      if (!fs.existsSync(artFile)) continue;

      const artifacts: Artifact[] = salvageArray<Artifact>(
        `${entry.name}/artifacts.json`, JSON.parse(fs.readFileSync(artFile, "utf-8")), "id");
      if (artifacts.length === 0) continue;

      const decFile = path.join(sessionDir, "decisions.json");
      // D1 review — a null decisions.json threw here and the per-session
      // catch SKIPPED the whole (otherwise healthy) session from the list.
      const decRaw = fs.existsSync(decFile) ? JSON.parse(fs.readFileSync(decFile, "utf-8")) : [];
      const hasDecisions = Array.isArray(decRaw) && decRaw.length > 0;

      const sorted = [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const firstArtifact = sorted[0];
      const lastArtifact = sorted.at(-1);
      // Unreachable (length checked above) — skip like any other bad session.
      if (!firstArtifact || !lastArtifact) continue;

      sessions.push({
        id: entry.name,
        createdAt: firstArtifact.createdAt,
        lastActivity: lastArtifact.updatedAt ?? lastArtifact.createdAt,
        summary: firstArtifact.title,
        artifactCount: artifacts.length,
        hasDecisions,
      });
    } catch {
      // Skip corrupted sessions
    }
  }

  return sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

/**
 * Search every session in the project for artifacts matching a free-text query.
 * Scoring (simple, transparent):
 *   concept name match   × 3
 *   rejected-approach    × 2
 *   title match          × 2
 *   content match        × 1
 * Case-insensitive substring across all token positions. Capped at {@link limit}
 * results total so the UI stays fast on large projects.
 */
export function searchAll(
  projectRoot: string,
  query: string,
  limit = 50,
): Array<{
  sessionId: string;
  sessionTitle: string;
  artifactId: string;
  artifactType: string;
  title: string;
  excerpt: string;
  score: number;
  matchedVia: Array<"concept" | "title" | "content" | "rejected">;
}> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: Array<{
    sessionId: string;
    sessionTitle: string;
    artifactId: string;
    artifactType: string;
    title: string;
    excerpt: string;
    score: number;
    matchedVia: Array<"concept" | "title" | "content" | "rejected">;
  }> = [];

  const sessions = listSessions(projectRoot);
  for (const session of sessions) {
    const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
    const artFile = path.join(sessionDir, "artifacts.json");
    if (!fs.existsSync(artFile)) continue;
    let artifacts: Artifact[];
    try {
      artifacts = salvageArray(`${session.id}/artifacts.json`, JSON.parse(fs.readFileSync(artFile, "utf-8")), "id");
    } catch {
      continue;
    }

    // Pull rejected approaches from preferences.json for this project
    const prefsFile = path.join(projectRoot, ".deeppairing", "preferences.json");
    let rejected: Array<{ description?: string; concept?: string; reason?: string; sourceArtifactId?: string }> = [];
    try {
      if (fs.existsSync(prefsFile)) {
        const prefs = JSON.parse(fs.readFileSync(prefsFile, "utf-8"));
        const raw = prefs.rejectedApproaches ?? [];
        rejected = Array.isArray(raw)
          ? raw.map((r: any) => (typeof r === "string" ? { description: r } : r))
          : [];
      }
    } catch {}

    for (const artifact of artifacts) {
      const matchedVia = new Set<"concept" | "title" | "content" | "rejected">();
      let score = 0;

      // Title
      if (artifact.title && artifact.title.toLowerCase().includes(q)) {
        score += 2;
        matchedVia.add("title");
      }

      // Concept (reasoning artifacts)
      const concept = (artifact.content as any)?.concept;
      if (concept?.name && String(concept.name).toLowerCase().includes(q)) {
        score += 3;
        matchedVia.add("concept");
      }

      // Rejected approach tied to this artifact (or matching the query directly)
      for (const rej of rejected) {
        const matchesArtifact = rej.sourceArtifactId === artifact.id;
        const desc = (rej.description ?? "").toLowerCase();
        const reason = (rej.reason ?? "").toLowerCase();
        const conceptStr = (rej.concept ?? "").toLowerCase();
        const hit = desc.includes(q) || reason.includes(q) || conceptStr.includes(q);
        if (matchesArtifact && hit) {
          score += 2;
          matchedVia.add("rejected");
        }
      }

      // Content fallback — stringify and substring-check
      let contentBlob = "";
      try {
        contentBlob = JSON.stringify(artifact.content ?? {}).toLowerCase();
      } catch {}
      if (contentBlob.includes(q)) {
        score += 1;
        matchedVia.add("content");
      }

      if (score === 0) continue;

      // Excerpt: short context window around the first match in content/title
      const source = artifact.title + " — " + contentBlob;
      const idx = source.indexOf(q);
      const excerpt =
        idx >= 0
          ? source
              .slice(Math.max(0, idx - 40), idx + q.length + 80)
              .replace(/\s+/g, " ")
              .trim()
          : artifact.title;

      results.push({
        sessionId: session.id,
        sessionTitle: session.summary,
        artifactId: artifact.id,
        artifactType: artifact.type,
        title: artifact.title,
        excerpt,
        score,
        matchedVia: Array.from(matchedVia),
      });
    }
  }

  // Sort by score desc, then recency (session.lastActivity is already in
  // listSessions order; we preserve insertion order via stable sort).
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * N3.3: find the user's past predictions on similar past decisions.
 * Source: resolved decisions with a non-empty `response.predictedOutcome`
 * (captured by the companion UI on high-stakes decisions).
 *
 * Match is concept-token overlap between `query` and each past decision's
 * artifact title + context + chosen option text. We don't use exact match
 * because the phrasing of a decision evolves; we do cap at tokens ≥4 chars
 * to keep the signal-to-noise reasonable.
 */
export function findPastPredictions(
  projectRoot: string,
  query: string,
  opts: { excludeArtifactId?: string; limit?: number } = {},
): Array<{
  sessionId: string;
  sessionTitle?: string;
  artifactId: string;
  artifactTitle: string;
  context: string;
  decisionId: string;
  chosenOptionTitle: string;
  predictedOutcome: string;
  confidence?: "low" | "medium" | "high";
  resolvedAt: string;
  daysAgo: number;
  retrospective?: Retrospective;
}> {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return [];

  const limit = opts.limit ?? 3;
  const now = Date.now();

  const out: ReturnType<typeof findPastPredictions> = [];
  const sessions = listSessions(projectRoot);
  for (const session of sessions) {
    const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
    const artFile = path.join(sessionDir, "artifacts.json");
    const decFile = path.join(sessionDir, "decisions.json");
    if (!fs.existsSync(artFile) || !fs.existsSync(decFile)) continue;

    let artifacts: Artifact[];
    let decisions: DecisionRecord[];
    try {
      artifacts = salvageArray(`${session.id}/artifacts.json`, JSON.parse(fs.readFileSync(artFile, "utf-8")), "id");
      decisions = salvageArray(`${session.id}/decisions.json`, JSON.parse(fs.readFileSync(decFile, "utf-8")), "decisionId");
    } catch {
      continue;
    }

    for (const dec of decisions) {
      if (!dec.response?.predictedOutcome) continue;
      if (opts.excludeArtifactId && dec.artifactId === opts.excludeArtifactId) continue;
      const artifact = artifacts.find((a) => a.id === dec.artifactId);
      if (!artifact) continue;

      const haystack = (
        artifact.title + " " +
        (dec.context ?? "") + " " +
        ((dec.options ?? []).find((o: any) => o.id === dec.response!.optionId)?.title ?? "") + " " +
        ((dec.options ?? []).find((o: any) => o.id === dec.response!.optionId)?.description ?? "")
      ).toLowerCase();

      const hits = tokens.filter((t) => haystack.includes(t));
      // N3.3 — match on concept-token OVERLAP, not a majority of the (broad)
      // title+context query. The old `ceil(tokens.length / 2)` rule scaled
      // with query length, so a paraphrased decision that shared the real
      // concept but differed in wording almost never cleared the bar — the
      // calibration loop basically never fired. Require a fixed floor of
      // shared ≥4-char tokens instead (2, or the single token when that's all
      // the query has). Decisions that recorded a prediction are rare, so this
      // surfaces the relevant ones without flooding.
      const required = Math.min(2, tokens.length);
      if (hits.length < required) continue;

      const chosen = (dec.options ?? []).find((o: any) => o.id === dec.response!.optionId);
      const resolvedAt = dec.resolvedAt ?? dec.createdAt;
      const daysAgo = Math.max(0, Math.floor((now - new Date(resolvedAt).getTime()) / (24 * 60 * 60 * 1000)));

      // Hydrate any existing retrospective for this decision so the
      // breadcrumb can render the verdict alongside the prediction.
      const retrosPath = path.join(sessionDir, "retrospectives.json");
      let retrospective: Retrospective | undefined;
      try {
        if (fs.existsSync(retrosPath)) {
          const retros: Retrospective[] = salvageArray<Retrospective>(
            "retrospectives.json", JSON.parse(fs.readFileSync(retrosPath, "utf-8")), "decisionId");
          retrospective = retros.find((r) => r.decisionId === dec.decisionId);
        }
      } catch {}

      out.push({
        sessionId: session.id,
        sessionTitle: session.summary,
        artifactId: dec.artifactId,
        artifactTitle: artifact.title,
        context: dec.context ?? "",
        decisionId: dec.decisionId,
        chosenOptionTitle: chosen?.title ?? dec.response!.optionId,
        predictedOutcome: dec.response!.predictedOutcome,
        confidence: (dec.response as any).confidence,
        resolvedAt,
        daysAgo,
        retrospective,
      });
    }
  }

  // Newest first — the user likely remembers recent predictions better.
  return out.sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt)).slice(0, limit);
}

/**
 * #138 — one flattened decision across the whole project, shaped for the
 * project-wide decisions view. Carries everything the view needs to show
 * "what did we decide, and why" without a second fetch: the question, the
 * chosen option (or its absence), when, which session, and the artifact it
 * belongs to (for jump-to navigation).
 */
export interface ProjectDecision {
  decisionId: string;
  sessionId: string;
  /** First-artifact title of the owning session (mirrors listSessions.summary). */
  sessionTitle: string;
  /** The decision RECORD's artifactId — the nav target. The web selectArtifact
   *  resolves this to its live successor, so a superseded v1 still lands on v2. */
  artifactId: string;
  /** Title of the backing artifact, resolved through the supersede chain to the
   *  live version, or the decision context when no artifact is found. */
  artifactTitle: string;
  /** True when no artifact in the session matched the decision's artifactId
   *  (the decision still renders from its own record; navigation is best-effort). */
  artifactMissing: boolean;
  context: string;
  stakes?: "low" | "medium" | "high";
  optionCount: number;
  resolved: boolean;
  chosenOptionId?: string;
  chosenOptionTitle?: string;
  reasoning?: string;
  confidence?: "low" | "medium" | "high";
  /** Optional: salvageArray only guarantees a string decisionId, so a
   *  salvage-passing record can lack a timestamp. The view renders such a row
   *  as "date unknown" and sorts it last rather than fabricating a position. */
  createdAt?: string;
  resolvedAt?: string;
  /**
   * #153 (S5) — true when the decision is UNRESOLVED but its origin artifact
   * was superseded: the artifact is closed, so the decision can never resolve.
   * The view renders "Superseded (never resolved)" instead of a permanent
   * "Awaiting your decision" pill. Optional for back-compat (absent = open).
   */
  closedUnresolved?: boolean;
}

export interface ProjectDecisionsResult {
  /** Newest-first (by resolvedAt ?? createdAt). */
  decisions: ProjectDecision[];
  /**
   * #138 — sessions whose decisions.json existed but could NOT be parsed at
   * all (JSON.parse threw). Surfaced so the view can show an HONEST partial
   * state — a decisions view that silently omits a session's decisions is
   * worse than none. Individual malformed ELEMENTS inside a parseable array
   * are salvaged+dropped by salvageArray (logged, not fatal); this list is
   * the whole-file-unreadable case.
   *
   * #153 — `kind` distinguishes the two honest-partial cases so the UI can
   * word its banner truthfully. Optional for back-compat:
   *   - "unreadable" (or absent): the live decisions.json can't be read NOW.
   *   - "recovered": the live file parses, but a `decisions.json.corrupt`
   *     sidecar shows earlier decisions were lost to corruption and the file
   *     was later rewritten (FileStore's fall-back-and-rewrite on session
   *     re-open). Without this, a daemon restart silently closed the honest-
   *     partial window: the view reported `failedSessions: []` while the
   *     pre-corruption decisions had NO surviving surface.
   */
  failedSessions: Array<{ sessionId: string; reason: string; kind?: "unreadable" | "recovered" }>;
}

/**
 * #151 — one live session's in-memory state, supplied by the daemon so the
 * project-wide decisions view can source a session's decisions from the live
 * FileStore instead of its (debounce-flush-lagged) decisions.json. A decision
 * recorded/resolved moments ago lives only in memory for ~100ms-worth of
 * debounce (observed 2-3s end-to-end); reading disk alone made a just-resolved
 * decision vanish from the view the user opened to confirm it.
 */
export interface LiveDecisionSource {
  sessionId: string;
  decisions: DecisionRecord[];
  artifacts: Artifact[];
}

/**
 * #138 — follow the supersede chain from `id` to the live (non-superseded)
 * version within one session's artifact set. Server-side mirror of the web
 * store's resolveToLiveId, so a decision whose artifact was revised to v2
 * still resolves to a sensible (live) title + nav target rather than a dead
 * v1. Falls back to the original id when the artifact isn't found.
 */
function resolveLiveArtifact(artifacts: Artifact[], id: string): Artifact | undefined {
  let current = artifacts.find((a) => a.id === id);
  const seen = new Set<string>();
  while (current && current.status === "superseded" && !seen.has(current.id)) {
    seen.add(current.id);
    const successor = artifacts.find((a) => a.parentId === current!.id);
    if (!successor) break;
    current = successor;
  }
  return current;
}

/**
 * #138 — every decision made across EVERY session of a project, flattened and
 * newest-first, for the project-wide decisions view. Walks
 * `.deeppairing/sessions/&#42;/decisions.json` on disk, salvaging each file: a
 * single corrupt session is reported in `failedSessions` and its `.corrupt`
 * sidecar is written — it NEVER fails the whole read or silently truncates
 * the list.
 *
 * #151 — `liveSessions` (optional) carries the daemon's currently-registered
 * in-memory stores. A session present there is sourced from MEMORY and its
 * on-disk decisions.json is skipped entirely — live wins by sessionId, so the
 * live/disk seam can never produce duplicate rows. Sessions with no live
 * store (dead sessions on disk) still come from the disk scan. This closes
 * the flush-lag window where a just-resolved decision was missing from the
 * view until the debounced flush landed. The fix is deliberately NOT a
 * force-flush: a GET that writes is worse than a GET that merges.
 */
export function listAllDecisions(
  projectRoot: string,
  liveSessions: LiveDecisionSource[] = [],
): ProjectDecisionsResult {
  const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
  const decisions: ProjectDecision[] = [];
  const failedSessions: ProjectDecisionsResult["failedSessions"] = [];

  // Shared per-session shaping — identical for live (memory) and disk sources,
  // so the two paths can't drift.
  const pushSession = (sessionId: string, decRecords: DecisionRecord[], artifacts: Artifact[]): void => {
    const sorted = [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const sessionTitle = sorted[0]?.title ?? sessionId;

    for (const dec of decRecords) {
      const liveArtifact = resolveLiveArtifact(artifacts, dec.artifactId);
      const options = Array.isArray(dec.options) ? dec.options : [];
      const chosen = dec.response
        ? options.find((o) => o?.id === dec.response!.optionId)
        : undefined;
      // #153 (S5) — an UNRESOLVED decision whose origin artifact was
      // superseded can never resolve (the artifact is closed); flag it so the
      // view doesn't render a permanent "Awaiting your decision" pill.
      const origin = artifacts.find((a) => a.id === dec.artifactId);
      const closedUnresolved = !dec.response && origin?.status === "superseded";
      decisions.push({
        decisionId: dec.decisionId,
        sessionId,
        sessionTitle,
        artifactId: dec.artifactId,
        artifactTitle: liveArtifact?.title ?? dec.context ?? dec.artifactId,
        artifactMissing: !liveArtifact,
        context: dec.context ?? "",
        stakes: dec.stakes,
        optionCount: options.length,
        resolved: !!dec.response,
        chosenOptionId: dec.response?.optionId,
        // Prefer the option's title; fall back to the raw optionId so a
        // resolved decision whose option list drifted still shows a choice.
        chosenOptionTitle: dec.response
          ? chosen?.title ?? dec.response.optionId
          : undefined,
        reasoning: dec.response?.reasoning,
        confidence: dec.response?.confidence,
        createdAt: dec.createdAt,
        resolvedAt: dec.resolvedAt,
        ...(closedUnresolved ? { closedUnresolved: true } : {}),
      });
    }
  };

  const liveById = new Map<string, LiveDecisionSource>();
  for (const src of liveSessions) liveById.set(src.sessionId, src);
  const consumedLive = new Set<string>();
  // #153 — sessions whose dir holds a decisions.json.corrupt sidecar (from an
  // earlier corruption, whether this scan wrote it or FileStore's re-open
  // recovery did). Collected during the walk, reported (deduped) after it.
  const sidecarSessions: string[] = [];

  let entries: fs.Dirent[] = [];
  if (fs.existsSync(sessionsDir)) {
    try {
      entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const sessionDir = path.join(sessionsDir, sessionId);
    const decFile = path.join(sessionDir, "decisions.json");
    // #153 — sidecar check runs for EVERY session dir, live or dead, even
    // when the live decisions.json is absent or parses cleanly: after a
    // session re-open, FileStore's fall-back-and-rewrite leaves a perfectly
    // valid file whose pre-corruption decisions survive ONLY in the sidecar.
    try {
      if (fs.existsSync(decFile + ".corrupt")) sidecarSessions.push(sessionId);
    } catch { /* best-effort */ }

    // #151 — live wins by sessionId: source this session's decisions from the
    // registered in-memory store, never ALSO from its (possibly-lagged) disk
    // file — that seam is where duplicate rows would come from.
    const liveSrc = liveById.get(sessionId);
    if (liveSrc) {
      consumedLive.add(sessionId);
      pushSession(sessionId, liveSrc.decisions, liveSrc.artifacts);
      continue;
    }

    // No decisions.json → the session simply never recorded a decision. That
    // is NOT a failure; only a file that exists-but-won't-parse is.
    if (!fs.existsSync(decFile)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(decFile, "utf-8"));
    } catch (err: any) {
      // Whole-file corruption (unparseable): back up the raw bytes (.corrupt)
      // exactly like FileStore.loadJsonFile, then REPORT the session rather than
      // dropping it silently — the single most important requirement of this view.
      try { fs.copyFileSync(decFile, decFile + ".corrupt"); } catch { /* best-effort */ }
      failedSessions.push({ sessionId, reason: err?.message ?? "unreadable decisions.json", kind: "unreadable" });
      continue;
    }
    // Valid JSON but not an array — the whole file is unusable AS decisions.
    // `decRecords.length === 0` below can't distinguish this from a legitimately
    // empty [], so detect + report it HERE rather than dropping the session in
    // silence (console.error alone reaches no user).
    if (!Array.isArray(raw)) {
      failedSessions.push({
        sessionId,
        reason: `decisions.json is not an array (got ${raw === null ? "null" : typeof raw})`,
        kind: "unreadable",
      });
      continue;
    }
    // An empty array is the LEGITIMATE "this session made no decisions" case.
    if (raw.length === 0) continue;
    // salvageArray drops malformed ELEMENTS (and logs) but keeps the good ones —
    // partial data survives instead of taking down the session.
    const decRecords = salvageArray<DecisionRecord>(`${sessionId}/decisions.json`, raw, "decisionId");
    // The file HAD content but EVERY record was rejected — a failure the user
    // must see, not a silent drop.
    if (decRecords.length === 0) {
      failedSessions.push({
        sessionId,
        reason: `all ${raw.length} decision record(s) in decisions.json were malformed`,
        kind: "unreadable",
      });
      continue;
    }

    // Artifacts are only for title/nav enrichment — a corrupt artifacts.json
    // must NOT drop the decisions (they render from their own record). Degrade
    // to an empty artifact set (titles fall back to the decision context).
    let artifacts: Artifact[] = [];
    const artFile = path.join(sessionDir, "artifacts.json");
    if (fs.existsSync(artFile)) {
      try {
        artifacts = salvageArray<Artifact>(
          `${sessionId}/artifacts.json`, JSON.parse(fs.readFileSync(artFile, "utf-8")), "id");
      } catch { /* leave artifacts empty */ }
    }
    pushSession(sessionId, decRecords, artifacts);
  }

  // #151 — a live session so fresh its directory hasn't been created (or was
  // removed) still appears: memory is the only truth it has.
  for (const src of liveSessions) {
    if (consumedLive.has(src.sessionId)) continue;
    pushSession(src.sessionId, src.decisions, src.artifacts);
  }

  // #153 — surface recovered-from-corruption sessions where the user already
  // looks. Dedupe: a session already reported for a LIVE parse failure (this
  // scan writes the same sidecar it would then find) gets one row, not two.
  for (const sessionId of sidecarSessions) {
    if (failedSessions.some((f) => f.sessionId === sessionId)) continue;
    failedSessions.push({
      sessionId,
      reason: "earlier decisions were recovered from corruption; the pre-corruption file is preserved at decisions.json.corrupt",
      kind: "recovered",
    });
  }

  // Newest-first. The comparator MUST be total: salvageArray only guarantees a
  // string decisionId, so a salvage-passing record can lack BOTH createdAt and
  // resolvedAt. Its key is "" (the smallest string) → it sorts to the BOTTOM (an
  // unknown date is not "newest"), and `(undefined).localeCompare(...)` never
  // runs — that throw would escape the per-session try/catch above and 500 the
  // whole view (the invariant this function promises it never does).
  const sortKey = (d: ProjectDecision): string => d.resolvedAt ?? d.createdAt ?? "";
  decisions.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  failedSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return { decisions, failedSessions };
}

/**
 * P2 — write a retrospective for a decision that was made in some past
 * session. Walks sessions to find the one owning the decisionId; replaces
 * any existing retrospective for that decision (users can change their
 * minds as more evidence comes in).
 *
 * Returns the hydrated retrospective on success, or null if no session
 * owns the decisionId (caller should 404).
 */
export function addRetrospective(
  projectRoot: string,
  params: { decisionId: string; verdict: RetrospectiveVerdict; note?: string },
): { retrospective: Retrospective; sessionId: string } | null {
  const sessions = listSessions(projectRoot);
  for (const session of sessions) {
    const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
    const decFile = path.join(sessionDir, "decisions.json");
    if (!fs.existsSync(decFile)) continue;
    let decisions: DecisionRecord[];
    try {
      decisions = salvageArray(`${session.id}/decisions.json`, JSON.parse(fs.readFileSync(decFile, "utf-8")), "decisionId");
    } catch {
      continue;
    }
    if (!decisions.some((d) => d.decisionId === params.decisionId)) continue;

    const retrospective: Retrospective = {
      id: `retro_${nanoid(10)}`,
      decisionId: params.decisionId,
      verdict: params.verdict,
      note: params.note?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    const retrosPath = path.join(sessionDir, "retrospectives.json");
    let existing: Retrospective[] = [];
    try {
      if (fs.existsSync(retrosPath)) {
        existing = salvageArray("retrospectives.json (write path)", JSON.parse(fs.readFileSync(retrosPath, "utf-8")), "decisionId");
      }
    } catch {}
    const filtered = existing.filter((r) => r.decisionId !== params.decisionId);
    filtered.push(retrospective);
    writeJsonAtomic(retrosPath, filtered);

    return { retrospective, sessionId: session.id };
  }
  return null;
}
