/**
 * The CONTEXT BANK, client side — types + the pure triage logic the surface
 * renders. Kept out of the component so the ordering rules, the lane split and
 * the landing heuristic are testable without a DOM (web-node project).
 *
 * The server model lives in `src/store/context-bank.ts`; these interfaces are
 * the wire shape it serves from `GET /api/context-bank`. They are declared
 * locally (the ProjectSwitcher / ProjectDecisionsModal precedent) rather than
 * imported from the server tree — the web build has no path into `src/`.
 * Every field the server marks optional stays optional here.
 */

/**
 * How much to TRUST a session's one-liner.
 *
 * THE UI KEYS ON THIS AND ONLY THIS. The server also reports `derivationRung`,
 * but the rung is diagnostic detail — a degraded session can report
 * `debrief-summary` while being force-graded `thin`, so a card that branched on
 * the rung would present a degraded read as a narrated one. Quality is the
 * contract; new rungs will be added under the same three grades.
 */
export type DerivationQuality = "rich" | "medium" | "thin";

export type DerivationRung =
  | "debrief-summary"
  | "changeset-summary"
  | "open-decision"
  | "plan-or-spec-title"
  | "first-artifact-title"
  | "none";

/**
 * `needs-you` and `waiting-on-agent` are the two sides of "whose turn is it"
 * and MUST NOT be merged in the UI either: an unanswered human question is the
 * AGENT's turn, and folding it into "what needs me" points the human at the one
 * thing they cannot act on. They get separate lanes all the way down.
 */
export type SalienceTag = "needs-you" | "waiting-on-agent" | "quiet" | "stale" | "done";

export interface BankOpenDecision {
  decisionId: string;
  artifactId: string;
  title: string;
  context: string;
  stakes?: "low" | "medium" | "high";
  createdAt?: string;
  ageDays?: number;
  /**
   * A later live card in the same session explicitly NAMES this one's id.
   * That is evidence of a REFERENCE, not proof of replacement — the badge copy
   * is "another card mentions this" and never the word "superseded".
   */
  likelySuperseded?: boolean;
  supersededByArtifactId?: string;
}

export interface BankSession {
  sessionId: string;
  projectRoot: string;
  projectName: string;
  oneLiner: string;
  derivationRung: DerivationRung;
  derivationQuality: DerivationQuality;
  lastActivity: string;
  artifactCount: number;
  openDecisions: BankOpenDecision[];
  openDecisionCount: number;
  draftReviewCount: number;
  unansweredQuestionCount: number;
  salience: SalienceTag[];
  fixtureLike?: boolean;
  degraded?: boolean;
  degradedReason?: string;
}

export interface BankProject {
  projectRoot: string;
  name: string;
  lastSeen: string;
  stale: boolean;
  sessions: BankSession[];
  lastActivity?: string;
  openDecisionCount: number;
  needsYouCount: number;
  waitingOnAgentCount: number;
  degraded?: boolean;
  degradedReason?: string;
}

export interface ContextBank {
  generatedAt: string;
  projects: BankProject[];
  totals: {
    projects: number;
    sessions: number;
    openDecisions: number;
    needsYou: number;
    waitingOnAgent: number;
    staleProjects: number;
  };
  staleAfterDays: number;
}

/** One rendered row: a session, plus the project it belongs to. */
export interface BankRow {
  /** Stable per project+session — the expand key and the React key base. */
  key: string;
  session: BankSession;
  project: BankProject;
}

export interface BankLanes {
  /** Open decisions / draft reviews — work stalled on YOU. */
  needsYou: BankRow[];
  /** Unanswered human questions — the AGENT owes you. Never merged above. */
  waiting: BankRow[];
  /** Neither side owes anything, but the thread isn't finished. */
  quiet: BankRow[];
  done: BankRow[];
  /** This repo's own demo/fixture data — grouped, collapsed, never hidden. */
  fixtures: BankRow[];
}

export function rowKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}::${sessionId}`;
}

/** Windows/posix-tolerant path compare for registry roots vs the daemon's own. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

const STAKES_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Highest stakes among a session's open decisions; -1 when it has none. */
export function maxStakesRank(session: BankSession): number {
  if (session.openDecisions.length === 0) return -1;
  return session.openDecisions.reduce(
    (best, d) => Math.max(best, STAKES_RANK[d.stakes ?? ""] ?? 0),
    0,
  );
}

/** Age of the OLDEST open decision in a session, in whole days (0 when none). */
export function maxDecisionAge(session: BankSession): number {
  return session.openDecisions.reduce((best, d) => Math.max(best, d.ageDays ?? 0), 0);
}

function ms(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Which lanes a session belongs to. Read from the SERVER's salience tags — the
 * split is the server's call (see M1 in the data-layer PR) and the UI must not
 * re-derive it. The fallback only fires for a payload with no tags at all
 * (older daemon), and reproduces the same rule rather than inventing another.
 *
 * A session can owe in BOTH directions — you have a decision to make AND the
 * agent owes you an answer. It then appears in both lanes, deliberately: they
 * answer different questions, and dropping it from one would under-report that
 * lane. What must never happen is the two collapsing into one count.
 */
export function laneTags(session: BankSession): { needsYou: boolean; waiting: boolean; done: boolean } {
  const tags = session.salience ?? [];
  if (tags.length > 0) {
    return {
      needsYou: tags.includes("needs-you"),
      waiting: tags.includes("waiting-on-agent"),
      done: tags.includes("done"),
    };
  }
  return {
    needsYou: session.openDecisionCount + session.draftReviewCount > 0,
    waiting: session.unansweredQuestionCount > 0,
    done: false,
  };
}

/**
 * TRIAGE-FIRST grouping + ordering.
 *
 *  - needs-you    highest stakes first, then the oldest open decision. A
 *                 session whose only loop is a draft review (no decision) has
 *                 no stakes/age to rank on and sorts after the decisions.
 *  - waiting      LONGEST-WAITING first (oldest lastActivity) — the question
 *                 the agent has been sitting on the longest is the one at risk
 *                 of being forgotten.
 *  - quiet/done   most recent first.
 *
 * Fixture-flagged sessions are pulled out of every lane into their own group
 * regardless of what they'd otherwise be, so demo data can never sit at the top
 * of a real triage queue.
 */
export function groupBank(bank: ContextBank | null): BankLanes {
  const lanes: BankLanes = { needsYou: [], waiting: [], quiet: [], done: [], fixtures: [] };
  if (!bank) return lanes;

  for (const project of bank.projects ?? []) {
    for (const session of project.sessions ?? []) {
      const row: BankRow = { key: rowKey(project.projectRoot, session.sessionId), session, project };
      if (session.fixtureLike) {
        lanes.fixtures.push(row);
        continue;
      }
      const { needsYou, waiting, done } = laneTags(session);
      if (needsYou) lanes.needsYou.push(row);
      if (waiting) lanes.waiting.push(row);
      if (!needsYou && !waiting) (done ? lanes.done : lanes.quiet).push(row);
    }
  }

  lanes.needsYou.sort(
    (a, b) =>
      maxStakesRank(b.session) - maxStakesRank(a.session) ||
      maxDecisionAge(b.session) - maxDecisionAge(a.session) ||
      ms(a.session.lastActivity) - ms(b.session.lastActivity),
  );
  lanes.waiting.sort(
    (a, b) =>
      ms(a.session.lastActivity) - ms(b.session.lastActivity) ||
      b.session.unansweredQuestionCount - a.session.unansweredQuestionCount,
  );
  const recent = (a: BankRow, b: BankRow) => ms(b.session.lastActivity) - ms(a.session.lastActivity);
  lanes.quiet.sort(recent);
  lanes.done.sort(recent);
  lanes.fixtures.sort(recent);
  return lanes;
}

/**
 * THE LANDING HEURISTIC — bank, or straight into the session?
 *
 * The bank earns the landing only when it carries cross-signal the session view
 * structurally cannot show: more than one project with real work, or more than
 * one live thread in this one. A single-project / single-session user gets
 * exactly the flow they had before — hijacking that would put a triage index in
 * front of someone with nothing to triage.
 *
 * A DEEP LINK always wins. `?session=<id>` is someone (or `deeppairing demo`)
 * asking for a specific spot; landing anywhere else would break it.
 */
export function shouldLandOnBank(
  bank: ContextBank | null,
  opts: { deepLinkedSession?: string | null; currentProjectRoot?: string | null } = {},
): boolean {
  if (opts.deepLinkedSession) return false;
  if (!bank) return false;
  const projects = bank.projects ?? [];
  const withRealWork = projects.filter((p) => (p.sessions ?? []).some((s) => !s.fixtureLike));
  if (withRealWork.length > 1) return true;
  const current = projects.find((p) => samePath(p.projectRoot, opts.currentProjectRoot));
  const liveHere = (current?.sessions ?? []).filter(
    (s) => !s.fixtureLike && !laneTags(s).done,
  ).length;
  return liveHere > 1;
}

/** Compact recency for a row — "14d", "3h", "now". Never "-2m" on clock skew. */
export function compactAge(iso: string, now: number = Date.now()): string {
  const delta = now - ms(iso);
  if (!Number.isFinite(delta) || ms(iso) === 0) return "—";
  if (delta < 60_000) return "now";
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The age badge's tone. Amber past 30 days, red past 60 — reported, never
 * acted on: the server deliberately ships a NUMBER and no urgency verdict.
 */
export function ageTone(ageDays: number | undefined): "none" | "amber" | "red" {
  if (ageDays === undefined) return "none";
  if (ageDays > 60) return "red";
  if (ageDays > 30) return "amber";
  return "none";
}

/** Open decisions minus the ones this tab has optimistically closed out. */
export function visibleDecisions(
  session: BankSession,
  closedOut: Record<string, true>,
): BankOpenDecision[] {
  return session.openDecisions.filter((d) => !closedOut[d.artifactId]);
}

/**
 * Coerce whatever the daemon actually returned into a shape the surface can
 * render. Fail-SOFT, deliberately.
 *
 * Found by the existing App suites: a payload missing `totals` (an older
 * daemon, a proxy, a truncated body) crashed the ENTIRE app shell from a header
 * badge — the bank is an accessory surface and must never be able to take the
 * session view down with it. Missing pieces become empty/zero here, so a
 * degraded read shows an empty bank rather than a white screen. Nothing is
 * invented: absent counts read as 0, which is what "we could not read it" looks
 * like everywhere else in this model.
 */
export function normalizeBank(raw: unknown): ContextBank | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ContextBank>;
  const totals = (r.totals ?? {}) as Partial<ContextBank["totals"]>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const projects = Array.isArray(r.projects) ? r.projects : [];
  return {
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : "",
    projects: projects.map((p) => ({
      ...p,
      sessions: Array.isArray(p?.sessions) ? p.sessions : [],
    })),
    totals: {
      projects: num(totals.projects),
      sessions: num(totals.sessions),
      openDecisions: num(totals.openDecisions),
      needsYou: num(totals.needsYou),
      waitingOnAgent: num(totals.waitingOnAgent),
      staleProjects: num(totals.staleProjects),
    },
    staleAfterDays: num(r.staleAfterDays),
  };
}
