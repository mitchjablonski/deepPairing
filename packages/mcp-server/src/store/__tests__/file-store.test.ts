import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../file-store.js";
import { setGlobalStoreForTests, getGlobalStore } from "../global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
const stores: FileStore[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-test-"));
  stores.length = 0;
  // Redirect the global philosophy ledger into tmpDir so test writes don't
  // leak into the real ~/.deeppairing/.
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});

afterEach(() => {
  for (const s of stores) s.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

/** Create a FileStore and track it for cleanup */
function createStore(sessionId: string): FileStore {
  const s = new FileStore(tmpDir, sessionId);
  stores.push(s);
  return s;
}

describe("FileStore", () => {
  it("creates session directory on construction", () => {
    const store = createStore( "test_session");
    const sessionDir = path.join(tmpDir, ".deeppairing", "sessions", "test_session");
    expect(fs.existsSync(sessionDir)).toBe(true);
  });

  it("rejects sessionId with path traversal characters", () => {
    expect(() => createStore( "../../etc")).toThrow("Invalid session ID");
    expect(() => createStore( "foo/bar")).toThrow("Invalid session ID");
    expect(() => createStore( "foo\\bar")).toThrow("Invalid session ID");
  });

  it("round-trips artifacts through flush + reload", () => {
    const store = createStore( "roundtrip");
    store.createArtifact({
      id: "art_1",
      type: "research",
      title: "Test Finding",
      content: { summary: "test" },
    });

    // Force flush to disk
    store.forceFlush();

    // Reload in a new instance
    const store2 = createStore( "roundtrip");
    const artifacts = store2.getArtifacts();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe("art_1");
    expect(artifacts[0].title).toBe("Test Finding");
  });

  it("dedupes a comment with identical content/artifact/author within 5s (U0.1)", () => {
    // Field bug: a single comment got posted ~13 times because the client
    // had no sync send-guard. The server-side window collapses any duplicate
    // within 5s into one record and returns the original comment so the
    // caller's response/broadcast wiring still has a valid reference.
    const store = createStore("dedupe-window");
    const c1 = store.addComment({
      id: "cmt_1",
      artifactId: "art_X",
      content: "duplicate me",
      author: "human",
    });
    const c2 = store.addComment({
      id: "cmt_2_different_id",
      artifactId: "art_X",
      content: "duplicate me",
      author: "human",
    });
    expect(store.getCommentsForArtifact("art_X")).toHaveLength(1);
    // Returned comment is the ORIGINAL — id is cmt_1, not the new id we passed.
    expect(c2.id).toBe(c1.id);
    expect(c2.id).toBe("cmt_1");
  });

  it("does NOT dedupe across different authors / artifacts / parents", () => {
    const store = createStore("dedupe-scope");
    store.addComment({ id: "c1", artifactId: "art_X", content: "hi", author: "human" });
    // Same content, different author → not a duplicate
    store.addComment({ id: "c2", artifactId: "art_X", content: "hi", author: "agent" });
    // Same content, different artifact → not a duplicate
    store.addComment({ id: "c3", artifactId: "art_Y", content: "hi", author: "human" });
    // Same content, different parentCommentId → not a duplicate (it's a reply)
    store.addComment({ id: "c4", artifactId: "art_X", content: "hi", author: "human", parentCommentId: "c1" });
    expect(store.getCommentsForArtifact("art_X")).toHaveLength(3);
    expect(store.getCommentsForArtifact("art_Y")).toHaveLength(1);
  });

  it("F3 — does NOT dedupe same-content comments on DIFFERENT targets of one artifact", () => {
    const store = createStore("dedupe-target");
    // Same content/author/artifact, but anchored to different lines / findings —
    // these are distinct human input and must all survive (pre-F3 they collapsed).
    store.addComment({ id: "c1", artifactId: "art_X", content: "why?", author: "human", target: { lineStart: 10, filePath: "a.ts" } });
    store.addComment({ id: "c2", artifactId: "art_X", content: "why?", author: "human", target: { lineStart: 20, filePath: "a.ts" } });
    store.addComment({ id: "c3", artifactId: "art_X", content: "why?", author: "human", target: { findingIndex: 0 } });
    store.addComment({ id: "c4", artifactId: "art_X", content: "why?", author: "human", target: { findingIndex: 1 } });
    expect(store.getCommentsForArtifact("art_X")).toHaveLength(4);

    // ...but a genuine duplicate on the SAME anchor within the window still collapses.
    const d = store.addComment({ id: "c5", artifactId: "art_X", content: "why?", author: "human", target: { lineStart: 10, filePath: "a.ts" } });
    expect(d.id).toBe("c1");
    expect(store.getCommentsForArtifact("art_X")).toHaveLength(4);
  });

  it("round-trips comments", () => {
    const store = createStore( "comments");
    store.addComment({
      id: "cmt_1",
      artifactId: "art_1",
      content: "Great finding",
      author: "human",
    });

    store.forceFlush();

    const store2 = createStore( "comments");
    const comments = store2.getCommentsForArtifact("art_1");
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe("Great finding");
  });

  it("markCommentHumanResolved sets humanResolvedAt + persists", () => {
    const store = createStore("human-resolved");
    store.addComment({
      id: "q1",
      artifactId: "art_1",
      content: "Why this approach?",
      author: "human",
      intent: "question",
    });

    // Before: no humanResolvedAt.
    expect(store.getComment("q1")?.humanResolvedAt).toBeUndefined();

    const at = "2026-05-31T12:00:00.000Z";
    store.markCommentHumanResolved("q1", at);
    expect(store.getComment("q1")?.humanResolvedAt).toBe(at);
    // The agent's drain queue is untouched — acknowledged stays false.
    expect(store.getComment("q1")?.acknowledged).toBe(false);

    // No-op on an unknown id (must not throw).
    expect(() => store.markCommentHumanResolved("does_not_exist")).not.toThrow();

    // Persists across reload.
    store.forceFlush();
    const store2 = createStore("human-resolved");
    expect(store2.getComment("q1")?.humanResolvedAt).toBe(at);
  });

  it("markCommentHumanResolved defaults resolvedAt to now when omitted", () => {
    const store = createStore("human-resolved-default");
    store.addComment({ id: "q2", artifactId: "art_1", content: "Q?", author: "human", intent: "question" });
    store.markCommentHumanResolved("q2");
    const resolved = store.getComment("q2")?.humanResolvedAt;
    expect(typeof resolved).toBe("string");
    expect(Number.isNaN(Date.parse(resolved as string))).toBe(false);
  });

  it("pending plan-reviews / decisions exclude CLOSED artifacts (F1 orphan guard)", () => {
    const store = createStore("orphan_guard");
    store.createArtifact({ id: "p1", type: "plan", title: "Plan", content: { steps: [], estimatedChanges: 0 } });
    store.recordPlanReview("p1");
    expect(store.getPendingPlanReviews().map((p) => p.artifactId)).toContain("p1");

    store.createArtifact({ id: "d1", type: "decision", title: "Decide", content: { context: "c", options: [] } });
    store.recordDecisionRequest({ decisionId: "dec1", artifactId: "d1", context: "c", options: [] });
    expect(store.getPendingDecisions().map((d) => d.artifactId)).toContain("d1");

    // Closing the artifacts (superseded / terminal) retires their pending records,
    // so check_feedback stops reporting them as WAITING forever.
    store.updateArtifactStatus("p1", "superseded");
    store.updateArtifactStatus("d1", "rejected");
    expect(store.getPendingPlanReviews().map((p) => p.artifactId)).not.toContain("p1");
    expect(store.getPendingDecisions().map((d) => d.artifactId)).not.toContain("d1");
  });

  it("a pending review with no backing artifact stays pending (artifacts are never deleted, only closed)", () => {
    const store = createStore("ghost_review");
    store.recordPlanReview("nonexistent");
    expect(store.getPendingPlanReviews().map((p) => p.artifactId)).toContain("nonexistent");
  });

  it("round-trips decisions", () => {
    const store = createStore( "decisions");
    store.recordDecisionRequest({
      decisionId: "dec_1",
      artifactId: "art_1",
      context: "Which approach?",
      options: [{ id: "a", title: "Option A" }],
    });
    store.resolveDecision("dec_1", "a", "Seems best");

    store.forceFlush();

    const store2 = createStore( "decisions");
    const resp = store2.getDecisionResponse("dec_1");
    expect(resp?.optionId).toBe("a");
    expect(resp?.reasoning).toBe("Seems best");
  });

  it("backs up corrupted JSON files", () => {
    // Create a session with valid data
    const store = createStore( "corrupt");
    store.createArtifact({
      id: "art_1",
      type: "research",
      title: "Test",
      content: {},
    });
    store.forceFlush();

    // Corrupt the artifacts file
    const artFile = path.join(tmpDir, ".deeppairing", "sessions", "corrupt", "artifacts.json");
    fs.writeFileSync(artFile, "{ invalid json !!!");

    // Reload — should not throw, should create .corrupt backup
    const store2 = createStore( "corrupt");
    expect(store2.getArtifacts()).toHaveLength(0); // Falls back to empty
    expect(fs.existsSync(artFile + ".corrupt")).toBe(true);
  });

  it("tracks engagement metrics on status changes", () => {
    const store = createStore( "metrics");
    store.createArtifact({
      id: "art_1",
      type: "research",
      title: "Test",
      content: {},
    });
    store.updateArtifactStatus("art_1", "approved");

    const metrics = store.getEngagementMetrics();
    expect(metrics.approvalRate).toBe(1);
    expect(metrics.avgReviewLatencyMs).toBeGreaterThanOrEqual(0);
  });

  // AA3 — reviewLatencies persist across daemon restarts. Pre-AA3 they
  // were in-memory only; an idle-shutdown silently reset all metrics.
  it("AA3: reviewLatencies persist on flush + rehydrate on reload", () => {
    const sid = "metrics_persist";
    const store = createStore(sid);
    store.createArtifact({ id: "art_aa3", type: "research", title: "x", content: {} });
    // Trigger a review-latency record. updateArtifactStatus calls
    // recordArtifactReviewed under the hood.
    store.updateArtifactStatus("art_aa3", "approved");
    store.forceFlush();

    // metrics.json should exist next to the other session JSONs.
    const metricsPath = path.join(tmpDir, ".deeppairing", "sessions", sid, "metrics.json");
    expect(fs.existsSync(metricsPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(metricsPath, "utf-8"));
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk.length).toBe(1);
    expect(onDisk[0].type).toBe("research");

    // Rehydrate by constructing a fresh FileStore — the new instance must
    // see the same metrics. Pre-AA3 this assertion would fail.
    const reloaded = createStore(sid);
    const metrics = reloaded.getEngagementMetrics();
    expect(metrics.avgReviewLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.reviewsByType.research?.count).toBe(1);
  });

  it("AA3: skips writing metrics.json when reviewLatencies is empty (keep session dir tidy)", () => {
    const sid = "metrics_empty";
    const store = createStore(sid);
    store.createArtifact({ id: "art_x", type: "research", title: "x", content: {} });
    store.forceFlush();
    const metricsPath = path.join(tmpDir, ".deeppairing", "sessions", sid, "metrics.json");
    expect(fs.existsSync(metricsPath)).toBe(false);
  });

  it("stores and retrieves autonomy level", () => {
    const store = createStore( "autonomy");
    store.setAutonomyLevel("balanced");

    const store2 = createStore( "autonomy2");
    expect(store2.getAutonomyLevel()).toBe("balanced");
  });

  it("records and retrieves session memory", () => {
    const store = createStore( "memory");
    store.recordApprovedPattern({ description: "Service pattern" });
    store.recordRejectedApproach({ description: "Inline refactor" });

    const memory = store.getSessionMemory();
    expect(memory.approvedPatterns).toContain("Service pattern");
    expect(memory.rejectedApproaches.map((r) => r.description)).toContain("Inline refactor");
  });

  describe("overrideRejectedApproach (scope-down a false-positive block)", () => {
    const ledgerStance = (concept: string) =>
      getGlobalStore()
        .query({ limit: 100 })
        .find((e) => e.concept.toLowerCase() === concept)?.stance;

    it("retires the local stance AND flips the derived ledger stance off 'avoid'", () => {
      const store = createStore("override");
      store.setGlobalLedgerPublish(true);
      store.recordRejectedApproach({
        description: "Deploy: Railway",
        concept: "pay-per-request hosting",
        reason: "vendor lock-in",
      });
      // Before: blocks locally and derives "avoid" cross-project.
      expect(store.getSessionMemory().rejectedApproaches.map((r) => r.concept)).toContain(
        "pay-per-request hosting",
      );
      expect(ledgerStance("pay-per-request hosting")).toBe("avoid");

      // Override: retire the local entry + record an approved counter-instance.
      const { retired } = store.overrideRejectedApproach({ concept: "pay-per-request hosting" });
      expect(retired).toBe(1);
      // After: gone locally (block clears now) and the derived stance shifted
      // to "mixed" (1 reject + 1 approve) so future projects stop tripping.
      expect(store.getSessionMemory().rejectedApproaches.map((r) => r.concept)).not.toContain(
        "pay-per-request hosting",
      );
      expect(ledgerStance("pay-per-request hosting")).toBe("mixed");
    });

    it("clears the local block even with publish OFF (nothing to counter globally)", () => {
      const store = createStore("override-nopub");
      store.recordRejectedApproach({ description: "Inline refactor" }); // publish off by default
      expect(store.getSessionMemory().rejectedApproaches).toHaveLength(1);
      const { retired } = store.overrideRejectedApproach({ description: "Inline refactor" });
      expect(retired).toBe(1);
      expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
    });

    it("returns retired:0 when nothing matches (no crash)", () => {
      const store = createStore("override-miss");
      expect(store.overrideRejectedApproach({ concept: "never recorded" })).toEqual({ retired: 0 });
    });
  });

  describe("findPastPredictions — concept-token matching (N3.3)", () => {
    function seedPrediction(sessionId: string, title: string, context: string, predicted: string) {
      const store = createStore(sessionId);
      store.createArtifact({ id: `dart_${sessionId}`, type: "decision", title, content: {} });
      store.recordDecisionRequest({
        decisionId: `dec_${sessionId}`,
        artifactId: `dart_${sessionId}`,
        context,
        options: [{ id: "o1", title: "Redis", description: "in-memory" }],
        stakes: "high",
      });
      store.resolveDecision(`dec_${sessionId}`, "o1", "go", { predictedOutcome: predicted, confidence: "high" });
      store.forceFlush();
    }

    it("surfaces a past prediction sharing ≥2 concept tokens, even with a differently-worded query", () => {
      seedPrediction("past", "Choose a cache layer for hot reads", "API latency", "Redis will hold up");
      // Shares exactly two distinctive tokens (cache, layer). The OLD majority
      // rule needed ceil(5/2)=3 of the query's tokens, so this missed; the
      // token-floor rule surfaces it.
      const hits = FileStore.findPastPredictions(tmpDir, "which cache layer should we pick");
      expect(hits).toHaveLength(1);
      expect(hits[0].predictedOutcome).toBe("Redis will hold up");
    });

    it("does NOT surface on a single incidental token overlap (floor is 2)", () => {
      seedPrediction("past2", "Choose a cache layer for hot reads", "API latency", "Redis");
      // Only "choose" overlaps — one shared token isn't a concept match.
      const hits = FileStore.findPastPredictions(tmpDir, "which database should we choose");
      expect(hits).toHaveLength(0);
    });
  });

  describe("project guardrails (J6)", () => {
    it("detects migrations directory", () => {
      fs.mkdirSync(path.join(tmpDir, "migrations"), { recursive: true });
      const store = createStore("guard1");
      const guardrails = store.getProjectGuardrails();
      const migrationsRail = guardrails.find((g) => g.category === "migrations");
      expect(migrationsRail).toBeDefined();
      expect(migrationsRail?.paths).toContain("migrations");
    });

    it("detects .github/workflows", () => {
      fs.mkdirSync(path.join(tmpDir, ".github", "workflows"), { recursive: true });
      const store = createStore("guard2");
      const guardrails = store.getProjectGuardrails();
      expect(guardrails.some((g) => g.category === "workflows")).toBe(true);
    });

    it("detects infrastructure files", () => {
      fs.writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM node");
      const store = createStore("guard3");
      const guardrails = store.getProjectGuardrails();
      expect(guardrails.some((g) => g.category === "infrastructure")).toBe(true);
    });

    it("detects .env files as secrets", () => {
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=foo");
      const store = createStore("guard4");
      const guardrails = store.getProjectGuardrails();
      expect(guardrails.some((g) => g.category === "secrets")).toBe(true);
    });

    it("returns empty for a bare project", () => {
      const store = createStore("guard5");
      expect(store.getProjectGuardrails()).toEqual([]);
    });
  });

  describe("team preferences (N6.2)", () => {
    function writeTeamJson(content: unknown): void {
      fs.mkdirSync(path.join(tmpDir, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".deeppairing", "team.json"),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }

    it("returns empty when team.json is missing", () => {
      const store = createStore("team1");
      expect(store.getTeamPreferences()).toEqual([]);
    });

    it("loads a well-formed team.json on construction", () => {
      writeTeamJson({
        version: 1,
        preferences: [
          { id: "p1", kind: "require", concept: "argon2id for password hashing", rationale: "bcrypt is brute-forceable" },
          { id: "p2", kind: "avoid", concept: "global state", rationale: "breaks testability" },
        ],
      });
      const store = createStore("team2");
      const prefs = store.getTeamPreferences();
      expect(prefs).toHaveLength(2);
      expect(prefs[0].concept).toContain("argon2id");
      expect(prefs[1].kind).toBe("avoid");
    });

    it("returns empty (not throws) on malformed team.json", () => {
      writeTeamJson("{ not valid json");
      const store = createStore("team3");
      expect(store.getTeamPreferences()).toEqual([]);
    });

    it("returns empty (not throws) on schema-invalid team.json", () => {
      writeTeamJson({ version: 999, preferences: [{ nope: true }] });
      const store = createStore("team4");
      expect(store.getTeamPreferences()).toEqual([]);
    });

    it("is cached per-instance — file changes don't affect a live store", () => {
      writeTeamJson({ version: 1, preferences: [{ id: "p1", kind: "prefer", concept: "x", rationale: "y" }] });
      const store = createStore("team5");
      expect(store.getTeamPreferences()).toHaveLength(1);
      writeTeamJson({ version: 1, preferences: [] });
      // Same store — stale cache is intentional, reloaded on next construction.
      expect(store.getTeamPreferences()).toHaveLength(1);
    });

    it("picks up changes for a new store instance (next session)", () => {
      writeTeamJson({ version: 1, preferences: [{ id: "p1", kind: "prefer", concept: "x", rationale: "y" }] });
      const s1 = createStore("team6a");
      expect(s1.getTeamPreferences()).toHaveLength(1);
      writeTeamJson({ version: 1, preferences: [] });
      const s2 = createStore("team6b");
      expect(s2.getTeamPreferences()).toHaveLength(0);
    });
  });

  describe("listSessions", () => {
    it("returns sessions and includes session data", () => {
      const s1 = createStore( "session_1");
      s1.createArtifact({ id: "a1", type: "research", title: "First", content: {} });
      s1.forceFlush();

      const s2 = createStore( "session_2");
      s2.createArtifact({ id: "a2", type: "plan", title: "Second", content: {} });
      s2.forceFlush();

      const sessions = FileStore.listSessions(tmpDir);
      expect(sessions).toHaveLength(2);
      // Both sessions present with correct artifact counts
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("session_1");
      expect(ids).toContain("session_2");
      expect(sessions.every((s) => s.artifactCount === 1)).toBe(true);
    });
  });
});
