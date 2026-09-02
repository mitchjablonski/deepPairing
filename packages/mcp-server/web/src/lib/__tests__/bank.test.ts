import { describe, it, expect } from "vitest";
import {
  ageTone,
  compactAge,
  groupBank,
  laneTags,
  maxDecisionAge,
  maxStakesRank,
  normalizeBank,
  samePath,
  shouldLandOnBank,
  visibleDecisions,
  type BankOpenDecision,
  type BankProject,
  type BankSession,
  type ContextBank,
} from "../bank";

function decision(over: Partial<BankOpenDecision> = {}): BankOpenDecision {
  return {
    decisionId: over.decisionId ?? "dec_1",
    artifactId: over.artifactId ?? "art_1",
    title: "Which cache?",
    context: "Which cache should we use?",
    ...over,
  };
}

function session(over: Partial<BankSession> = {}): BankSession {
  return {
    sessionId: "s1",
    projectRoot: "/p/alpha",
    projectName: "alpha",
    oneLiner: "We replaced the cache",
    derivationRung: "debrief-summary",
    derivationQuality: "rich",
    lastActivity: "2026-08-01T00:00:00.000Z",
    artifactCount: 4,
    openDecisions: [],
    openDecisionCount: 0,
    draftReviewCount: 0,
    unansweredQuestionCount: 0,
    salience: ["quiet"],
    ...over,
  };
}

function project(over: Partial<BankProject> = {}): BankProject {
  return {
    projectRoot: "/p/alpha",
    name: "alpha",
    lastSeen: "2026-08-01T00:00:00.000Z",
    stale: false,
    sessions: [],
    openDecisionCount: 0,
    needsYouCount: 0,
    waitingOnAgentCount: 0,
    ...over,
  };
}

function bank(projects: BankProject[]): ContextBank {
  return {
    generatedAt: "2026-08-20T00:00:00.000Z",
    projects,
    totals: {
      projects: projects.length,
      sessions: projects.reduce((n, p) => n + p.sessions.length, 0),
      openDecisions: 0,
      needsYou: 0,
      waitingOnAgent: 0,
      staleProjects: 0,
    },
    staleAfterDays: 21,
  };
}

describe("groupBank — triage-first ordering", () => {
  it("ranks needs-you by stakes, then by the oldest open decision", () => {
    const oldLow = session({
      sessionId: "old-low",
      salience: ["needs-you"],
      openDecisionCount: 1,
      openDecisions: [decision({ decisionId: "d_old", stakes: "low", ageDays: 90 })],
    });
    const freshHigh = session({
      sessionId: "fresh-high",
      salience: ["needs-you"],
      openDecisionCount: 1,
      openDecisions: [decision({ decisionId: "d_hi", stakes: "high", ageDays: 2 })],
    });
    const olderHigh = session({
      sessionId: "older-high",
      salience: ["needs-you"],
      openDecisionCount: 1,
      openDecisions: [decision({ decisionId: "d_hi2", stakes: "high", ageDays: 40 })],
    });
    const draftOnly = session({
      sessionId: "draft-only",
      salience: ["needs-you"],
      draftReviewCount: 2,
    });

    const lanes = groupBank(bank([project({ sessions: [draftOnly, freshHigh, oldLow, olderHigh] })]));
    expect(lanes.needsYou.map((r) => r.session.sessionId)).toEqual([
      "older-high",
      "fresh-high",
      "old-low",
      "draft-only",
    ]);
  });

  it("orders the waiting lane longest-wait first", () => {
    const recent = session({ sessionId: "recent", salience: ["waiting-on-agent"], unansweredQuestionCount: 1, lastActivity: "2026-08-10T00:00:00.000Z" });
    const ancient = session({ sessionId: "ancient", salience: ["waiting-on-agent"], unansweredQuestionCount: 3, lastActivity: "2026-06-01T00:00:00.000Z" });
    const lanes = groupBank(bank([project({ sessions: [recent, ancient] })]));
    expect(lanes.waiting.map((r) => r.session.sessionId)).toEqual(["ancient", "recent"]);
  });

  it("orders quiet and done by recency", () => {
    const older = session({ sessionId: "older", salience: ["quiet"], lastActivity: "2026-05-01T00:00:00.000Z" });
    const newer = session({ sessionId: "newer", salience: ["quiet"], lastActivity: "2026-08-01T00:00:00.000Z" });
    const doneOld = session({ sessionId: "done-old", salience: ["done"], lastActivity: "2026-01-01T00:00:00.000Z" });
    const doneNew = session({ sessionId: "done-new", salience: ["done"], lastActivity: "2026-07-01T00:00:00.000Z" });
    const lanes = groupBank(bank([project({ sessions: [older, newer, doneOld, doneNew] })]));
    expect(lanes.quiet.map((r) => r.session.sessionId)).toEqual(["newer", "older"]);
    expect(lanes.done.map((r) => r.session.sessionId)).toEqual(["done-new", "done-old"]);
  });
});

describe("groupBank — the two lanes never merge", () => {
  it("keeps an unanswered question OUT of needs-you when that's all there is", () => {
    const asked = session({ sessionId: "asked", salience: ["waiting-on-agent"], unansweredQuestionCount: 2 });
    const lanes = groupBank(bank([project({ sessions: [asked] })]));
    expect(lanes.needsYou).toHaveLength(0);
    expect(lanes.waiting.map((r) => r.session.sessionId)).toEqual(["asked"]);
    expect(lanes.quiet).toHaveLength(0);
  });

  it("lists a session that owes in BOTH directions in both lanes, never collapsed into one", () => {
    const both = session({
      sessionId: "both",
      salience: ["needs-you", "waiting-on-agent"],
      openDecisionCount: 1,
      openDecisions: [decision({ ageDays: 5 })],
      unansweredQuestionCount: 1,
    });
    const lanes = groupBank(bank([project({ sessions: [both] })]));
    expect(lanes.needsYou).toHaveLength(1);
    expect(lanes.waiting).toHaveLength(1);
    expect(lanes.quiet).toHaveLength(0);
    // Distinct row identities per lane — the surface renders two rows, and the
    // two counts stay independently true.
    expect(lanes.needsYou[0]?.key).toBe(lanes.waiting[0]?.key);
  });

  it("falls back to the same split when a payload carries no salience tags", () => {
    expect(laneTags(session({ salience: [], unansweredQuestionCount: 1 }))).toEqual({
      needsYou: false, waiting: true, done: false,
    });
    expect(laneTags(session({ salience: [], draftReviewCount: 1 }))).toEqual({
      needsYou: true, waiting: false, done: false,
    });
  });
});

describe("groupBank — fixtures", () => {
  it("pulls fixture sessions out of every lane into their own group", () => {
    const demo = session({ sessionId: "demo_1", fixtureLike: true, salience: ["needs-you"], openDecisionCount: 1, openDecisions: [decision({ stakes: "high", ageDays: 99 })] });
    const real = session({ sessionId: "real", salience: ["needs-you"], openDecisionCount: 1, openDecisions: [decision({ stakes: "low", ageDays: 1 })] });
    const lanes = groupBank(bank([project({ sessions: [demo, real] })]));
    expect(lanes.needsYou.map((r) => r.session.sessionId)).toEqual(["real"]);
    expect(lanes.fixtures.map((r) => r.session.sessionId)).toEqual(["demo_1"]);
  });
});

describe("shouldLandOnBank", () => {
  const alpha = project({ projectRoot: "/p/alpha", name: "alpha", sessions: [session({ sessionId: "a1" })] });
  const beta = project({ projectRoot: "/p/beta", name: "beta", sessions: [session({ sessionId: "b1", projectRoot: "/p/beta" })] });

  it("lands on the bank when more than one project has real work", () => {
    expect(shouldLandOnBank(bank([alpha, beta]), { currentProjectRoot: "/p/alpha" })).toBe(true);
  });

  it("lands on the bank when THIS project has more than one live thread", () => {
    const multi = project({
      projectRoot: "/p/alpha",
      sessions: [session({ sessionId: "a1" }), session({ sessionId: "a2" })],
    });
    expect(shouldLandOnBank(bank([multi]), { currentProjectRoot: "/p/alpha" })).toBe(true);
  });

  it("does NOT hijack the single-project single-session flow", () => {
    expect(shouldLandOnBank(bank([alpha]), { currentProjectRoot: "/p/alpha" })).toBe(false);
  });

  it("does not count fixture threads or finished ones as live cross-signal", () => {
    const demoOnly = project({ projectRoot: "/p/beta", sessions: [session({ sessionId: "demo_x", projectRoot: "/p/beta", fixtureLike: true })] });
    expect(shouldLandOnBank(bank([alpha, demoOnly]), { currentProjectRoot: "/p/alpha" })).toBe(false);
    const oneLiveOneDone = project({
      projectRoot: "/p/alpha",
      sessions: [session({ sessionId: "a1" }), session({ sessionId: "a2", salience: ["done"] })],
    });
    expect(shouldLandOnBank(bank([oneLiveOneDone]), { currentProjectRoot: "/p/alpha" })).toBe(false);
  });

  it("never overrides a deep link", () => {
    expect(
      shouldLandOnBank(bank([alpha, beta]), { currentProjectRoot: "/p/alpha", deepLinkedSession: "a1" }),
    ).toBe(false);
  });

  it("is false before the bank has loaded", () => {
    expect(shouldLandOnBank(null, { currentProjectRoot: "/p/alpha" })).toBe(false);
  });
});

describe("small helpers", () => {
  it("compactAge renders a bare unit and never a negative", () => {
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    expect(compactAge("2026-08-06T00:00:00.000Z", now)).toBe("14d");
    expect(compactAge("2026-08-19T21:00:00.000Z", now)).toBe("3h");
    expect(compactAge("2026-08-19T23:30:00.000Z", now)).toBe("30m");
    expect(compactAge("2026-08-20T00:00:00.000Z", now)).toBe("now");
    expect(compactAge("2026-08-21T00:00:00.000Z", now)).toBe("now");
    expect(compactAge("not-a-date", now)).toBe("—");
  });

  it("ageTone is amber past 30 days and red past 60", () => {
    expect(ageTone(undefined)).toBe("none");
    expect(ageTone(30)).toBe("none");
    expect(ageTone(31)).toBe("amber");
    expect(ageTone(60)).toBe("amber");
    expect(ageTone(61)).toBe("red");
  });

  it("samePath tolerates separators, trailing slashes and case", () => {
    expect(samePath("C:\\dev\\alpha", "c:/dev/alpha/")).toBe(true);
    expect(samePath("/p/alpha", "/p/beta")).toBe(false);
    expect(samePath(null, "/p/alpha")).toBe(false);
  });

  it("maxStakesRank / maxDecisionAge read the whole decision list", () => {
    const s = session({ openDecisions: [decision({ stakes: "low", ageDays: 3 }), decision({ decisionId: "d2", stakes: "high", ageDays: 70 })] });
    expect(maxStakesRank(s)).toBe(3);
    expect(maxDecisionAge(s)).toBe(70);
    expect(maxStakesRank(session())).toBe(-1);
  });

  it("visibleDecisions hides optimistically closed-out cards only", () => {
    const s = session({ openDecisions: [decision({ artifactId: "art_a" }), decision({ decisionId: "d2", artifactId: "art_b" })] });
    expect(visibleDecisions(s, { art_a: true }).map((d) => d.artifactId)).toEqual(["art_b"]);
    expect(visibleDecisions(s, {})).toHaveLength(2);
  });
});

describe("normalizeBank — the accessory surface can never take the shell down", () => {
  it("fills in a payload with no totals instead of handing back a half-object", () => {
    // The exact shape that crashed App's header badge: a 200 whose body has no
    // `totals` at all. `bank?.totals.needsYou` is not enough guarding — a bank
    // that exists but is malformed is the dangerous case, not a missing one.
    const b = normalizeBank({ projects: [] });
    expect(b?.totals).toEqual({
      projects: 0, sessions: 0, openDecisions: 0, needsYou: 0, waitingOnAgent: 0, staleProjects: 0,
    });
    expect(b?.projects).toEqual([]);
  });

  it("tolerates a project with no sessions array and non-numeric totals", () => {
    const b = normalizeBank({
      projects: [{ projectRoot: "/p/alpha", name: "alpha" }],
      totals: { projects: "3", needsYou: null },
    });
    expect(b?.projects[0]?.sessions).toEqual([]);
    expect(b?.totals.projects).toBe(0);
    expect(groupBank(b)).toBeTruthy();
  });

  it("refuses a non-object body outright", () => {
    expect(normalizeBank(null)).toBeNull();
    expect(normalizeBank("nope")).toBeNull();
  });

  it("passes a well-formed bank through unchanged in every field it renders", () => {
    const good = bank([project({ sessions: [session()] })]);
    const b = normalizeBank(good);
    expect(b?.totals).toEqual(good.totals);
    expect(b?.projects[0]?.sessions[0]?.sessionId).toBe("s1");
  });
});
