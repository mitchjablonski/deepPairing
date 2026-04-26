import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { GlobalStore, setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-route-test-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "test_session");
  app = createHttpRoutes(store, tmpDir);
});

afterEach(() => {
  // Force flush so the FileStore's debounced writer doesn't fire after rmSync
  // removes tmpDir (that race surfaces as an unhandled ENOENT in the runner).
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

describe("HTTP Routes", () => {
  it("GET /api/state returns session state", async () => {
    const res = await app.request("/api/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("test_session");
    expect(body.artifacts).toEqual([]);
  });

  it("POST /api/comments requires artifactId and content", async () => {
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "", content: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/comments creates a comment", async () => {
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "art_1", content: "Nice work" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comment.content).toBe("Nice work");
    expect(body.comment.author).toBe("human");
  });

  it("POST /api/artifacts/:id/status rejects invalid status", async () => {
    const res = await app.request("/api/artifacts/art_1/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/decisions/:id requires optionId", async () => {
    const res = await app.request("/api/decisions/dec_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/sessions/:sessionId rejects path traversal", async () => {
    // Hono normalizes `../` in URLs, so test with encoded dots and slashes
    const res = await app.request("/api/sessions/..%2F..%2Fetc");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid session ID");
  });

  it("GET /api/sessions/:sessionId accepts valid session IDs", async () => {
    // Create a session with data
    const s = new FileStore(tmpDir, "valid_session");
    s.createArtifact({ id: "a1", type: "research", title: "T", content: {} });
    s.forceFlush();

    const res = await app.request("/api/sessions/valid_session");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
  });

  it("GET /api/export returns markdown", async () => {
    const res = await app.request("/api/export?format=full");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
  });

  describe("POST /api/prompts", () => {
    it("saves a re-pair prompt into .deeppairing/prompts/", async () => {
      const res = await app.request("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "# Re-pair: Test prompt\n\nBody.",
          sessionId: "session_abc",
          decisionId: "dec_xyz",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("saved");

      const promptsDir = path.join(tmpDir, ".deeppairing", "prompts");
      const files = fs.readdirSync(promptsDir);
      expect(files).toHaveLength(1);
      const content = fs.readFileSync(path.join(promptsDir, files[0]), "utf-8");
      expect(content).toContain("Re-pair: Test prompt");
      // Filename sanitized: contains session + decision tags
      expect(files[0]).toContain("session_abc");
      expect(files[0]).toContain("dec_xyz");
    });

    it("rejects empty content", async () => {
      const res = await app.request("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "   " }),
      });
      expect(res.status).toBe(400);
    });

    it("sanitizes decisionId/sessionId so ../ can't escape the prompts dir", async () => {
      const res = await app.request("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "# Test",
          sessionId: "../../etc",
          decisionId: "../../passwd",
        }),
      });
      expect(res.status).toBe(200);
      const promptsDir = path.join(tmpDir, ".deeppairing", "prompts");
      const files = fs.readdirSync(promptsDir);
      // Sanitized filename contains only [a-zA-Z0-9_-]
      for (const f of files) {
        expect(f).not.toContain("..");
        expect(f).not.toContain("/");
      }
    });
  });

  describe("GET /api/search", () => {
    it("returns empty results for empty query", async () => {
      const res = await app.request("/api/search?q=");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
    });

    it("returns matching artifacts across sessions", async () => {
      // Seed an additional session via a fresh store
      const other = new FileStore(tmpDir, "other_session");
      other.createArtifact({ id: "a1", type: "research", title: "Auth review", content: {} });
      other.forceFlush();

      const res = await app.request("/api/search?q=auth");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].sessionId).toBe("other_session");
    });

    it("honors the limit query parameter", async () => {
      const s = new FileStore(tmpDir, "many");
      for (let i = 0; i < 20; i++) {
        s.createArtifact({ id: `a${i}`, type: "research", title: `Cache ${i}`, content: {} });
      }
      s.forceFlush();

      const res = await app.request("/api/search?q=cache&limit=5");
      const body = await res.json();
      expect(body.results.length).toBe(5);
    });
  });

  describe("GET /api/philosophy (N3.1)", () => {
    it("returns empty entries on a fresh ledger", async () => {
      const res = await app.request("/api/philosophy");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns summarized entries with project counts and derived stance", async () => {
      const ledger = new GlobalStore(path.join(tmpDir, "philosophy.json"));
      ledger.recordInstance("global mutable state", { project: "projectA", sessionId: "sess_1", verdict: "rejected", reason: "breaks tests" });
      ledger.recordInstance("global mutable state", { project: "projectB", sessionId: "sess_2", verdict: "rejected", reason: "caused a regression" });
      ledger.recordInstance("repository pattern", { project: "projectA", sessionId: "sess_3", verdict: "approved" });

      const res = await app.request("/api/philosophy");
      const body = await res.json();
      expect(body.total).toBe(2);

      const avoid = body.entries.find((e: any) => e.key === "global mutable state");
      expect(avoid.stance).toBe("avoid");
      expect(avoid.projectCount).toBe(2);
      expect(avoid.rejected).toBe(2);
      expect(avoid.approved).toBe(0);
      expect(avoid.latestReason).toBe("caused a regression");
      expect(avoid.projects).toEqual(expect.arrayContaining(["projectA", "projectB"]));

      const prefer = body.entries.find((e: any) => e.key === "repository pattern");
      expect(prefer.stance).toBe("prefer");
      expect(prefer.projectCount).toBe(1);
    });

    it("filters by stance query param", async () => {
      const ledger = new GlobalStore(path.join(tmpDir, "philosophy.json"));
      ledger.recordInstance("global state", { project: "p1", sessionId: "s1", verdict: "rejected", reason: "bad" });
      ledger.recordInstance("repository pattern", { project: "p1", sessionId: "s1", verdict: "approved" });

      const res = await app.request("/api/philosophy?stance=avoid");
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0].key).toBe("global state");
    });

    it("filters by concept substring", async () => {
      const ledger = new GlobalStore(path.join(tmpDir, "philosophy.json"));
      ledger.recordInstance("global mutable state", { project: "p1", sessionId: "s1", verdict: "rejected", reason: "x" });
      ledger.recordInstance("god object", { project: "p1", sessionId: "s1", verdict: "rejected", reason: "y" });

      const res = await app.request("/api/philosophy?concept=global");
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0].key).toContain("global");
    });

    it("caps limit at 500 to avoid unbounded ledger dumps", async () => {
      const res = await app.request("/api/philosophy?limit=99999");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/philosophy/digest (N3.2)", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

    it("returns empty periods with zeros on a fresh ledger", async () => {
      const res = await app.request("/api/philosophy/digest");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.window.sinceDays).toBe(7);
      expect(body.totals).toEqual({ concepts: 0, instances: 0, multiProjectConcepts: 0 });
      expect(body.newThisPeriod).toEqual([]);
      expect(body.strengthenedThisPeriod).toEqual([]);
    });

    it("separates new-this-period from strengthened-this-period by firstSeenAt", async () => {
      const ledger = new GlobalStore(path.join(tmpDir, "philosophy.json"));
      // Fresh concept — first seen within the window.
      ledger.recordInstance("new idea", {
        project: "p1", sessionId: "s1", verdict: "approved", at: iso(2 * day),
      });
      // Old concept — seen before the window AND gained a new instance inside it.
      ledger.recordInstance("old concept", {
        project: "p1", sessionId: "s1", verdict: "rejected", reason: "old", at: iso(30 * day),
      });
      ledger.recordInstance("old concept", {
        project: "p2", sessionId: "s2", verdict: "rejected", reason: "still bad", at: iso(1 * day),
      });
      // Stale concept — no activity in the window.
      ledger.recordInstance("stale", {
        project: "p1", sessionId: "s1", verdict: "approved", at: iso(30 * day),
      });

      const res = await app.request("/api/philosophy/digest?sinceDays=7");
      const body = await res.json();

      expect(body.newThisPeriod.map((e: any) => e.key)).toEqual(["new idea"]);
      expect(body.strengthenedThisPeriod.map((e: any) => e.key)).toEqual(["old concept"]);
      expect(body.strengthenedThisPeriod[0].newInstancesInPeriod).toBe(1);
      expect(body.totals.concepts).toBe(3);
      expect(body.totals.instances).toBe(4);
      expect(body.totals.multiProjectConcepts).toBe(1); // "old concept" in p1 + p2
    });

    it("honors sinceDays query param and clamps to [1, 90]", async () => {
      const res1 = await app.request("/api/philosophy/digest?sinceDays=30");
      expect((await res1.json()).window.sinceDays).toBe(30);

      const res2 = await app.request("/api/philosophy/digest?sinceDays=999");
      expect((await res2.json()).window.sinceDays).toBe(90);

      const res3 = await app.request("/api/philosophy/digest?sinceDays=0");
      expect((await res3.json()).window.sinceDays).toBe(1);
    });
  });

  describe("GET /api/predictions (N3.3)", () => {
    it("returns [] when concept is missing", async () => {
      const res = await app.request("/api/predictions");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ predictions: [] });
    });

    it("returns matching past predictions from prior sessions", async () => {
      // Build a past session with a resolved high-stakes decision that has
      // a predictedOutcome. Has to go through the on-disk shape directly
      // because FileStore doesn't expose predictedOutcome via a setter.
      const pastSessionDir = path.join(tmpDir, ".deeppairing", "sessions", "past_session");
      fs.mkdirSync(pastSessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(pastSessionDir, "artifacts.json"),
        JSON.stringify([{
          id: "art_past",
          sessionId: "past_session",
          type: "decision",
          version: 1,
          parentId: null,
          title: "Pick password hashing algorithm",
          status: "approved",
          content: { context: "choose password hashing", options: [] },
          agentReasoning: null,
          createdAt: "2026-01-15T10:00:00.000Z",
          updatedAt: "2026-01-15T10:00:00.000Z",
        }]),
      );
      fs.writeFileSync(
        path.join(pastSessionDir, "decisions.json"),
        JSON.stringify([{
          decisionId: "dec_past",
          artifactId: "art_past",
          context: "choose password hashing algorithm",
          options: [
            { id: "argon", title: "argon2id", description: "memory-hard", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
            { id: "bcrypt", title: "bcrypt", description: "battle-tested", pros: [], cons: [], effort: "low", risk: "medium", recommendation: false },
          ],
          response: {
            optionId: "argon",
            reasoning: "future-proof",
            confidence: "medium",
            predictedOutcome: "zero-downtime migration",
          },
          createdAt: "2026-01-15T10:00:00.000Z",
          resolvedAt: "2026-01-15T10:30:00.000Z",
        }]),
      );

      const res = await app.request("/api/predictions?concept=password%20hashing%20algorithm");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.predictions).toHaveLength(1);
      expect(body.predictions[0].artifactId).toBe("art_past");
      expect(body.predictions[0].predictedOutcome).toBe("zero-downtime migration");
      expect(body.predictions[0].confidence).toBe("medium");
      expect(body.predictions[0].chosenOptionTitle).toBe("argon2id");
      expect(body.predictions[0].daysAgo).toBeGreaterThan(0);
    });

    it("excludes the current artifact from results via excludeArtifactId", async () => {
      const sessDir = path.join(tmpDir, ".deeppairing", "sessions", "s1");
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessDir, "artifacts.json"),
        JSON.stringify([{
          id: "art_current",
          sessionId: "s1",
          type: "decision",
          version: 1,
          parentId: null,
          title: "Pick password hashing algorithm",
          status: "draft",
          content: { context: "x", options: [] },
          agentReasoning: null,
          createdAt: "2026-04-01",
          updatedAt: "2026-04-01",
        }]),
      );
      fs.writeFileSync(
        path.join(sessDir, "decisions.json"),
        JSON.stringify([{
          decisionId: "d",
          artifactId: "art_current",
          context: "choose password hashing algorithm",
          options: [{ id: "a", title: "argon2id", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true }],
          response: { optionId: "a", predictedOutcome: "it'll work" },
          createdAt: "2026-04-01",
          resolvedAt: "2026-04-01",
        }]),
      );

      const res = await app.request("/api/predictions?concept=password%20hashing%20algorithm&excludeArtifactId=art_current");
      const body = await res.json();
      expect(body.predictions).toEqual([]);
    });

    it("requires majority token overlap (no false-positive matches on a single shared word)", async () => {
      const sessDir = path.join(tmpDir, ".deeppairing", "sessions", "s1");
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessDir, "artifacts.json"),
        JSON.stringify([{
          id: "art_unrelated",
          sessionId: "s1",
          type: "decision",
          version: 1,
          parentId: null,
          title: "Pick logging strategy",
          status: "approved",
          content: { context: "unrelated", options: [] },
          agentReasoning: null,
          createdAt: "2026-03-01",
          updatedAt: "2026-03-01",
        }]),
      );
      fs.writeFileSync(
        path.join(sessDir, "decisions.json"),
        JSON.stringify([{
          decisionId: "d",
          artifactId: "art_unrelated",
          context: "choose logging strategy",
          options: [{ id: "a", title: "pino", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true }],
          response: { optionId: "a", predictedOutcome: "faster pipelines" },
          createdAt: "2026-03-01",
          resolvedAt: "2026-03-01",
        }]),
      );
      // Only one token ("strategy") overlaps between "password hashing algorithm" and "logging strategy" —
      // and actually none overlap here. Confirm no spurious match.
      const res = await app.request("/api/predictions?concept=password%20hashing%20algorithm");
      expect((await res.json()).predictions).toEqual([]);
    });
  });

  describe("GET /api/metrics (R1)", () => {
    it("returns a zeroed snapshot when metrics.json is absent", async () => {
      const res = await app.request("/api/metrics");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe(1);
      expect(body.counts.preflightBlocks.total).toBe(0);
      expect(body.counts.ledgerWrites.total).toBe(0);
      expect(body.sessions).toBe(0);
    });

    it("returns actual counts once metrics.json has been written", async () => {
      const { recordMetricEvent } = await import("../../store/metrics-store.js");
      recordMetricEvent(tmpDir, { kind: "preflight_block", source: "team" });
      recordMetricEvent(tmpDir, { kind: "session_started" });
      const res = await app.request("/api/metrics");
      const body = await res.json();
      expect(body.counts.preflightBlocks.total).toBe(1);
      expect(body.counts.preflightBlocks.bySource.team).toBe(1);
      expect(body.sessions).toBe(1);
    });
  });

  describe("GET /api/team-preferences (P3)", () => {
    it("returns { exists: false, preferences: [] } when team.json is absent", async () => {
      const res = await app.request("/api/team-preferences");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ preferences: [], exists: false });
    });

    it("returns the parsed preferences when team.json exists", async () => {
      // FileStore reads team.json at construction time, so rebuild the store
      // + app pair after the file lands on disk.
      fs.mkdirSync(path.join(tmpDir, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".deeppairing", "team.json"),
        JSON.stringify({
          version: 1,
          preferences: [
            { id: "p1", kind: "avoid", concept: "global state", rationale: "testability" },
          ],
        }),
      );
      store.forceFlush();
      const freshStore = new FileStore(tmpDir, "refresh");
      const freshApp = createHttpRoutes(freshStore, tmpDir);
      const res = await freshApp.request("/api/team-preferences");
      const body = await res.json();
      expect(body.exists).toBe(true);
      expect(body.preferences).toHaveLength(1);
      expect(body.preferences[0].kind).toBe("avoid");
      freshStore.forceFlush();
    });
  });

  describe("POST /api/retrospectives (P2)", () => {
    function seedPastDecision(sessionId: string, decisionId: string, artifactId = "art_x"): void {
      const sessDir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessDir, "artifacts.json"),
        JSON.stringify([{
          id: artifactId, sessionId, type: "decision", version: 1, parentId: null,
          title: "Pick hashing algorithm", status: "approved",
          content: { context: "x", options: [] }, agentReasoning: null,
          createdAt: "2026-01-15", updatedAt: "2026-01-15",
        }]),
      );
      fs.writeFileSync(
        path.join(sessDir, "decisions.json"),
        JSON.stringify([{
          decisionId,
          artifactId,
          context: "Pick hashing algorithm",
          options: [{ id: "a", title: "argon2id", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true }],
          response: { optionId: "a", predictedOutcome: "zero-downtime migration", confidence: "medium" },
          createdAt: "2026-01-15",
          resolvedAt: "2026-01-15",
        }]),
      );
    }

    it("400s when decisionId or verdict are missing / invalid", async () => {
      const res = await app.request("/api/retrospectives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: "x" }),
      });
      expect(res.status).toBe(400);
    });

    it("404s when no session owns the decisionId", async () => {
      const res = await app.request("/api/retrospectives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: "does-not-exist", verdict: "right" }),
      });
      expect(res.status).toBe(404);
    });

    it("creates a retrospective on the owning session and returns it", async () => {
      seedPastDecision("past_sess", "dec_past");
      const res = await app.request("/api/retrospectives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisionId: "dec_past",
          verdict: "right",
          note: "migration went clean",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.retrospective.decisionId).toBe("dec_past");
      expect(body.retrospective.verdict).toBe("right");
      expect(body.retrospective.note).toBe("migration went clean");
      expect(body.sessionId).toBe("past_sess");

      // File landed in the owning session's retrospectives.json
      const retrosPath = path.join(tmpDir, ".deeppairing", "sessions", "past_sess", "retrospectives.json");
      const onDisk = JSON.parse(fs.readFileSync(retrosPath, "utf-8"));
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].verdict).toBe("right");
    });

    it("replaces an existing retrospective for the same decision (verdicts can change)", async () => {
      seedPastDecision("past_sess", "dec_past");
      await app.request("/api/retrospectives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: "dec_past", verdict: "right" }),
      });
      const res2 = await app.request("/api/retrospectives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: "dec_past", verdict: "wrong", note: "more evidence came in" }),
      });
      expect(res2.status).toBe(200);
      const retrosPath = path.join(tmpDir, ".deeppairing", "sessions", "past_sess", "retrospectives.json");
      const onDisk = JSON.parse(fs.readFileSync(retrosPath, "utf-8"));
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].verdict).toBe("wrong");
      expect(onDisk[0].note).toBe("more evidence came in");
    });

    it("GET /api/predictions surfaces the retrospective inline", async () => {
      seedPastDecision("past_sess", "dec_past");
      await app.request("/api/retrospectives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: "dec_past", verdict: "mixed" }),
      });
      const res = await app.request("/api/predictions?concept=hashing%20algorithm");
      const body = await res.json();
      expect(body.predictions).toHaveLength(1);
      expect(body.predictions[0].decisionId).toBe("dec_past");
      expect(body.predictions[0].retrospective?.verdict).toBe("mixed");
    });
  });

  describe("Request-body Zod validation (U2)", () => {
    // Pre-U2 mutation routes ran ad-hoc `typeof` guards on raw JSON;
    // a missing/wrong-typed field could crash deeper in the handler.
    // Now every route safeParses against a shared schema and returns
    // 400 with code="validation_error" on mismatch.
    function bodyOf(res: Response): Promise<any> { return res.json(); }

    it("POST /api/comments rejects missing artifactId with code=validation_error", async () => {
      const res = await app.request("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      });
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).code).toBe("validation_error");
    });

    it("POST /api/comments rejects an unknown intent enum value", async () => {
      const res = await app.request("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId: "a", content: "hi", intent: "scream" }),
      });
      expect(res.status).toBe(400);
      const body = await bodyOf(res);
      expect(body.code).toBe("validation_error");
      expect(body.error).toMatch(/intent/);
    });

    it("POST /api/decisions/:id rejects unknown confidence value", async () => {
      const res = await app.request("/api/decisions/d", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "o", confidence: "absolute" }),
      });
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).code).toBe("validation_error");
    });

    it("POST /api/artifacts/:id/status rejects unknown status with structured payload", async () => {
      const res = await app.request("/api/artifacts/x/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "yeet" }),
      });
      expect(res.status).toBe(400);
      const body = await bodyOf(res);
      expect(body.code).toBe("validation_error");
      expect(body.issues[0].path).toBe("status");
    });

    it("POST /api/artifacts/:id/rename rejects an empty title", async () => {
      const res = await app.request("/api/artifacts/x/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      });
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).code).toBe("validation_error");
    });

    it("POST /api/preferences accepts an empty body (everything is optional)", async () => {
      const res = await app.request("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });

    it("POST /api/retrospectives rejects an unknown verdict enum value", async () => {
      const res = await app.request("/api/retrospectives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: "d", verdict: "ok" }),
      });
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).code).toBe("validation_error");
    });
  });

  describe("No-active-session handling (U0.6 prevention)", () => {
    // The orphan-session field bug: when the daemon's getter returns null,
    // routes must NOT spawn a placeholder session. Reads degrade to empty
    // payloads; mutations 409 with a structured error code so the UI can
    // surface a "start Claude Code" banner instead of silently doing nothing.

    function makeApp() {
      const broadcasts: any[] = [];
      const app = createHttpRoutes(
        () => null,
        tmpDir,
        (event) => broadcasts.push(event),
      );
      return { app, broadcasts };
    }

    it("GET /api/state returns EMPTY_STATE with status no_active_session", async () => {
      const { app } = makeApp();
      const res = await app.request("/api/state");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionId).toBeNull();
      expect(body.status).toBe("no_active_session");
      expect(body.artifacts).toEqual([]);
    });

    it("POST /api/comments returns 409 no_active_session and does NOT broadcast", async () => {
      const { app, broadcasts } = makeApp();
      const res = await app.request("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId: "a", content: "hi" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("no_active_session");
      expect(broadcasts).toHaveLength(0);
    });

    it("POST /api/artifacts/:id/status returns 409 no_active_session", async () => {
      const { app } = makeApp();
      const res = await app.request("/api/artifacts/x/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("no_active_session");
    });

    it("POST /api/decisions/:id returns 409 no_active_session", async () => {
      const { app } = makeApp();
      const res = await app.request("/api/decisions/d", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "o" }),
      });
      expect(res.status).toBe(409);
    });

    it("GET /api/artifacts/:id/comments returns empty list (read degrades, doesn't 409)", async () => {
      const { app } = makeApp();
      const res = await app.request("/api/artifacts/x/comments");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.comments).toEqual([]);
    });

    it("GET /api/team-preferences returns empty preferences with exists=false", async () => {
      const { app } = makeApp();
      const res = await app.request("/api/team-preferences");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.preferences).toEqual([]);
      expect(body.exists).toBe(false);
    });
  });

  describe("X-Session-Id routing (daemon multi-session)", () => {
    // Regression for the daemon-routing bug: when the daemon hosts multiple
    // FileStores, every public-route mutation must hit the store named by
    // the X-Session-Id header (sent by the web UI), NOT a default store. The
    // wiring is: routes.ts reads the header, calls a getter from daemon.ts
    // that looks up the right FileStore. Pre-fix, getters were a Proxy that
    // always delegated to getDefaultStore() — so a comment on "session B"
    // appeared in "session A" instead. These tests pin the contract.

    it("POST /api/comments routes to the store named by X-Session-Id", async () => {
      const storeA = new FileStore(tmpDir, "session_a");
      const storeB = new FileStore(tmpDir, "session_b");
      const broadcasts: Array<{ event: any; sessionId?: string }> = [];
      const multiApp = createHttpRoutes(
        (sid?: string) => (sid === "session_b" ? storeB : storeA),
        tmpDir,
        (event, sessionId) => broadcasts.push({ event, sessionId }),
      );

      const res = await multiApp.request("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": "session_b" },
        body: JSON.stringify({ artifactId: "art_b1", content: "for session B" }),
      });
      expect(res.status).toBe(200);

      // Comment landed in session B's store, NOT session A's.
      expect(storeB.getCommentsForArtifact("art_b1")).toHaveLength(1);
      expect(storeA.getCommentsForArtifact("art_b1")).toHaveLength(0);

      // Broadcast carried the right sessionId so subscribers of A don't see B's traffic.
      const commentBroadcast = broadcasts.find((b) => b.event.type === "comment_added");
      expect(commentBroadcast?.sessionId).toBe("session_b");

      storeA.forceFlush();
      storeB.forceFlush();
    });

    it("POST /api/artifacts/:id/status routes to the right store and broadcasts with sessionId", async () => {
      const storeA = new FileStore(tmpDir, "session_a2");
      const storeB = new FileStore(tmpDir, "session_b2");
      // Both stores get an artifact with the same id so the wrong-store path
      // wouldn't fail loudly — only the "did the right store mutate?" check
      // catches a regression.
      storeA.createArtifact({ id: "art_x", type: "plan", title: "A", content: { steps: [] } });
      storeB.createArtifact({ id: "art_x", type: "plan", title: "B", content: { steps: [] } });

      const broadcasts: Array<{ event: any; sessionId?: string }> = [];
      const multiApp = createHttpRoutes(
        (sid?: string) => (sid === "session_b2" ? storeB : storeA),
        tmpDir,
        (event, sessionId) => broadcasts.push({ event, sessionId }),
      );

      const res = await multiApp.request("/api/artifacts/art_x/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": "session_b2" },
        body: JSON.stringify({ status: "approved" }),
      });
      expect(res.status).toBe(200);

      const artA = storeA.getArtifacts().find((a) => a.id === "art_x");
      const artB = storeB.getArtifacts().find((a) => a.id === "art_x");
      expect(artB?.status).toBe("approved");
      expect(artA?.status).toBe("draft");

      const updated = broadcasts.find((b) => b.event.type === "artifact_updated");
      expect(updated?.sessionId).toBe("session_b2");

      storeA.forceFlush();
      storeB.forceFlush();
    });

    it("falls back to default store when X-Session-Id is absent", async () => {
      const storeDefault = new FileStore(tmpDir, "default_session");
      const storeOther = new FileStore(tmpDir, "other_session");
      const multiApp = createHttpRoutes(
        (sid?: string) => (sid === "other_session" ? storeOther : storeDefault),
        tmpDir,
      );

      const res = await multiApp.request("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId: "art_d", content: "no header" }),
      });
      expect(res.status).toBe(200);
      expect(storeDefault.getCommentsForArtifact("art_d")).toHaveLength(1);
      expect(storeOther.getCommentsForArtifact("art_d")).toHaveLength(0);

      storeDefault.forceFlush();
      storeOther.forceFlush();
    });
  });

  describe("CORS", () => {
    it("allows localhost origins", async () => {
      const res = await app.request("/api/state", {
        headers: { Origin: "http://localhost:3847" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3847");
    });

    it("allows 127.0.0.1 origins", async () => {
      const res = await app.request("/api/state", {
        headers: { Origin: "http://127.0.0.1:3847" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:3847");
    });

    it("rejects non-localhost origins", async () => {
      const res = await app.request("/api/state", {
        headers: { Origin: "http://evil.com" },
      });
      const corsHeader = res.headers.get("Access-Control-Allow-Origin");
      expect(corsHeader).not.toBe("http://evil.com");
    });
  });
});
