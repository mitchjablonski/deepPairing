import fs from "node:fs";
import path from "node:path";
import type { Artifact, Comment } from "@deeppairing/shared";
import { collectUnansweredQuestions } from "@deeppairing/shared";
import { salvageArray } from "./salvage.js";
import type { DecisionRecord } from "./store-interface.js";

/**
 * Cross-session READ helpers — every function here walks
 * `.deeppairing/sessions/` on disk and never touches a live FileStore
 * instance. (#151: listAllDecisions additionally accepts plain-data
 * SNAPSHOTS of live sessions from the daemon — still no store coupling.)
 * Extracted from file-store.ts; the FileStore statics
 * (listSessions/searchAll) delegate here so existing call sites stay
 * byte-compatible.
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

// ===========================================================================
// #203 (H2) — the Features view, slice 1: a DERIVED read-model that groups a
// project's artifacts into FEATURES. A feature is a bag of artifacts ORTHOGONAL
// to the session boundary — the dominant real shape is ONE long rolling session
// holding MANY features, which humans already hand-label with "Milestone N" /
// "Phase N" title prefixes (an observed workaround). This walks the same
// on-disk `.deeppairing/sessions/*` listAllDecisions does — zero schema change,
// zero migration, zero agent obligation, no persisted collection. It is
// read-tolerant end-to-end: a malformed session is SKIPPED (reported in
// failedSessions), never thrown.
// ===========================================================================

/** A normalized feature prefix: a STABLE slug (the group id — see
 *  normalizeFeaturePrefix's contract) plus a human-readable label. */
export interface FeaturePrefix {
  slug: string;
  label: string;
}

/** slug: lowercase, non-alphanumeric runs → single "-", trimmed. Stable across
 *  reads (no time/hash input) so a group's id never moves under the UI. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Prettify a mined feature name for display: collapse whitespace, strip a
 *  trailing separator, upper-case the first character. Deliberately light — it
 *  is the human's own text, not ours to rewrite. */
function prettifyLabel(s: string): string {
  const t = s.replace(/\s+/g, " ").replace(/[\s:.\-–—]+$/, "").trim();
  return t.length > 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * #203 — the ONE grouping heuristic, exported pure so its behavior is
 * table-pinned in tests. Mines a leading FEATURE prefix from an artifact title,
 * case-insensitively, stripping the separator (space / colon / dot / any dash —
 * hyphen, en-dash, em-dash). Returns `null` for a title that carries no prefix
 * (it lands in the Ungrouped bucket).
 *
 * Priority order (first match wins):
 *   1. "Milestone N …"  and its short form "MN …"  → both key `milestone-<n>`
 *      (so "M6 — quota UI" and "Milestone 6 — backfill" collapse into ONE
 *      group). The NUMBER is the group anchor; the trailing text is that one
 *      artifact's own title, not part of the key.
 *   2. "Phase N …"      → key `phase-<n>`, label "Phase N".
 *   3. "Feature: X"     → key `slug(X)`, label prettified X. Here the WHOLE X is
 *      the feature name (no numeric anchor to split on).
 *   4. "[X] …"          → key `slug(X)`, label prettified X. Bracket-tag form.
 *
 * The bracket and "Feature:" forms slug the SAME inner text, so "[auth]" and
 * "Feature: auth" intentionally land in one group — one canonical key per
 * human-named feature regardless of which syntax introduced it.
 */
export function normalizeFeaturePrefix(rawTitle: string): FeaturePrefix | null {
  const title = (rawTitle ?? "").trim();
  if (!title) return null;

  // 1a. "Milestone 6 — …"  (word boundary after the number)
  let m = title.match(/^milestone\s+(\d+)\b/i);
  // 1b. short form "M6 — …" — require a separator/end after the number so
  //     "m5stack", "MP3 tagger" (no digit right after M) don't false-match.
  if (!m) m = title.match(/^m(\d+)(?=$|[\s:.\-–—])/i);
  if (m) {
    const n = String(parseInt(m[1]!, 10));
    return { slug: `milestone-${n}`, label: `Milestone ${n}` };
  }

  // 2. "Phase 0: …"
  const p = title.match(/^phase\s+(\d+)\b/i);
  if (p) {
    const n = String(parseInt(p[1]!, 10));
    return { slug: `phase-${n}`, label: `Phase ${n}` };
  }

  // 3. "Feature: X" — the whole remainder is the feature name.
  const f = title.match(/^feature\s*[:\-–—]\s*(.+)$/i);
  if (f) {
    const inner = f[1]!.trim();
    const slug = slugify(inner);
    if (slug) return { slug, label: prettifyLabel(inner) };
  }

  // 4. "[X] …" — bracket-tag; the tag is the feature name.
  const b = title.match(/^\[([^\]]+)\]/);
  if (b) {
    const inner = b[1]!.trim();
    const slug = slugify(inner);
    if (slug) return { slug, label: prettifyLabel(inner) };
  }

  return null;
}

/** One artifact placed in a feature group — everything the timeline row + the
 *  cross-session jump need without a second fetch. */
export interface FeatureArtifactRef {
  sessionId: string;
  artifactId: string;
  type: string;
  title: string;
  status: string;
  createdAt: string;
}

/** One thing in a group still owed the human, tagged by WHAT it is + where to
 *  click. */
export interface FeatureOpenItem {
  kind: "decision" | "needs_eyes" | "question";
  /** What it is, in one line (the row label). */
  label: string;
  sessionId: string;
  /** The click-through target (jump-to-artifact in its session). */
  artifactId: string;
  /** Secondary context (a decision's reasoning-less question, a needsYourEyes
   *  `why`, the question text). */
  detail?: string;
  /** For an unanswered question: the open-question comment id. */
  commentId?: string;
}

/** A file the group touched, plus the OTHER groups that also touched it (cheap
 *  cross-group intersection — the "also touched by <group>" breadcrumb). */
export interface FeatureFileTouch {
  path: string;
  alsoIn: string[];
}

export interface FeatureGroup {
  /** Stable slug of the normalized prefix (`milestone-6`, `phase-0`, …) or the
   *  reserved `__ungrouped__` bucket. */
  id: string;
  title: string;
  /** True only for the catch-all bucket (rendered last, collapsed). */
  ungrouped?: boolean;
  artifactCount: number;
  openItemCount: number;
  /** Newest artifact activity in the group (max updatedAt ?? createdAt). */
  lastActivity?: string;
  /** createdAt ASCending — timeline-ready. */
  artifactRefs: FeatureArtifactRef[];
  openItems: FeatureOpenItem[];
  /** Deduped, path-sorted. */
  fileTouches: FeatureFileTouch[];
}

export interface FeatureGroupsResult {
  /** Grouped features first (most-recent activity first); the Ungrouped bucket
   *  is ALWAYS last (it is most of history — never hidden). */
  groups: FeatureGroup[];
  /** Sessions whose artifacts.json couldn't be read AT ALL (whole-file
   *  unreadable) — surfaced so the view is honest about a partial scan, mirroring
   *  listAllDecisions. Individual malformed elements are salvaged+dropped. */
  failedSessions: Array<{ sessionId: string; reason: string }>;
}

const UNGROUPED_ID = "__ungrouped__";

/** Pull every code-touch path an artifact declares: a `code_change`'s single
 *  filePath and a `changeset`'s files[].path. Tolerant of any shape. */
function fileTouchesOf(artifact: Artifact): string[] {
  const out: string[] = [];
  const content = artifact.content as Record<string, unknown> | null | undefined;
  if (!content) return out;
  if (artifact.type === "code_change" && typeof content.filePath === "string") {
    out.push(content.filePath);
  }
  if (artifact.type === "changeset" && Array.isArray(content.files)) {
    for (const f of content.files as Array<{ path?: unknown }>) {
      if (f && typeof f.path === "string") out.push(f.path);
    }
  }
  return out;
}

/**
 * #203 (H2) — group every artifact across every session into features. Read-time
 * walk of `.deeppairing/sessions/*`; zero store coupling (mirrors
 * listAllDecisions). Grouping, in priority order:
 *   a. title-prefix mining (normalizeFeaturePrefix),
 *   b. parentId chains — an artifact whose parent is grouped joins the parent's
 *      group; the chain BEATS the child's own prefix on conflict (a superseded
 *      v2 stays with its v1's group even if retitled),
 *   c. everything else → the Ungrouped bucket.
 */
export function groupByFeature(projectRoot: string): FeatureGroupsResult {
  const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
  const failedSessions: FeatureGroupsResult["failedSessions"] = [];

  // Per-session raw material, gathered first so parentId chains resolve within
  // the session that owns them.
  interface SessionScan {
    sessionId: string;
    artifacts: Artifact[];
    decisions: DecisionRecord[];
    comments: Comment[];
  }
  const scans: SessionScan[] = [];

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
    const artFile = path.join(sessionDir, "artifacts.json");
    if (!fs.existsSync(artFile)) continue;

    let artifacts: Artifact[];
    try {
      artifacts = salvageArray<Artifact>(
        `${sessionId}/artifacts.json`, JSON.parse(fs.readFileSync(artFile, "utf-8")), "id");
    } catch (err: any) {
      // Whole-file unreadable — report it, never take the whole scan down.
      failedSessions.push({ sessionId, reason: err?.message ?? "unreadable artifacts.json" });
      continue;
    }
    if (artifacts.length === 0) continue;

    // Decisions + comments are ENRICHMENT only: a corrupt one degrades to empty
    // (the artifacts still group), it never drops the session.
    let decisions: DecisionRecord[] = [];
    const decFile = path.join(sessionDir, "decisions.json");
    if (fs.existsSync(decFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(decFile, "utf-8"));
        if (Array.isArray(raw)) {
          decisions = salvageArray<DecisionRecord>(`${sessionId}/decisions.json`, raw, "decisionId");
        }
      } catch { /* leave decisions empty */ }
    }
    let comments: Comment[] = [];
    const cmtFile = path.join(sessionDir, "comments.json");
    if (fs.existsSync(cmtFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cmtFile, "utf-8"));
        if (Array.isArray(raw)) {
          comments = salvageArray<Comment>(`${sessionId}/comments.json`, raw, "id");
        }
      } catch { /* leave comments empty */ }
    }

    scans.push({ sessionId, artifacts, decisions, comments });
  }

  // --- Assign each artifact its effective group key -------------------------
  // parentGroup ?? ownPrefix: a grouped parent (the chain) BEATS the child's own
  // prefix; an ungrouped parent lets the child keep its own prefix. Memoized DFS
  // up the parentId chain, cycle-guarded (corrupt parent loops fall back to the
  // artifact's own prefix rather than looping forever).
  // Track the canonical label per key (first-seen wins) so a key mined two ways
  // ("[Auth]" vs "Feature: auth") renders one stable title.
  const labelByKey = new Map<string, string>();
  const registerLabel = (g: FeaturePrefix): void => {
    if (!labelByKey.has(g.slug)) labelByKey.set(g.slug, g.label);
  };

  const scanBySession = new Map<string, SessionScan>();
  for (const s of scans) scanBySession.set(s.sessionId, s);

  // artifactId → effective group key (or null = ungrouped). Keyed by
  // sessionId+"\0"+artifactId to keep sessions' id-spaces from colliding.
  const groupKeyOf = new Map<string, string | null>();
  const composite = (sessionId: string, artifactId: string) => `${sessionId} ${artifactId}`;

  for (const scan of scans) {
    const byId = new Map<string, Artifact>();
    for (const a of scan.artifacts) byId.set(a.id, a);

    const resolve = (artifact: Artifact, seen: Set<string>): string | null => {
      const ck = composite(scan.sessionId, artifact.id);
      const cached = groupKeyOf.get(ck);
      if (cached !== undefined) return cached;
      // Cycle guard — a corrupt parentId loop resolves to own-prefix.
      if (seen.has(artifact.id)) {
        const own = normalizeFeaturePrefix(artifact.title);
        if (own) registerLabel(own);
        return own?.slug ?? null;
      }
      seen.add(artifact.id);

      const own = normalizeFeaturePrefix(artifact.title);
      if (own) registerLabel(own);

      const parent = artifact.parentId ? byId.get(artifact.parentId) : undefined;
      const parentGroup = parent ? resolve(parent, seen) : null;

      // Chain beats prefix: a grouped parent overrides the child's own prefix.
      const effective = parentGroup ?? own?.slug ?? null;
      groupKeyOf.set(ck, effective);
      return effective;
    };

    for (const a of scan.artifacts) resolve(a, new Set());
  }

  // --- Build the groups -----------------------------------------------------
  interface GroupAccum {
    id: string;
    title: string;
    ungrouped: boolean;
    refs: FeatureArtifactRef[];
    openItems: FeatureOpenItem[];
    files: Set<string>;
  }
  const groups = new Map<string, GroupAccum>();
  const ensure = (id: string, title: string, ungrouped: boolean): GroupAccum => {
    let g = groups.get(id);
    if (!g) {
      g = { id, title, ungrouped, refs: [], openItems: [], files: new Set() };
      groups.set(id, g);
    }
    return g;
  };

  // Which group each artifact ended in, so decisions/comments scope correctly.
  const groupIdForArtifact = new Map<string, string>(); // composite → groupId

  for (const scan of scans) {
    for (const artifact of scan.artifacts) {
      const key = groupKeyOf.get(composite(scan.sessionId, artifact.id)) ?? null;
      const groupId = key ?? UNGROUPED_ID;
      const title = key ? (labelByKey.get(key) ?? key) : "Ungrouped";
      const g = ensure(groupId, title, key === null);
      groupIdForArtifact.set(composite(scan.sessionId, artifact.id), groupId);

      g.refs.push({
        sessionId: scan.sessionId,
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        status: artifact.status,
        createdAt: artifact.createdAt,
      });
      for (const f of fileTouchesOf(artifact)) g.files.add(f);

      // un-actioned debrief needsYourEyes[] — no per-item actioned state exists
      // in the schema, so every item on an in-group debrief is an open item.
      if (artifact.type === "debrief") {
        const content = artifact.content as Record<string, unknown> | null;
        const eyes = content?.needsYourEyes;
        if (Array.isArray(eyes)) {
          for (const item of eyes as Array<{ what?: unknown; why?: unknown; artifactRef?: unknown }>) {
            const what = typeof item?.what === "string" ? item.what : "";
            if (!what) continue;
            g.openItems.push({
              kind: "needs_eyes",
              label: what,
              sessionId: scan.sessionId,
              // Prefer the referenced artifact; fall back to the debrief itself.
              artifactId: typeof item?.artifactRef === "string" && item.artifactRef ? item.artifactRef : artifact.id,
              detail: typeof item?.why === "string" ? item.why : undefined,
            });
          }
        }
      }
    }

    // Unresolved decisions, scoped to the group each decision's artifact fell in.
    const artById = new Map<string, Artifact>();
    for (const a of scan.artifacts) artById.set(a.id, a);
    for (const dec of scan.decisions) {
      if (dec.response) continue; // resolved
      const origin = artById.get(dec.artifactId);
      // closedUnresolved (origin superseded) can never resolve — not an
      // actionable open item; skip it (mirrors listAllDecisions' flag).
      if (origin?.status === "superseded") continue;
      const cid = composite(scan.sessionId, dec.artifactId);
      const groupId = groupIdForArtifact.get(cid);
      if (!groupId) continue; // decision references an unknown/dropped artifact
      const g = groups.get(groupId);
      if (!g) continue;
      g.openItems.push({
        kind: "decision",
        label: dec.context?.trim() || origin?.title || "Awaiting your decision",
        sessionId: scan.sessionId,
        artifactId: dec.artifactId,
      });
    }

    // Unanswered questions — run the SHARED tail-walk over the whole session's
    // comments (thread integrity), then scope each result to the group its
    // artifact fell in.
    const unanswered = collectUnansweredQuestions(scan.comments);
    for (const q of unanswered) {
      const cid = composite(scan.sessionId, q.artifactId);
      const groupId = groupIdForArtifact.get(cid);
      if (!groupId) continue; // question targets an artifact not in this scan
      const g = groups.get(groupId);
      if (!g) continue;
      g.openItems.push({
        kind: "question",
        label: q.question.content?.trim() || "Unanswered question",
        sessionId: scan.sessionId,
        artifactId: q.artifactId,
        detail: undefined,
        commentId: q.question.id,
      });
    }
  }

  // --- Cross-group file intersections (cheap) -------------------------------
  const groupsByFile = new Map<string, string[]>(); // path → group titles
  for (const g of groups.values()) {
    for (const f of g.files) {
      const arr = groupsByFile.get(f) ?? [];
      arr.push(g.title);
      groupsByFile.set(f, arr);
    }
  }

  // --- Finalize -------------------------------------------------------------
  const finalize = (g: GroupAccum): FeatureGroup => {
    const artifactRefs = [...g.refs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const lastActivity = artifactRefs.length > 0 ? artifactRefs.at(-1)!.createdAt : undefined;
    const fileTouches: FeatureFileTouch[] = [...g.files]
      .sort((a, b) => a.localeCompare(b))
      .map((p) => ({
        path: p,
        alsoIn: (groupsByFile.get(p) ?? []).filter((t) => t !== g.title),
      }));
    return {
      id: g.id,
      title: g.title,
      ...(g.ungrouped ? { ungrouped: true } : {}),
      artifactCount: g.refs.length,
      openItemCount: g.openItems.length,
      lastActivity,
      artifactRefs,
      openItems: g.openItems,
      fileTouches,
    };
  };

  const grouped: FeatureGroup[] = [];
  let ungrouped: FeatureGroup | undefined;
  for (const g of groups.values()) {
    const fg = finalize(g);
    if (fg.ungrouped) ungrouped = fg;
    else grouped.push(fg);
  }
  // Most-recent feature first; the Ungrouped bucket is ALWAYS last.
  grouped.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  const orderedGroups = ungrouped ? [...grouped, ungrouped] : grouped;

  failedSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return { groups: orderedGroups, failedSessions };
}
