import fs from "node:fs";
import path from "node:path";
import type { Artifact, Comment } from "@deeppairing/shared";
import { collectUnansweredQuestions, isClosedArtifactStatus } from "@deeppairing/shared";
import { salvageArray, salvageLog } from "./salvage.js";
import { listAllDecisions, type ProjectDecision } from "./session-scan.js";
import { readProjectRegistry, type ProjectRegistryReadEntry } from "./project-registry.js";

/**
 * The context bank — a READ-ONLY cross-project read-model.
 *
 * Answers three questions the per-project UI structurally cannot:
 *   "what am I doing across all my projects", "what needs me", and
 *   "where did I leave off over there".
 *
 * It never opens a FileStore, never writes, and never touches a live daemon.
 * It walks `<projectRoot>/.deeppairing/sessions/*` on disk for every project in
 * the registry (project-registry.ts), reusing the same salvage machinery the
 * store uses so a half-written artifacts.json degrades identically here.
 *
 * ## Honesty is the design constraint
 *
 * A dry-run over the author's REAL data found 1,003 artifacts and exactly ONE
 * debrief — and that one was a fixture. So the narrative signal this read-model
 * would most like to show ("here's the story of that session") mostly does not
 * exist yet. The read-model therefore GRADES every one-liner it derives
 * (`derivationQuality` + `derivationRung`) instead of quietly presenting a
 * first-artifact title as if it were a summary. The UI is expected to render a
 * `thin` card differently from a `rich` one. Nothing here ever invents prose.
 *
 * The same dry-run found the strongest real signal by a wide margin: OPEN
 * DECISIONS (25 across 10 projects, 9 of them older than 60 days, several
 * whose own prose says a later card replaced them). That is why the open-loop
 * half of this model is the detailed half, and why `likelySuperseded` exists.
 */

/** Which rung of the derivation ladder produced a session's one-liner. */
export type DerivationRung =
  | "debrief-summary"
  | "changeset-summary"
  | "open-decision"
  | "plan-or-spec-title"
  | "first-artifact-title"
  | "none";

/**
 * How much to TRUST the one-liner. `rich` = the agent actually narrated this
 * session; `medium` = a real summary line, but of one change or one open
 * question rather than the session; `thin` = a title, i.e. barely more than the
 * session id. A UI that renders all three identically is lying.
 */
export type DerivationQuality = "rich" | "medium" | "thin";

/** Derived, never stored. See deriveSalience. */
export type SalienceTag = "needs-you" | "quiet" | "stale" | "done";

const RUNG_QUALITY: Record<DerivationRung, DerivationQuality> = {
  "debrief-summary": "rich",
  "changeset-summary": "medium",
  "open-decision": "medium",
  "plan-or-spec-title": "thin",
  "first-artifact-title": "thin",
  none: "thin",
};

/** One-liners are card copy, not prose. Truncate on a word boundary. */
const ONE_LINER_MAX = 140;

/** Default "nothing has happened here in a while" threshold, in days. */
export const DEFAULT_STALE_AFTER_DAYS = 21;

/** Default scan cache TTL. The scan is a disk walk over N projects. */
export const DEFAULT_BANK_TTL_MS = 20_000;

/**
 * Session-id patterns that mark this REPO's own fixtures/demos. Deliberately
 * NOT a general fixture classifier — a heuristic that guesses "this looks like
 * demo data" across a stranger's projects would eventually hide real work.
 * These are the ids deepPairing itself mints or ships:
 *   - `demo_*`  — minted only by POST /api/demo/run (FileStore.isDemoSession)
 *   - `*-demo`, `*-preview`, `fixture*`, `test_*` — the checked-in sample
 *     sessions in this repo (b-demo, dv1-demo, batch2-preview, …)
 * Sessions matching these are FLAGGED (`fixtureLike`), never hidden: the
 * dry-run found stray test artifacts polluting real queues, and the fix for
 * that is a visible label, not a silent filter that could swallow real work.
 */
function looksLikeFixtureSession(sessionId: string): boolean {
  const id = sessionId.toLowerCase();
  return (
    id.startsWith("demo_") ||
    id.startsWith("test_") ||
    id.startsWith("fixture") ||
    id.endsWith("-demo") ||
    id.endsWith("-preview")
  );
}

/** An open decision, with the age + supersede context the triage view needs. */
export interface BankOpenDecision {
  decisionId: string;
  /** The backing artifact — the nav target and the supersede-match key. */
  artifactId: string;
  title: string;
  context: string;
  stakes?: "low" | "medium" | "high";
  createdAt?: string;
  /** Whole days since createdAt. Absent when the record carries no timestamp. */
  ageDays?: number;
  /**
   * A LIVE, LATER decision in this same session explicitly names this card's
   * id — the prose pattern the dry-run found ("REPLACES the earlier card
   * dec_X"). Matched on EXPLICIT id mentions only (relatedArtifactIds, or the
   * literal decisionId/artifactId appearing in the later card's text). Never
   * fuzzy title matching: a wrong supersede flag tells the human to close work
   * that is still owed.
   *
   * A HINT for triage, never an automatic close — nothing in this codebase
   * acts on it without the human clicking.
   */
  likelySuperseded?: boolean;
  /** The artifact id of the later card that named this one. */
  supersededByArtifactId?: string;
}

/** One session's entry in the bank. */
export interface BankSession {
  sessionId: string;
  projectRoot: string;
  projectName: string;
  /** Best available one-line description. NEVER fabricated — see derivation. */
  oneLiner: string;
  derivationRung: DerivationRung;
  derivationQuality: DerivationQuality;
  /** ISO — newest of (artifact timestamps, session file mtimes). */
  lastActivity: string;
  artifactCount: number;
  openDecisions: BankOpenDecision[];
  openDecisionCount: number;
  /** Changesets + code_changes still awaiting a verdict. */
  draftReviewCount: number;
  /** Human questions with no agent answer (see the intent lane, unanswered.ts). */
  unansweredQuestionCount: number;
  salience: SalienceTag[];
  /** This repo's own demo/fixture data. Flagged, never hidden. */
  fixtureLike?: boolean;
  /** Set when this session's files could only be partially read. */
  degraded?: boolean;
  degradedReason?: string;
}

/** One project's entry in the bank. */
export interface BankProject {
  projectRoot: string;
  name: string;
  /** From the registry — when a daemon last started here. */
  lastSeen: string;
  /** The registry's path-no-longer-exists flag (unmounted volume, deleted worktree). */
  stale: boolean;
  sessions: BankSession[];
  /** Newest lastActivity across sessions; absent when there are none. */
  lastActivity?: string;
  openDecisionCount: number;
  needsYouCount: number;
  /** Set when the project's sessions dir could not be walked at all. */
  degraded?: boolean;
  degradedReason?: string;
}

export interface ContextBank {
  generatedAt: string;
  /** Newest-activity first; projects with no activity sort by lastSeen. */
  projects: BankProject[];
  totals: {
    projects: number;
    sessions: number;
    openDecisions: number;
    /** Sessions carrying at least one open loop. */
    needsYou: number;
    /** Projects the registry knows about whose root no longer exists. */
    staleProjects: number;
  };
  /** Echoed so the UI can word its "quiet since" copy without guessing. */
  staleAfterDays: number;
}

export interface BuildContextBankOptions {
  now?: Date;
  staleAfterDays?: number;
  /** Injectable for tests; defaults to the on-disk registry. */
  registry?: ProjectRegistryReadEntry[];
}

// --- derivation ------------------------------------------------------------

/** Collapse whitespace and truncate on a word boundary. */
export function truncateOneLiner(raw: string, max = ONE_LINER_MAX): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a word boundary when there IS one reasonably near the end —
  // a 140-char single token would otherwise collapse to almost nothing.
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

function contentString(artifact: Artifact, field: string): string {
  const content = (artifact as { content?: unknown }).content;
  if (!content || typeof content !== "object") return "";
  const v = (content as Record<string, unknown>)[field];
  return typeof v === "string" ? v.trim() : "";
}

function newestFirst<T extends { createdAt?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * THE DERIVATION LADDER. Rungs are tried in order and the FIRST one that
 * produces non-empty text wins; the rung that fired is reported so the caller
 * can grade its own confidence:
 *
 *   1. latest debrief `summary`      — the agent narrated the session   (rich)
 *   2. latest changeset `summary`    — a real summary of one change   (medium)
 *   3. an open decision's context/title — the live question           (medium)
 *   4. latest plan/spec title        — a title, not a summary           (thin)
 *   5. first artifact title          — where the session started        (thin)
 *
 * Superseded/retracted/rejected artifacts are skipped for rungs 1-2 and 4: a
 * withdrawn debrief is not what this session is about.
 */
export function deriveOneLiner(
  artifacts: Artifact[],
  openDecisions: BankOpenDecision[],
): { oneLiner: string; rung: DerivationRung; quality: DerivationQuality } {
  const live = artifacts.filter((a) => !isClosedArtifactStatus(a.status) || a.status === "approved");

  const grade = (text: string, rung: DerivationRung) => ({
    oneLiner: truncateOneLiner(text),
    rung,
    quality: RUNG_QUALITY[rung],
  });

  for (const a of newestFirst(live.filter((x) => x.type === "debrief"))) {
    const summary = contentString(a, "summary");
    if (summary) return grade(summary, "debrief-summary");
  }

  for (const a of newestFirst(live.filter((x) => x.type === "changeset"))) {
    const summary = contentString(a, "summary");
    if (summary) return grade(summary, "changeset-summary");
  }

  for (const d of openDecisions) {
    const text = d.context || d.title;
    if (text) return grade(text, "open-decision");
  }

  for (const a of newestFirst(live.filter((x) => x.type === "plan" || x.type === "spec"))) {
    if (a.title?.trim()) return grade(a.title, "plan-or-spec-title");
  }

  const first = [...artifacts].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))[0];
  if (first?.title?.trim()) return grade(first.title, "first-artifact-title");

  return { oneLiner: "", rung: "none", quality: "thin" };
}

/**
 * Flag open decisions that a LIVE, LATER decision explicitly names.
 *
 * Match rules, in strict order of trust:
 *   1. the later artifact's `relatedArtifactIds` contains the older artifact id
 *   2. the later artifact's TEXT (title + serialized content) contains the
 *      older card's `decisionId` or `artifactId` as a literal token
 *
 * Rule 2 is what catches the dry-run's real pattern — a human-written card body
 * saying "this REPLACES the earlier card dec_abc123". There is deliberately no
 * rule 3: title similarity is not evidence, and a false positive here nudges
 * the human to close work that is still owed.
 */
function flagSuperseded(open: BankOpenDecision[], artifacts: Artifact[]): void {
  if (open.length === 0) return;
  const laterCandidates = artifacts.filter(
    (a) => a.type === "decision" && !isClosedArtifactStatus(a.status),
  );
  if (laterCandidates.length === 0) return;

  // Serialize each candidate ONCE — this is O(candidates), not O(open × candidates).
  const texts = laterCandidates.map((a) => {
    let content = "";
    try {
      content = JSON.stringify((a as { content?: unknown }).content ?? "");
    } catch {
      content = "";
    }
    return {
      artifact: a,
      related: new Set(
        Array.isArray((a as { relatedArtifactIds?: unknown }).relatedArtifactIds)
          ? ((a as { relatedArtifactIds?: unknown[] }).relatedArtifactIds as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
          : [],
      ),
      text: `${a.title ?? ""} ${content}`,
    };
  });

  for (const d of open) {
    for (const cand of texts) {
      if (cand.artifact.id === d.artifactId) continue;
      // "LATER" — a card can only be replaced by one written after it.
      if (d.createdAt && cand.artifact.createdAt && cand.artifact.createdAt <= d.createdAt) continue;
      const byRelated = cand.related.has(d.artifactId) || cand.related.has(d.decisionId);
      const byMention =
        mentionsId(cand.text, d.artifactId) || mentionsId(cand.text, d.decisionId);
      if (byRelated || byMention) {
        d.likelySuperseded = true;
        d.supersededByArtifactId = cand.artifact.id;
        break;
      }
    }
  }
}

/**
 * Literal id mention with token boundaries — `dec_abc` must not match
 * `dec_abcdef`. Ids in this codebase are `[A-Za-z0-9_-]`, so the boundary is
 * "not one of those characters".
 */
function mentionsId(haystack: string, id: string): boolean {
  if (!id || id.length < 4) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(id, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1] ?? "";
    const after = haystack[at + id.length] ?? "";
    const isIdChar = (ch: string) => ch !== "" && /[A-Za-z0-9_-]/.test(ch);
    if (!isIdChar(before) && !isIdChar(after)) return true;
    from = at + id.length;
  }
}

/**
 * Salience is DERIVED on every read, never stored — a stored flag goes stale
 * the moment the human acts, and a "needs you" badge that outlives the need is
 * exactly the noise this feature exists to remove.
 *
 * Deliberately NOT included: any "time-sensitive"/urgency tag. Nothing in the
 * data says a decision is urgent; age is reported as a NUMBER and the human
 * decides what old means.
 */
export function deriveSalience(input: {
  openLoops: number;
  artifacts: Artifact[];
  lastActivity: string;
  now: Date;
  staleAfterDays: number;
}): SalienceTag[] {
  const tags: SalienceTag[] = [];
  const ageMs = input.now.getTime() - Date.parse(input.lastActivity);
  const isStale =
    Number.isFinite(ageMs) && ageMs > input.staleAfterDays * 24 * 60 * 60 * 1000;

  if (input.openLoops > 0) tags.push("needs-you");
  else tags.push("quiet");
  if (isStale) tags.push("stale");
  // "done" is a strong claim, so it needs a strong condition: no open loops AND
  // every artifact reached a terminal status. A session with a draft sitting in
  // it is quiet, not done.
  if (
    input.openLoops === 0 &&
    input.artifacts.length > 0 &&
    input.artifacts.every((a) => isClosedArtifactStatus(a.status))
  ) {
    tags.push("done");
  }
  return tags;
}

// --- the scan --------------------------------------------------------------

function readJsonArray<T>(label: string, file: string, idField: string): T[] {
  if (!fs.existsSync(file)) return [];
  return salvageArray<T>(label, JSON.parse(fs.readFileSync(file, "utf-8")), idField);
}

function mtimeIso(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function daysBetween(from: string | undefined, now: Date): number | undefined {
  if (!from) return undefined;
  const t = Date.parse(from);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000)));
}

/**
 * Scan one project. TOTAL: every failure narrows to a flagged, thinner entry.
 * A corrupt session must never cost the human the other nine.
 */
export function scanProject(
  entry: ProjectRegistryReadEntry,
  opts: { now: Date; staleAfterDays: number },
): BankProject {
  const project: BankProject = {
    projectRoot: entry.projectRoot,
    name: entry.name,
    lastSeen: entry.lastSeen,
    stale: entry.stale,
    sessions: [],
    openDecisionCount: 0,
    needsYouCount: 0,
  };
  if (entry.stale) return project;

  const sessionsDir = path.join(entry.projectRoot, ".deeppairing", "sessions");
  let dirNames: string[];
  try {
    if (!fs.existsSync(sessionsDir)) return project;
    dirNames = fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    project.degraded = true;
    project.degradedReason = `sessions dir unreadable: ${String(err)}`;
    return project;
  }

  // One decisions read for the whole project (reuses the store-less scanner
  // that already salvages per-session corruption and resolves supersede chains).
  // Disk-only on purpose: the bank is a cross-project READ, and no other
  // project's live daemon is reachable from here anyway.
  let decisionsBySession: Record<string, ProjectDecision[]> = {};
  try {
    const all = listAllDecisions(entry.projectRoot);
    decisionsBySession = groupBySession(all.decisions);
  } catch (err) {
    project.degraded = true;
    project.degradedReason = `decisions scan failed: ${String(err)}`;
  }

  for (const sessionId of dirNames) {
    const session = scanSession({
      sessionId,
      sessionsDir,
      project: entry,
      decisions: decisionsBySession[sessionId] ?? [],
      now: opts.now,
      staleAfterDays: opts.staleAfterDays,
    });
    // The 33-empty-dirs case: a session dir with no artifacts is a mkdir that
    // never became work. Nothing to show, nothing to leave off from.
    if (!session) continue;
    project.sessions.push(session);
  }

  project.sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  project.lastActivity = project.sessions[0]?.lastActivity;
  project.openDecisionCount = project.sessions.reduce((n, s) => n + s.openDecisionCount, 0);
  project.needsYouCount = project.sessions.filter((s) => s.salience.includes("needs-you")).length;
  return project;
}

function groupBySession(decisions: ProjectDecision[]): Record<string, ProjectDecision[]> {
  const out: Record<string, ProjectDecision[]> = {};
  for (const d of decisions) (out[d.sessionId] ??= []).push(d);
  return out;
}

function scanSession(input: {
  sessionId: string;
  sessionsDir: string;
  project: ProjectRegistryReadEntry;
  decisions: ProjectDecision[];
  now: Date;
  staleAfterDays: number;
}): BankSession | null {
  const { sessionId, sessionsDir, project, now, staleAfterDays } = input;
  const dir = path.join(sessionsDir, sessionId);
  const artFile = path.join(dir, "artifacts.json");
  const commentsFile = path.join(dir, "comments.json");

  let artifacts: Artifact[] = [];
  let degraded = false;
  let degradedReason: string | undefined;
  try {
    artifacts = readJsonArray<Artifact>(`bank:${sessionId}/artifacts.json`, artFile, "id");
  } catch (err) {
    degraded = true;
    degradedReason = `artifacts.json unreadable: ${String(err)}`;
    salvageLog(`bank:${sessionId}/artifacts.json`, String(err));
  }

  // Empty dir filter — but only when the session is genuinely EMPTY. A session
  // whose artifacts.json exists and failed to parse is CORRUPT, which is a
  // different thing and gets a flagged thin entry rather than silent removal.
  if (artifacts.length === 0 && !degraded) return null;

  let comments: Comment[] = [];
  try {
    comments = readJsonArray<Comment>(`bank:${sessionId}/comments.json`, commentsFile, "id");
  } catch (err) {
    degraded = true;
    degradedReason = degradedReason ?? `comments.json unreadable: ${String(err)}`;
  }

  const open: BankOpenDecision[] = input.decisions
    // "open" == the human still owes an answer: unresolved AND the backing
    // artifact hasn't reached a terminal status (listAllDecisions already
    // computes that second half as closedUnresolved).
    .filter((d) => !d.resolved && !d.closedUnresolved)
    .map((d) => ({
      decisionId: d.decisionId,
      artifactId: d.artifactId,
      title: d.artifactTitle,
      context: d.context,
      stakes: d.stakes,
      createdAt: d.createdAt,
      ageDays: daysBetween(d.createdAt, now),
    }))
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  flagSuperseded(open, artifacts);

  const draftReviewCount = artifacts.filter(
    (a) => (a.type === "changeset" || a.type === "code_change") && !isClosedArtifactStatus(a.status),
  ).length;

  let unansweredQuestionCount = 0;
  try {
    unansweredQuestionCount = collectUnansweredQuestions(comments).length;
  } catch {
    // A shape the thread-walker can't handle must not lose the whole session.
    unansweredQuestionCount = 0;
  }

  const lastActivity = deriveLastActivity(artifacts, [artFile, commentsFile, path.join(dir, "decisions.json")]);
  const { oneLiner, rung, quality } = deriveOneLiner(artifacts, open);
  const openLoops = open.length + draftReviewCount + unansweredQuestionCount;

  const session: BankSession = {
    sessionId,
    projectRoot: project.projectRoot,
    projectName: project.name,
    oneLiner,
    derivationRung: rung,
    derivationQuality: quality,
    lastActivity,
    artifactCount: artifacts.length,
    openDecisions: open,
    openDecisionCount: open.length,
    draftReviewCount,
    unansweredQuestionCount,
    salience: deriveSalience({ openLoops, artifacts, lastActivity, now, staleAfterDays }),
  };
  if (looksLikeFixtureSession(sessionId)) session.fixtureLike = true;
  if (degraded) {
    session.degraded = true;
    session.degradedReason = degradedReason;
    // A session we could not fully read must never advertise a confident
    // one-liner grade.
    session.derivationQuality = "thin";
  }
  return session;
}

/**
 * Newest of the artifact timestamps and the session files' mtimes. mtimes
 * matter because a comment or a status flip touches a file without minting a
 * new artifact — recency from artifacts alone reads a just-reviewed session as
 * weeks old.
 */
function deriveLastActivity(artifacts: Artifact[], files: string[]): string {
  let best = "";
  for (const a of artifacts) {
    const t = a.updatedAt ?? a.createdAt;
    if (t && t > best) best = t;
  }
  for (const f of files) {
    const m = mtimeIso(f);
    if (m && m > best) best = m;
  }
  return best || new Date(0).toISOString();
}

/** Build the whole bank. Read-only; never throws for one bad project. */
export function buildContextBank(options: BuildContextBankOptions = {}): ContextBank {
  const now = options.now ?? new Date();
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  let registry: ProjectRegistryReadEntry[];
  try {
    registry = options.registry ?? readProjectRegistry();
  } catch (err) {
    if (process.env.VITEST || process.env.NODE_ENV === "test") throw err;
    salvageLog("context-bank", `registry read failed: ${String(err)}`);
    registry = [];
  }

  const projects: BankProject[] = [];
  for (const entry of registry) {
    try {
      projects.push(scanProject(entry, { now, staleAfterDays }));
    } catch (err) {
      // Belt-and-suspenders: scanProject is already total, but a future edit
      // must not be able to take the whole bank down with one bad project.
      projects.push({
        projectRoot: entry.projectRoot,
        name: entry.name,
        lastSeen: entry.lastSeen,
        stale: entry.stale,
        sessions: [],
        openDecisionCount: 0,
        needsYouCount: 0,
        degraded: true,
        degradedReason: String(err),
      });
    }
  }

  projects.sort((a, b) => (b.lastActivity ?? b.lastSeen).localeCompare(a.lastActivity ?? a.lastSeen));

  return {
    generatedAt: now.toISOString(),
    projects,
    totals: {
      projects: projects.length,
      sessions: projects.reduce((n, p) => n + p.sessions.length, 0),
      openDecisions: projects.reduce((n, p) => n + p.openDecisionCount, 0),
      needsYou: projects.reduce((n, p) => n + p.needsYouCount, 0),
      staleProjects: projects.filter((p) => p.stale).length,
    },
    staleAfterDays,
  };
}

// --- cache -----------------------------------------------------------------

let cache: { at: number; bank: ContextBank } | null = null;

/**
 * TTL-cached bank. The scan is a disk walk over every known project, and the
 * UI polls; without this, N tabs × 30s each re-walk every project's session
 * tree. `fresh` bypasses the TTL (the "refresh" affordance).
 */
export function getContextBank(
  options: BuildContextBankOptions & { fresh?: boolean; ttlMs?: number } = {},
): ContextBank {
  const ttl = options.ttlMs ?? DEFAULT_BANK_TTL_MS;
  const nowMs = (options.now ?? new Date()).getTime();
  if (!options.fresh && cache && nowMs - cache.at < ttl) return cache.bank;
  const bank = buildContextBank(options);
  cache = { at: nowMs, bank };
  return bank;
}

/** Drop the cached scan (tests, and any write that invalidates the model). */
export function clearContextBankCache(): void {
  cache = null;
}

/**
 * The `/api/projects` sweep enrichment: the two numbers the switcher wants per
 * peer project, sourced from DISK so a peer daemon doesn't have to answer for
 * them. Total — a project we can't read reports zeros, never a failed sweep.
 */
export function summarizeProject(
  projectRoot: string,
  opts: { now?: Date } = {},
): { lastActivity?: string; openDecisionCount: number } {
  try {
    const summary = scanProject(
      { projectRoot, name: path.basename(projectRoot), lastSeen: new Date(0).toISOString(), stale: false },
      { now: opts.now ?? new Date(), staleAfterDays: DEFAULT_STALE_AFTER_DAYS },
    );
    return { lastActivity: summary.lastActivity, openDecisionCount: summary.openDecisionCount };
  } catch {
    return { openDecisionCount: 0 };
  }
}
