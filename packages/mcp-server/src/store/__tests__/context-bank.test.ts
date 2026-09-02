// The context bank read-model — the cross-project "what am I doing / what needs
// me / where did I leave off" scanner.
//
// Fixture strategy: raw JSON trees under a tmpdir, NOT FileStore instances.
// The bank is a disk scanner, so the thing under test is exactly "what does it
// make of these bytes" — including bytes a FileStore would never write (corrupt
// files, empty session dirs, a decisions.json with no artifacts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildContextBank,
  getContextBank,
  clearContextBankCache,
  truncateOneLiner,
  summarizeProject,
  DEFAULT_STALE_AFTER_DAYS,
  BANK_FRESH_FLOOR_MS,
  type BankProject,
  type BankSession,
} from "../context-bank.js";
import {
  upsertProject,
  readProjectRegistry,
  setProjectRegistryPathForTests,
} from "../project-registry.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const ISO = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-bank-"));
  setProjectRegistryPathForTests(path.join(tmp, "home", "projects.json"));
  clearContextBankCache();
});

afterEach(() => {
  setProjectRegistryPathForTests(null);
  clearContextBankCache();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// --- fixture builders ------------------------------------------------------

function project(name: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions"), { recursive: true });
  upsertProject(root, NOW);
  return root;
}

function sessionDir(root: string, sessionId: string): string {
  const dir = path.join(root, ".deeppairing", "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface ArtIn {
  id: string;
  type: string;
  title?: string;
  status?: string;
  content?: unknown;
  createdAt?: string;
  relatedArtifactIds?: string[];
}

function writeSession(
  root: string,
  sessionId: string,
  data: { artifacts?: ArtIn[]; decisions?: unknown[]; comments?: unknown[] },
): string {
  const dir = sessionDir(root, sessionId);
  if (data.artifacts) {
    fs.writeFileSync(
      path.join(dir, "artifacts.json"),
      JSON.stringify(
        data.artifacts.map((a) => ({
          version: 1,
          status: "draft",
          title: a.id,
          content: {},
          createdAt: ISO(1),
          updatedAt: a.createdAt ?? ISO(1),
          ...a,
        })),
      ),
    );
  }
  if (data.decisions) fs.writeFileSync(path.join(dir, "decisions.json"), JSON.stringify(data.decisions));
  if (data.comments) fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify(data.comments));
  return dir;
}

/** Push every file in a session dir back N days (mtime is part of lastActivity). */
function backdate(dir: string, daysAgo: number): void {
  const when = new Date(NOW.getTime() - daysAgo * 86_400_000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), when, when);
}

function openDecisionRecord(over: Partial<Record<string, unknown>> = {}) {
  return {
    decisionId: "dec_1",
    artifactId: "art_dec_1",
    context: "Redis or in-process cache for the session store?",
    options: [{ id: "o1", title: "Redis" }],
    stakes: "medium",
    createdAt: ISO(70),
    ...over,
  };
}

const bank = (over: Parameters<typeof buildContextBank>[0] = {}) =>
  buildContextBank({ now: NOW, ...over });

const onlyProject = (name: string): BankProject => {
  const p = bank().projects.find((x) => x.name === name);
  if (!p) throw new Error(`no project ${name} in bank`);
  return p;
};
const onlySession = (name: string, sessionId: string): BankSession => {
  const s = onlyProject(name).sessions.find((x) => x.sessionId === sessionId);
  if (!s) throw new Error(`no session ${sessionId}`);
  return s;
};

// --- the derivation ladder -------------------------------------------------

describe("context bank — the derivation ladder", () => {
  it("rung 1 (RICH): a debrief summary wins over everything below it", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_1", type: "plan", title: "Plan: cache layer", createdAt: ISO(5) },
        { id: "art_cs", type: "changeset", title: "cs", content: { summary: "Swapped the cache" }, createdAt: ISO(3) },
        { id: "art_db", type: "debrief", title: "db", content: { summary: "We replaced the session cache with Redis and cut p99 by half." }, createdAt: ISO(2) },
      ],
    });
    const s = onlySession("alpha", "s1");
    expect(s.derivationRung).toBe("debrief-summary");
    expect(s.derivationQuality).toBe("rich");
    expect(s.oneLiner).toBe("We replaced the session cache with Redis and cut p99 by half.");
  });

  it("skips a SUPERSEDED debrief and falls to the changeset summary", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_db", type: "debrief", status: "superseded", content: { summary: "old story" }, createdAt: ISO(4) },
        { id: "art_cs", type: "changeset", content: { summary: "Swapped the cache" }, createdAt: ISO(3) },
      ],
    });
    const s = onlySession("alpha", "s1");
    expect(s.derivationRung).toBe("changeset-summary");
    expect(s.derivationQuality).toBe("medium");
    expect(s.oneLiner).toBe("Swapped the cache");
  });

  it("rung 3 (MEDIUM): with no narrative, the live open decision is the one-liner", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [{ id: "art_dec_1", type: "decision", title: "Cache choice", createdAt: ISO(70) }],
      decisions: [openDecisionRecord()],
    });
    const s = onlySession("alpha", "s1");
    expect(s.derivationRung).toBe("open-decision");
    expect(s.derivationQuality).toBe("medium");
    expect(s.oneLiner).toBe("Redis or in-process cache for the session store?");
  });

  it("rung 4 (THIN): a plan title is graded thin — a title is not a summary", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_r", type: "research", title: "Research: caches", createdAt: ISO(6) },
        { id: "art_p", type: "plan", title: "Plan: cache layer", createdAt: ISO(5) },
      ],
    });
    const s = onlySession("alpha", "s1");
    expect(s.derivationRung).toBe("plan-or-spec-title");
    expect(s.derivationQuality).toBe("thin");
    expect(s.oneLiner).toBe("Plan: cache layer");
  });

  it("rung 5 (THIN): the last resort is the FIRST artifact's title", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_a", type: "research", title: "Where does auth live?", createdAt: ISO(9) },
        { id: "art_b", type: "research", title: "Later note", createdAt: ISO(2) },
      ],
    });
    const s = onlySession("alpha", "s1");
    expect(s.derivationRung).toBe("first-artifact-title");
    expect(s.derivationQuality).toBe("thin");
    expect(s.oneLiner).toBe("Where does auth live?");
  });

  it("an EMPTY debrief summary does not win the rung (empty is worse than absent)", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_db", type: "debrief", title: "db", content: { summary: "   " }, createdAt: ISO(2) },
        { id: "art_p", type: "plan", title: "Plan: cache layer", createdAt: ISO(5) },
      ],
    });
    expect(onlySession("alpha", "s1").derivationRung).toBe("plan-or-spec-title");
  });

  it("truncates long text on a word boundary and never fabricates", () => {
    const long = `${"cache invalidation ".repeat(20)}end`;
    const out = truncateOneLiner(long);
    expect(out.length).toBeLessThanOrEqual(141);
    expect(out.endsWith("…")).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });
});

// --- open loops + supersede ------------------------------------------------

describe("context bank — open decisions", () => {
  it("reports an open decision with its AGE in days and stakes", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [{ id: "art_dec_1", type: "decision", title: "Cache choice", createdAt: ISO(70) }],
      decisions: [openDecisionRecord()],
    });
    const s = onlySession("alpha", "s1");
    expect(s.openDecisionCount).toBe(1);
    expect(s.openDecisions[0]).toMatchObject({ decisionId: "dec_1", ageDays: 70, stakes: "medium" });
    expect(s.salience).toContain("needs-you");
  });

  it("a RESOLVED decision is not open", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [{ id: "art_dec_1", type: "decision", status: "approved", createdAt: ISO(70) }],
      decisions: [openDecisionRecord({ response: { optionId: "o1" }, resolvedAt: ISO(69) })],
    });
    expect(onlySession("alpha", "s1").openDecisionCount).toBe(0);
  });

  it("a decision whose backing artifact went TERMINAL is not open (the close-out end state)", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [{ id: "art_dec_1", type: "decision", status: "obsolete", createdAt: ISO(70) }],
      decisions: [openDecisionRecord()],
    });
    expect(onlySession("alpha", "s1").openDecisionCount).toBe(0);
  });

  it("flags likelySuperseded when a LATER LIVE card names the old id in its prose", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_dec_1", type: "decision", title: "Cache choice", createdAt: ISO(70) },
        {
          id: "art_dec_2",
          type: "decision",
          title: "Cache choice, take 2",
          content: { context: "This REPLACES the earlier card dec_1 — we learned the workload is write-heavy." },
          createdAt: ISO(10),
        },
      ],
      decisions: [openDecisionRecord(), openDecisionRecord({ decisionId: "dec_2", artifactId: "art_dec_2", createdAt: ISO(10) })],
    });
    const s = onlySession("alpha", "s1");
    const old = s.openDecisions.find((d) => d.decisionId === "dec_1")!;
    const recent = s.openDecisions.find((d) => d.decisionId === "dec_2")!;
    expect(old.likelySuperseded).toBe(true);
    expect(old.supersededByArtifactId).toBe("art_dec_2");
    // The newer card is NOT flagged by its own mention of the older one.
    expect(recent.likelySuperseded).toBeUndefined();
  });

  it("flags likelySuperseded via relatedArtifactIds", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_dec_1", type: "decision", createdAt: ISO(70) },
        { id: "art_dec_2", type: "decision", relatedArtifactIds: ["art_dec_1"], createdAt: ISO(10) },
      ],
      decisions: [openDecisionRecord()],
    });
    expect(onlySession("alpha", "s1").openDecisions[0]!.likelySuperseded).toBe(true);
  });

  it("NEVER flags on title similarity alone — explicit id mentions only", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_dec_1", type: "decision", title: "Cache choice", createdAt: ISO(70) },
        { id: "art_dec_2", type: "decision", title: "Cache choice", content: { context: "Same topic, different day." }, createdAt: ISO(10) },
      ],
      decisions: [openDecisionRecord()],
    });
    expect(onlySession("alpha", "s1").openDecisions[0]!.likelySuperseded).toBeUndefined();
  });

  it("does not flag on a PREFIX collision (dec_1 must not match dec_10)", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_dec_1", type: "decision", createdAt: ISO(70) },
        { id: "art_dec_2", type: "decision", content: { context: "supersedes dec_10 and art_dec_1x" }, createdAt: ISO(10) },
      ],
      decisions: [openDecisionRecord()],
    });
    expect(onlySession("alpha", "s1").openDecisions[0]!.likelySuperseded).toBeUndefined();
  });

  it("does not flag from a CLOSED later card (a retracted replacement replaces nothing)", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_dec_1", type: "decision", createdAt: ISO(70) },
        { id: "art_dec_2", type: "decision", status: "retracted", content: { context: "replaces dec_1" }, createdAt: ISO(10) },
      ],
      decisions: [openDecisionRecord()],
    });
    expect(onlySession("alpha", "s1").openDecisions[0]!.likelySuperseded).toBeUndefined();
  });

  it("does not flag from an EARLIER card (only a later card can replace one)", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_dec_1", type: "decision", createdAt: ISO(10) },
        { id: "art_dec_0", type: "decision", content: { context: "see dec_1" }, createdAt: ISO(70) },
      ],
      decisions: [openDecisionRecord({ createdAt: ISO(10) })],
    });
    expect(onlySession("alpha", "s1").openDecisions[0]!.likelySuperseded).toBeUndefined();
  });
});

describe("context bank — the other open loops", () => {
  it("counts draft changesets/code_changes and not closed ones", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_cs1", type: "changeset", status: "draft", createdAt: ISO(3) },
        { id: "art_cc1", type: "code_change", status: "draft", createdAt: ISO(3) },
        { id: "art_cs2", type: "changeset", status: "approved", createdAt: ISO(4) },
      ],
    });
    expect(onlySession("alpha", "s1").draftReviewCount).toBe(2);
  });

  it("counts unanswered QUESTIONS — the lane that only works when intent is set", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [{ id: "art_1", type: "research", title: "Auth walk", createdAt: ISO(3) }],
      comments: [
        { id: "c_q", artifactId: "art_1", author: "human", intent: "question", content: "Why does auth verify before the cache check?", target: { artifactId: "art_1" }, createdAt: ISO(2) },
        { id: "c_plain", artifactId: "art_1", author: "human", content: "nice", target: { artifactId: "art_1" }, createdAt: ISO(2) },
      ],
    });
    const s = onlySession("alpha", "s1");
    expect(s.unansweredQuestionCount).toBe(1);
    // WHOSE TURN: a question the human asked is the AGENT's turn. It must NOT
    // land in the "what needs me" lane — the same rule create-daemon.ts already
    // enforces (unanswered questions are "the INVERSE of pendingCount") and the
    // switcher badge already honors.
    expect(s.salience).toContain("waiting-on-agent");
    expect(s.salience).not.toContain("needs-you");
    expect(s.salience).not.toContain("quiet");
  });

  it("an ANSWERED question stops counting", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [{ id: "art_1", type: "research", createdAt: ISO(3) }],
      comments: [
        { id: "c_q", artifactId: "art_1", author: "human", intent: "question", content: "why?", target: { artifactId: "art_1" }, createdAt: ISO(2) },
        { id: "c_a", artifactId: "art_1", author: "agent", content: "because", parentCommentId: "c_q", target: { artifactId: "art_1" }, createdAt: ISO(1) },
      ],
    });
    expect(onlySession("alpha", "s1").unansweredQuestionCount).toBe(0);
  });
});

// --- salience + filtering --------------------------------------------------

describe("context bank — salience", () => {
  it("no open loops and recent activity → quiet, not needs-you", () => {
    const root = project("alpha");
    writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    const s = onlySession("alpha", "s1");
    expect(s.salience).toContain("quiet");
    expect(s.salience).not.toContain("needs-you");
    expect(s.salience).not.toContain("waiting-on-agent");
    expect(s.salience).not.toContain("stale");
  });

  it("no activity past the threshold → stale", () => {
    const root = project("alpha");
    const dir = writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(90) }] });
    backdate(dir, 90);
    expect(onlySession("alpha", "s1").salience).toContain("stale");
  });

  it("every artifact terminal and nothing open → done", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_1", type: "changeset", status: "approved", createdAt: ISO(2) },
        { id: "art_2", type: "debrief", status: "approved", content: { summary: "Shipped it." }, createdAt: ISO(1) },
      ],
    });
    expect(onlySession("alpha", "s1").salience).toContain("done");
  });

  it("one lingering draft means quiet, NOT done", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_1", type: "research", status: "draft", createdAt: ISO(2) },
        { id: "art_2", type: "debrief", status: "approved", content: { summary: "Shipped it." }, createdAt: ISO(1) },
      ],
    });
    const s = onlySession("alpha", "s1");
    expect(s.salience).not.toContain("done");
    expect(s.salience).toContain("quiet");
  });

  it("lastActivity picks up a file MTIME newer than any artifact timestamp", () => {
    const root = project("alpha");
    const dir = writeSession(root, "s1", {
      artifacts: [{ id: "art_1", type: "research", createdAt: ISO(90) }],
      comments: [{ id: "c1", artifactId: "art_1", author: "human", content: "late note", target: { artifactId: "art_1" }, createdAt: ISO(90) }],
    });
    const recent = new Date(NOW.getTime() - 86_400_000);
    fs.utimesSync(path.join(dir, "comments.json"), recent, recent);
    const s = onlySession("alpha", "s1");
    expect(Date.parse(s.lastActivity)).toBeGreaterThan(Date.parse(ISO(3)));
    expect(s.salience).not.toContain("stale");
  });
});

describe("context bank — whose turn is it (the needs-you / waiting-on-agent split)", () => {
  it("a session with BOTH an open decision and an open question carries BOTH tags", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [
        { id: "art_dec_1", type: "decision", createdAt: ISO(70) },
        { id: "art_1", type: "research", createdAt: ISO(3) },
      ],
      decisions: [openDecisionRecord()],
      comments: [
        { id: "c_q", artifactId: "art_1", author: "human", intent: "question", content: "why?", target: { artifactId: "art_1" }, createdAt: ISO(2) },
      ],
    });
    const s = onlySession("alpha", "s1");
    expect(s.salience).toEqual(expect.arrayContaining(["needs-you", "waiting-on-agent"]));
    expect(s.salience).not.toContain("quiet");
  });

  it("the PROJECT rollup counts the two lanes separately — questions never inflate needsYou", () => {
    const withQuestion = project("questions-only");
    writeSession(withQuestion, "s1", {
      artifacts: [{ id: "art_1", type: "research", createdAt: ISO(3) }],
      comments: [
        { id: "c_q", artifactId: "art_1", author: "human", intent: "question", content: "why?", target: { artifactId: "art_1" }, createdAt: ISO(2) },
      ],
    });
    const withDecision = project("decisions-only");
    writeSession(withDecision, "s1", {
      artifacts: [{ id: "art_dec_1", type: "decision", createdAt: ISO(70) }],
      decisions: [openDecisionRecord()],
    });

    const b = bank();
    const q = b.projects.find((p) => p.name === "questions-only")!;
    const d = b.projects.find((p) => p.name === "decisions-only")!;
    expect(q).toMatchObject({ needsYouCount: 0, waitingOnAgentCount: 1 });
    expect(d).toMatchObject({ needsYouCount: 1, waitingOnAgentCount: 0 });
    expect(b.totals).toMatchObject({ needsYou: 1, waitingOnAgent: 1 });
  });

  it("an unanswered question blocks `done` — the work is not finished, it is owed", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [{ id: "art_1", type: "changeset", status: "approved", createdAt: ISO(2) }],
      comments: [
        { id: "c_q", artifactId: "art_1", author: "human", intent: "question", content: "why?", target: { artifactId: "art_1" }, createdAt: ISO(1) },
      ],
    });
    const s = onlySession("alpha", "s1");
    expect(s.salience).not.toContain("done");
    expect(s.salience).toContain("waiting-on-agent");
  });
});

describe("context bank — filtering and honesty", () => {
  it("SKIPS empty session dirs entirely (the 33-empty-dirs case)", () => {
    const root = project("alpha");
    sessionDir(root, "empty_1");
    sessionDir(root, "empty_2");
    writeSession(root, "real", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    expect(onlyProject("alpha").sessions.map((s) => s.sessionId)).toEqual(["real"]);
  });

  it("skips a session whose artifacts.json is an EMPTY array", () => {
    const root = project("alpha");
    writeSession(root, "s_empty", { artifacts: [] });
    expect(onlyProject("alpha").sessions).toEqual([]);
  });

  it("FLAGS this repo's demo/fixture sessions instead of hiding them", () => {
    const root = project("alpha");
    writeSession(root, "b-demo", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    writeSession(root, "demo_123", { artifacts: [{ id: "art_2", type: "research", createdAt: ISO(1) }] });
    writeSession(root, "real-work", { artifacts: [{ id: "art_3", type: "research", createdAt: ISO(1) }] });
    const byId = Object.fromEntries(onlyProject("alpha").sessions.map((s) => [s.sessionId, s]));
    expect(byId["b-demo"]!.fixtureLike).toBe(true);
    expect(byId["demo_123"]!.fixtureLike).toBe(true);
    expect(byId["real-work"]!.fixtureLike).toBeUndefined();
    // Flagged, never dropped.
    expect(Object.keys(byId)).toHaveLength(3);
  });

  it("does NOT mislabel a user's real session that merely LOOKS test-shaped", () => {
    // A `test_`/`fixture` PREFIX rule flagged this repo's own routes harness
    // session (`test_session`) — and would stamp "demo data" on a real session
    // named `test_flaky_retry`. A false fixture flag is as damaging as hiding
    // the card: the human discounts work that mattered.
    const root = project("alpha");
    for (const id of ["test_session", "test_flaky_retry", "fixture-loader-rewrite", "preview-env-preview"]) {
      writeSession(root, id, { artifacts: [{ id: `art_${id}`, type: "research", createdAt: ISO(1) }] });
    }
    for (const s of onlyProject("alpha").sessions) {
      expect(s.fixtureLike, `${s.sessionId} must not be flagged`).toBeUndefined();
    }
  });

  it("a CORRUPT session degrades to a flagged thin entry and never kills the scan", () => {
    const root = project("alpha");
    writeSession(root, "good", { artifacts: [{ id: "art_1", type: "debrief", content: { summary: "All fine." }, createdAt: ISO(1) }] });
    const badDir = sessionDir(root, "bad");
    fs.writeFileSync(path.join(badDir, "artifacts.json"), "{ not json ]");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const p = onlyProject("alpha");
    const bad = p.sessions.find((s) => s.sessionId === "bad")!;
    expect(bad.degraded).toBe(true);
    expect(bad.derivationQuality).toBe("thin");
    expect(p.sessions.find((s) => s.sessionId === "good")!.oneLiner).toBe("All fine.");
  });

  it("a whole UNREADABLE project degrades to a flagged empty entry, not a failed bank", () => {
    const good = project("good");
    writeSession(good, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    const bad = project("bad");
    // Replace the sessions DIR with a file — readdirSync throws ENOTDIR.
    fs.rmSync(path.join(bad, ".deeppairing", "sessions"), { recursive: true, force: true });
    fs.writeFileSync(path.join(bad, ".deeppairing", "sessions"), "i am not a directory");

    const b = bank();
    expect(b.projects.map((p) => p.name).sort()).toEqual(["bad", "good"]);
    expect(b.projects.find((p) => p.name === "bad")!.degraded).toBe(true);
    expect(b.projects.find((p) => p.name === "good")!.sessions).toHaveLength(1);
  });

  it("a STALE registry entry (root gone) is reported, with no sessions and no crash", () => {
    const root = project("gone");
    writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    fs.rmSync(root, { recursive: true, force: true });

    const b = bank();
    const p = b.projects.find((x) => x.name === "gone")!;
    expect(p.stale).toBe(true);
    expect(p.sessions).toEqual([]);
    expect(b.totals.staleProjects).toBe(1);
  });
});

describe("context bank — cross-project shape", () => {
  it("rolls up totals across projects and sorts by most recent activity", () => {
    const a = project("alpha");
    const aDir = writeSession(a, "s1", {
      artifacts: [{ id: "art_dec_1", type: "decision", title: "Cache", createdAt: ISO(70) }],
      decisions: [openDecisionRecord()],
    });
    // Backdate the files too — lastActivity is max(artifact stamps, mtimes), and
    // a fixture just written to disk is genuinely "active now".
    backdate(aDir, 70);
    const bRoot = project("beta");
    writeSession(bRoot, "s1", { artifacts: [{ id: "art_1", type: "debrief", content: { summary: "Done." }, createdAt: ISO(1) }] });

    const b = bank();
    expect(b.totals).toMatchObject({ projects: 2, sessions: 2, openDecisions: 1, needsYou: 1, waitingOnAgent: 0 });
    expect(b.staleAfterDays).toBe(DEFAULT_STALE_AFTER_DAYS);
    // beta touched a day ago sorts ahead of alpha's 70-day-old card.
    expect(b.projects[0]!.name).toBe("beta");
  });

  it("summarizeProject gives the /api/projects sweep its two enrichment fields", () => {
    const root = project("alpha");
    writeSession(root, "s1", {
      artifacts: [{ id: "art_dec_1", type: "decision", createdAt: ISO(70) }],
      decisions: [openDecisionRecord()],
    });
    const out = summarizeProject(root, { now: NOW });
    expect(out.openDecisionCount).toBe(1);
    expect(out.lastActivity).toBeTruthy();
  });

  it("summarizeProject on a nonexistent root reports zeros rather than throwing", () => {
    expect(summarizeProject(path.join(tmp, "nope"), { now: NOW })).toEqual({
      lastActivity: undefined,
      openDecisionCount: 0,
    });
  });

  it("reads the registry from disk when none is injected", () => {
    const root = project("alpha");
    writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    expect(readProjectRegistry()).toHaveLength(1);
    expect(buildContextBank({ now: NOW }).projects).toHaveLength(1);
  });
});

describe("context bank — scan cache", () => {
  it("serves a cached bank inside the TTL and re-walks after it", () => {
    const root = project("alpha");
    writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", title: "First", createdAt: ISO(1) }] });

    const first = getContextBank({ now: NOW, ttlMs: 20_000 });
    expect(first.totals.sessions).toBe(1);

    // Change the tree; a cached read must NOT see it.
    writeSession(root, "s2", { artifacts: [{ id: "art_2", type: "research", title: "Second", createdAt: ISO(1) }] });
    const cached = getContextBank({ now: new Date(NOW.getTime() + 5_000), ttlMs: 20_000 });
    expect(cached.totals.sessions).toBe(1);
    expect(cached).toBe(first);

    // Past the TTL it re-walks.
    const fresh = getContextBank({ now: new Date(NOW.getTime() + 25_000), ttlMs: 20_000 });
    expect(fresh.totals.sessions).toBe(2);
  });

  it("fresh:true bypasses the TTL (once past the floor)", () => {
    const root = project("alpha");
    writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    getContextBank({ now: NOW, ttlMs: 60_000 });
    writeSession(root, "s2", { artifacts: [{ id: "art_2", type: "research", createdAt: ISO(1) }] });

    const later = new Date(NOW.getTime() + BANK_FRESH_FLOOR_MS + 1);
    // Deep inside the 60s TTL, a plain read is still cached…
    expect(getContextBank({ now: later, ttlMs: 60_000 }).totals.sessions).toBe(1);
    // …and fresh cuts through it.
    expect(getContextBank({ now: later, ttlMs: 60_000, fresh: true }).totals.sessions).toBe(2);
  });

  it("fresh does NOT re-walk inside the floor — a held refresh button can't pin the loop", () => {
    const root = project("alpha");
    writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    getContextBank({ now: NOW, ttlMs: 60_000 });
    writeSession(root, "s2", { artifacts: [{ id: "art_2", type: "research", createdAt: ISO(1) }] });

    // Inside the floor, fresh rides the cached bank (same object identity).
    const inFloor = getContextBank({ now: new Date(NOW.getTime() + BANK_FRESH_FLOOR_MS - 1), ttlMs: 60_000, fresh: true });
    expect(inFloor.totals.sessions).toBe(1);
    // Past the floor it genuinely refreshes, well inside the 60s TTL.
    const past = getContextBank({ now: new Date(NOW.getTime() + BANK_FRESH_FLOOR_MS + 1), ttlMs: 60_000, fresh: true });
    expect(past.totals.sessions).toBe(2);
  });

  it("the cache is KEYED — a different staleAfterDays is not served the prior bank", () => {
    const root = project("alpha");
    const dir = writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(40) }] });
    backdate(dir, 40);

    const lenient = getContextBank({ now: NOW, staleAfterDays: 90, ttlMs: 60_000 });
    expect(lenient.projects[0]!.sessions[0]!.salience).not.toContain("stale");
    // Same instant, same TTL, DIFFERENT question — must not reuse the answer above.
    const strict = getContextBank({ now: NOW, staleAfterDays: 7, ttlMs: 60_000 });
    expect(strict.projects[0]!.sessions[0]!.salience).toContain("stale");
  });

  it("an injected registry neither reads nor poisons the cache", () => {
    const root = project("alpha");
    writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    // Seed the cache from disk…
    expect(getContextBank({ now: NOW, ttlMs: 60_000 }).totals.projects).toBe(1);
    // …an injected-empty-registry call must not be served that bank…
    expect(getContextBank({ now: NOW, ttlMs: 60_000, registry: [] }).totals.projects).toBe(0);
    // …nor overwrite it for the next disk-backed reader.
    expect(getContextBank({ now: NOW, ttlMs: 60_000 }).totals.projects).toBe(1);
  });

  it("clearContextBankCache forces the next read to re-walk", () => {
    const root = project("alpha");
    writeSession(root, "s1", { artifacts: [{ id: "art_1", type: "research", createdAt: ISO(1) }] });
    getContextBank({ now: NOW, ttlMs: 60_000 });
    writeSession(root, "s2", { artifacts: [{ id: "art_2", type: "research", createdAt: ISO(1) }] });
    clearContextBankCache();
    expect(getContextBank({ now: NOW, ttlMs: 60_000 }).totals.sessions).toBe(2);
  });
});
