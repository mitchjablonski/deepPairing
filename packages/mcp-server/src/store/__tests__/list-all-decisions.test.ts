import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DecisionOption } from "@deeppairing/shared";
import { FileStore } from "../file-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-decisions-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const OPTS: DecisionOption[] = [
  { id: "o1", title: "Redis", description: "external cache", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "In-proc", description: "in memory", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
];

/** Seed a session (via the REAL FileStore) with a decision artifact + a decision
 *  record, optionally resolved. Fakes-not-mocks: real store, real filesystem. */
function seedDecision(
  sessionId: string,
  opts: {
    decisionId: string;
    artifactId: string;
    context: string;
    title?: string;
    stakes?: "low" | "medium" | "high";
    resolveWith?: { optionId: string; reasoning?: string };
  },
): FileStore {
  const store = new FileStore(tmpDir, sessionId);
  store.createArtifact({
    id: opts.artifactId,
    type: "decision",
    title: opts.title ?? opts.context,
    content: { decisionId: opts.decisionId, context: opts.context, options: OPTS },
  });
  store.recordDecisionRequest({
    decisionId: opts.decisionId,
    artifactId: opts.artifactId,
    context: opts.context,
    options: OPTS,
    stakes: opts.stakes,
  });
  if (opts.resolveWith) {
    store.resolveDecision(opts.decisionId, opts.resolveWith.optionId, opts.resolveWith.reasoning);
  }
  store.forceFlush();
  return store;
}

describe("FileStore.listAllDecisions", () => {
  it("returns the empty shape when no sessions dir exists", () => {
    const result = FileStore.listAllDecisions(tmpDir);
    expect(result).toEqual({ decisions: [], failedSessions: [] });
  });

  it("flattens decisions across every session, newest-first", () => {
    seedDecision("s1", {
      decisionId: "d1", artifactId: "a1", context: "Which cache?",
      resolveWith: { optionId: "o1", reasoning: "lowest latency" },
    });
    seedDecision("s2", {
      decisionId: "d2", artifactId: "a2", context: "Which queue?",
      resolveWith: { optionId: "o2", reasoning: "already deployed" },
    });

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(failedSessions).toEqual([]);
    expect(decisions).toHaveLength(2);
    // Both sessions represented.
    expect(decisions.map((d) => d.sessionId).sort()).toEqual(["s1", "s2"]);
    // Newest-first: d2 was resolved after d1.
    expect(decisions[0].resolvedAt! >= decisions[1].resolvedAt!).toBe(true);

    const d1 = decisions.find((d) => d.decisionId === "d1")!;
    expect(d1.resolved).toBe(true);
    expect(d1.chosenOptionId).toBe("o1");
    expect(d1.chosenOptionTitle).toBe("Redis");
    expect(d1.reasoning).toBe("lowest latency");
    expect(d1.context).toBe("Which cache?");
    expect(d1.optionCount).toBe(2);
  });

  it("marks an unresolved decision as such (no chosen option)", () => {
    seedDecision("s1", { decisionId: "d1", artifactId: "a1", context: "Pending choice" });
    const { decisions } = FileStore.listAllDecisions(tmpDir);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].resolved).toBe(false);
    expect(decisions[0].chosenOptionId).toBeUndefined();
    expect(decisions[0].chosenOptionTitle).toBeUndefined();
  });

  it("resolves a superseded decision artifact to its live successor's title", () => {
    const store = seedDecision("s1", {
      decisionId: "d1", artifactId: "a1", context: "Which cache?", title: "Cache decision v1",
      resolveWith: { optionId: "o1" },
    });
    // Supersede a1 with a2 (parentId=a1), then mark a1 superseded — the exact
    // chain the web store's resolveToLiveId walks.
    store.createArtifact({
      id: "a2", type: "decision", title: "Cache decision v2",
      content: { decisionId: "d1" }, parentId: "a1", version: 2,
    });
    store.updateArtifactStatus("a1", "superseded", "agent_supersede");
    store.forceFlush();

    const { decisions } = FileStore.listAllDecisions(tmpDir);
    const d1 = decisions.find((d) => d.decisionId === "d1")!;
    // The decision still appears (never vanishes) and points at a sensible title.
    expect(d1).toBeDefined();
    expect(d1.artifactMissing).toBe(false);
    expect(d1.artifactTitle).toBe("Cache decision v2");
    // Nav target stays the record's artifactId; the web selectArtifact resolves
    // it to the live successor.
    expect(d1.artifactId).toBe("a1");
  });

  it("still lists other sessions AND reports the failure when one decisions.json is corrupt", () => {
    // A healthy session.
    seedDecision("s_good", {
      decisionId: "d_good", artifactId: "a_good", context: "Healthy decision",
      resolveWith: { optionId: "o1" },
    });
    // A session whose decisions.json is unparseable garbage.
    const badDir = path.join(tmpDir, ".deeppairing", "sessions", "s_bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "artifacts.json"), JSON.stringify([
      { id: "a_bad", type: "decision", title: "Bad", status: "draft", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" },
    ]));
    const badDecPath = path.join(badDir, "decisions.json");
    fs.writeFileSync(badDecPath, "{ this is not valid json ]");

    // Silence the expected salvage/parse console.error noise.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    // The good session's decision is still present — never silently truncated.
    expect(decisions.map((d) => d.decisionId)).toContain("d_good");
    // The bad session is REPORTED, not dropped in silence.
    expect(failedSessions).toHaveLength(1);
    expect(failedSessions[0].sessionId).toBe("s_bad");
    // A .corrupt backup was written (the salvage pattern).
    expect(fs.existsSync(badDecPath + ".corrupt")).toBe(true);
  });

  it("salvages malformed ELEMENTS inside a parseable array without failing the session", () => {
    seedDecision("s1", {
      decisionId: "d_ok", artifactId: "a1", context: "Good one",
      resolveWith: { optionId: "o1" },
    });
    // Inject a null element alongside the good record — salvageArray drops it.
    const decPath = path.join(tmpDir, ".deeppairing", "sessions", "s1", "decisions.json");
    const arr = JSON.parse(fs.readFileSync(decPath, "utf-8"));
    arr.push(null);
    arr.push({ notADecision: true }); // missing decisionId → dropped
    fs.writeFileSync(decPath, JSON.stringify(arr));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    // A parseable-but-partially-bad file is NOT a whole-session failure.
    expect(failedSessions).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decisionId).toBe("d_ok");
  });

  it("ignores sessions that never recorded a decision", () => {
    // A session with only an artifact, no decisions.json.
    const store = new FileStore(tmpDir, "s_noda");
    store.createArtifact({ id: "a1", type: "research", title: "Audit", content: {} });
    store.forceFlush();

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(decisions).toEqual([]);
    expect(failedSessions).toEqual([]);
  });

  // Fix 1 — salvageArray only guarantees a string decisionId, NOT createdAt. A
  // dateless-but-salvage-passing record used to reach the sort and throw
  // `(undefined ?? undefined).localeCompare(...)`, escaping the per-session
  // try/catch and 500ing the whole view.
  it("does not throw on a dateless (salvage-passing) record, and sorts it last", () => {
    seedDecision("s1", {
      decisionId: "d_dated", artifactId: "a1", context: "Dated",
      resolveWith: { optionId: "o1" },
    });
    // A record with a string decisionId (passes salvage) but NO createdAt/resolvedAt.
    const decPath = path.join(tmpDir, ".deeppairing", "sessions", "s1", "decisions.json");
    const arr = JSON.parse(fs.readFileSync(decPath, "utf-8"));
    arr.push({ decisionId: "d_dateless", artifactId: "a1", context: "Dateless", options: OPTS });
    fs.writeFileSync(decPath, JSON.stringify(arr));
    vi.spyOn(console, "error").mockImplementation(() => {});

    let result: ReturnType<typeof FileStore.listAllDecisions> | undefined;
    expect(() => { result = FileStore.listAllDecisions(tmpDir); }).not.toThrow();
    const ids = result!.decisions.map((d) => d.decisionId);
    // Both survive — the dateless one is never dropped...
    expect(ids).toContain("d_dated");
    expect(ids).toContain("d_dateless");
    // ...but an unknown date is NOT "newest" — it sorts to the bottom.
    expect(ids[ids.length - 1]).toBe("d_dateless");
    expect(result!.failedSessions).toEqual([]);
  });

  // Fix 2 — a valid-JSON-but-not-an-array decisions.json is unusable; it must
  // be REPORTED, not silently dropped (decRecords.length===0 can't tell it from
  // a legitimately empty []).
  it("reports a non-array decisions.json in failedSessions (not silently dropped)", () => {
    seedDecision("s_good", {
      decisionId: "d_good", artifactId: "a1", context: "Good",
      resolveWith: { optionId: "o1" },
    });
    const badDir = path.join(tmpDir, ".deeppairing", "sessions", "s_obj");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "decisions.json"), JSON.stringify({ decisionId: "x" }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(decisions.map((d) => d.decisionId)).toContain("d_good");
    expect(failedSessions.map((f) => f.sessionId)).toContain("s_obj");
  });

  it("reports an all-elements-malformed decisions.json in failedSessions", () => {
    const badDir = path.join(tmpDir, ".deeppairing", "sessions", "s_garbage");
    fs.mkdirSync(badDir, { recursive: true });
    // Valid JSON array, but every element fails salvage (no string decisionId).
    fs.writeFileSync(path.join(badDir, "decisions.json"), JSON.stringify([null, { notADecision: true }]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(failedSessions.map((f) => f.sessionId)).toContain("s_garbage");
  });

  it("stays silent for a legitimately empty decisions array (no false failure)", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "s_empty");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "decisions.json"), "[]");

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(decisions).toEqual([]);
    expect(failedSessions).toEqual([]);
  });
});
