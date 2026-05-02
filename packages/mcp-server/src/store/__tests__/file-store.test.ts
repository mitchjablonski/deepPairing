import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../file-store.js";
import { setGlobalStoreForTests } from "../global-store.js";
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
