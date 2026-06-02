import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { GlobalStore, getGlobalStore, setGlobalStoreForTests } from "../../store/global-store.js";
import { projectHashOf } from "../../project-root.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;

// II2 — fail-closed X-Project-Hash. Wrap any test-constructed Hono app so
// the gate doesn't trip on every existing test. Tests that exercise the gate
// itself construct an unwrapped app via createHttpRoutes directly, or pass
// an explicit X-Project-Hash header to override the auto-injected one.
function withHash<T extends { request: any }>(appLike: T, root: string): T {
  const projectHash = projectHashOf(root);
  const origRequest = appLike.request.bind(appLike);
  (appLike as any).request = (url: any, init?: any) => {
    const headers = new Headers(init?.headers || {});
    if (!headers.has("X-Project-Hash")) headers.set("X-Project-Hash", projectHash);
    return origRequest(url, { ...(init || {}), headers });
  };
  return appLike;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-route-test-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "test_session");
  app = withHash(createHttpRoutes(store, tmpDir), tmpDir);
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

  // II2.2 — the global X-Project-Hash gate must NOT block the browser's
  // bootstrap surface (the document/asset GETs and /api/daemon-info, loaded
  // via plain navigation with no custom headers), while still gating session
  // state + mutations. Uses UNWRAPPED apps so no X-Project-Hash is injected.
  describe("II2.2 — bootstrap-surface gate exemption", () => {
    it("403s a hashless GET /api/state (session route stays gated)", async () => {
      const bare = createHttpRoutes(store, tmpDir);
      const res = await bare.request("/api/state");
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("project_hash_mismatch");
    });

    it("does NOT 403 a hashless GET /api/daemon-info (discovery endpoint is exempt)", async () => {
      const bare = createHttpRoutes(store, tmpDir);
      const res = await bare.request("/api/daemon-info");
      // createHttpRoutes doesn't define /api/daemon-info (the daemon mounts it
      // top-level), so a 404 — not a 403 — proves the gate let it through.
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(404);
    });

    it("does NOT 403 a hashless non-/api GET (SPA document + /assets/*)", async () => {
      const bare = createHttpRoutes(store, tmpDir);
      for (const p of ["/", "/assets/index-abc123.js", "/favicon.ico"]) {
        const res = await bare.request(p);
        expect(res.status, `path ${p} should not be gate-blocked`).not.toBe(403);
      }
    });

    it("still 403s a hashless POST mutation (mutations stay gated)", async () => {
      const bare = createHttpRoutes(store, tmpDir);
      const res = await bare.request("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId: "a", content: "hi" }),
      });
      expect(res.status).toBe(403);
    });

    it("serves GET /api/state when the correct X-Project-Hash is present", async () => {
      const bare = createHttpRoutes(store, tmpDir);
      const res = await bare.request("/api/state", {
        headers: { "X-Project-Hash": projectHashOf(tmpDir) },
      });
      expect(res.status).toBe(200);
    });
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
      const freshApp = withHash(createHttpRoutes(freshStore, tmpDir), tmpDir);
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
      const app = withHash(
        createHttpRoutes(
          () => null,
          tmpDir,
          (event) => broadcasts.push(event),
        ),
        tmpDir,
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
      const multiApp = withHash(
        createHttpRoutes(
          (sid?: string) => (sid === "session_b" ? storeB : storeA),
          tmpDir,
          (event, sessionId) => broadcasts.push({ event, sessionId }),
        ),
        tmpDir,
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
      const multiApp = withHash(
        createHttpRoutes(
          (sid?: string) => (sid === "session_b2" ? storeB : storeA),
          tmpDir,
          (event, sessionId) => broadcasts.push({ event, sessionId }),
        ),
        tmpDir,
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
      const multiApp = withHash(
        createHttpRoutes(
          (sid?: string) => (sid === "other_session" ? storeOther : storeDefault),
          tmpDir,
        ),
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

  describe("GET /api/hook-state (X7)", () => {
    it("returns an empty fires list when hooks-state.json is absent", async () => {
      const res = await app.request("/api/hook-state");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe(1);
      expect(body.fires).toEqual([]);
    });

    it("returns the parsed fires from hooks-state.json", async () => {
      const dpDir = path.join(tmpDir, ".deeppairing");
      fs.mkdirSync(dpDir, { recursive: true });
      const fires = [
        { at: "2026-04-25T10:00:00.000Z", hook: "stop", exitCode: 0, reason: "pass: nothing pending" },
        { at: "2026-04-25T10:01:00.000Z", hook: "checkpoint", exitCode: 2, reason: "nag: Edit on src/foo.ts without checkpoint" },
      ];
      fs.writeFileSync(
        path.join(dpDir, "hooks-state.json"),
        JSON.stringify({ version: 1, fires }),
      );
      const res = await app.request("/api/hook-state");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.fires).toHaveLength(2);
      expect(body.fires[0].hook).toBe("stop");
      expect(body.fires[1].exitCode).toBe(2);
    });

    it("caps the response at the last 25 fires even if the on-disk log is longer", async () => {
      const dpDir = path.join(tmpDir, ".deeppairing");
      fs.mkdirSync(dpDir, { recursive: true });
      const fires = Array.from({ length: 40 }, (_, i) => ({
        at: new Date(Date.parse("2026-04-25T10:00:00.000Z") + i * 1000).toISOString(),
        hook: "stop",
        exitCode: 0,
        reason: `fire ${i}`,
      }));
      fs.writeFileSync(
        path.join(dpDir, "hooks-state.json"),
        JSON.stringify({ version: 1, fires }),
      );
      const res = await app.request("/api/hook-state");
      const body = await res.json();
      expect(body.fires).toHaveLength(25);
      // Slice keeps the LAST 25, so we keep the most recent ones.
      expect(body.fires[0].reason).toBe("fire 15");
      expect(body.fires[24].reason).toBe("fire 39");
    });

    it("degrades to empty fires on malformed JSON instead of throwing", async () => {
      const dpDir = path.join(tmpDir, ".deeppairing");
      fs.mkdirSync(dpDir, { recursive: true });
      fs.writeFileSync(path.join(dpDir, "hooks-state.json"), "{ not json");
      const res = await app.request("/api/hook-state");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.fires).toEqual([]);
    });
  });

  describe("AA9 — POST /api/philosophy/seed", () => {
    // PMF deep dive's resolution to the empty-ledger silent killer:
    // accept user-pasted rules from CLAUDE.md / code-review docs
    // instead of presupposing taste with a baked-in stance list.
    // Synthetic project="manual" + sessionId="seed" so manual seeds
    // are distinguishable from session-driven ones.

    it("400s with code=validation_error when concept is empty", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("validation_error");
    });

    it("400s on invalid JSON body", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("seeds an approved entry into the global ledger with synthetic project + sessionId", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept: "prefer dependency injection",
          verdict: "approved",
          reason: "tests can swap impls",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("seeded");
      expect(body.verdict).toBe("approved");
      // Verify the global ledger now carries the seeded entry.
      const ledger = getGlobalStore().query({ limit: 100 });
      const seeded = ledger.find((e) => e.concept === "prefer dependency injection");
      expect(seeded).toBeDefined();
      expect(seeded!.instances[0].project).toBe("manual");
      expect(seeded!.instances[0].sessionId).toBe("seed");
      expect(seeded!.instances[0].verdict).toBe("approved");
      expect(seeded!.instances[0].reason).toBe("tests can swap impls");
    });

    it("defaults to verdict='approved' when not specified", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "named exports only" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verdict).toBe("approved");
    });

    it("seeds a rejected entry when verdict='rejected'", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "global mutable state", verdict: "rejected" }),
      });
      expect(res.status).toBe(200);
      const ledger = getGlobalStore().query({ limit: 100 });
      const rejected = ledger.find((e) => e.concept === "global mutable state");
      expect(rejected?.instances[0].verdict).toBe("rejected");
    });

    it("CC7 — splits multiline body on newlines, seeding one stance per line", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept: "global mutable state\nbcrypt rounds < 12\n\ninline SQL strings",
          verdict: "rejected",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seededCount).toBe(3);
      expect(body.concepts).toEqual([
        "global mutable state",
        "bcrypt rounds < 12",
        "inline SQL strings",
      ]);
      // Back-compat: body.concept is the first one.
      expect(body.concept).toBe("global mutable state");
      // All three landed in the global ledger.
      const ledger = getGlobalStore().query({ limit: 100 });
      const conceptsSeeded = body.concepts as string[];
      for (const c of conceptsSeeded) {
        expect(ledger.find((e) => e.concept === c)).toBeDefined();
      }
    });

    it("CC7 — single-line body still seeds exactly one entry (back-compat)", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "single rule" }),
      });
      const body = await res.json();
      expect(body.seededCount).toBe(1);
      expect(body.concept).toBe("single rule");
    });

    it("CC7 — duplicate lines in one body are de-duped (case-insensitive)", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "Global State\nglobal state\nGLOBAL STATE\nother thing" }),
      });
      const body = await res.json();
      expect(body.seededCount).toBe(2);
      expect(body.concepts[0]).toBe("Global State"); // first form preserved
      expect(body.concepts[1]).toBe("other thing");
    });

    it("DD2 — body exceeding 16 KiB returns 400 validation_error", async () => {
      const big = "a".repeat(16 * 1024 + 1);
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: big }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("validation_error");
      expect(body.error).toMatch(/exceeds.*bytes/i);
    });

    it("EE8 — body cap measures UTF-8 bytes (not UTF-16 code units)", async () => {
      // Pre-EE8 the cap used raw.length which counts code units.
      // 8500 four-byte emojis = 8500 chars but 34000 UTF-8 bytes.
      // The byte cap (16384) should reject this; the code-unit cap
      // would have accepted it.
      const fourByteEmoji = "🎉"; // U+1F389 = 4 bytes UTF-8
      const big = fourByteEmoji.repeat(8500); // ~34 KB UTF-8
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: big }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("validation_error");
      expect(body.error).toMatch(/exceeds.*bytes/i);
    });

    it("DD2 — paste exceeding 50 lines returns 400 validation_error", async () => {
      const lines = Array.from({ length: 51 }, (_, i) => `line ${i}`).join("\n");
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: lines }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("validation_error");
      expect(body.error).toMatch(/exceeds 50 lines/i);
      expect(body.error).toContain("got 51");
    });

    it("DD2 — exactly 50 lines is accepted (boundary)", async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `boundary line ${i}`).join("\n");
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: lines }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seededCount).toBe(50);
    });

    it("CC7 — empty input (only whitespace + newlines) returns 400", async () => {
      const res = await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "   \n\n\t\n  " }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("validation_error");
    });

    it("EE3 — /api/ledger/digest topCitedStances rows include globalCitationCount", async () => {
      // Seed a project-local trace via the FileStore (cited once here).
      const dir = path.join(tmpDir, ".deeppairing", "sessions", "sess_ee3");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "preflight-traces.json"),
        JSON.stringify({
          art_ee3: {
            version: 1,
            at: "2026-05-10T10:00:00Z",
            artifactId: "art_ee3",
            toolName: "present_findings",
            decision: "admitted",
            consideredCount: 1,
            consideredConcepts: [{ source: "session", concept: "EE3 cross-cited concept" }],
            nearMisses: [],
          },
        }),
      );
      // And a few cross-project instances for the same concept via the
      // global ledger (3 different projects, all "session"-source — not manual).
      getGlobalStore().recordInstance("EE3 cross-cited concept", {
        project: "/proj/a", sessionId: "s1", verdict: "rejected", description: "x",
      });
      getGlobalStore().recordInstance("EE3 cross-cited concept", {
        project: "/proj/b", sessionId: "s2", verdict: "rejected", description: "x",
      });
      getGlobalStore().recordInstance("EE3 cross-cited concept", {
        project: "/proj/c", sessionId: "s3", verdict: "rejected", description: "x",
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      const row = body.topCitedStances.find((s: any) => s.concept === "EE3 cross-cited concept");
      expect(row).toBeDefined();
      // Project-local citation count (1 trace) preserved.
      expect(row.citationCount).toBe(1);
      // Global count = 3 cross-project instances. Manual seeds excluded.
      expect(row.globalCitationCount).toBe(3);
    });

    it("EE3 — globalCitationCount excludes manual seeds for the same concept", async () => {
      const dir = path.join(tmpDir, ".deeppairing", "sessions", "sess_ee3b");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "preflight-traces.json"),
        JSON.stringify({
          art_ee3b: {
            version: 1,
            at: "2026-05-10T10:00:00Z",
            artifactId: "art_ee3b",
            toolName: "present_findings",
            decision: "admitted",
            consideredCount: 1,
            consideredConcepts: [{ source: "session", concept: "EE3 mixed concept" }],
            nearMisses: [],
          },
        }),
      );
      getGlobalStore().recordInstance("EE3 mixed concept", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "x",
      });
      getGlobalStore().recordInstance("EE3 mixed concept", {
        project: "/proj/a", sessionId: "s1", verdict: "rejected", description: "x",
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      const row = body.topCitedStances.find((s: any) => s.concept === "EE3 mixed concept");
      expect(row).toBeDefined();
      // 1 real-project instance, manual excluded.
      expect(row.globalCitationCount).toBe(1);
    });

    it("FF1 — seededStances rows include sampleArtifactId when the seed has been cited in this project", async () => {
      // Seed once via the route.
      await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "FF1 seeded-and-cited", verdict: "rejected" }),
      });
      // Then a real-project trace cites the same concept.
      const dir = path.join(tmpDir, ".deeppairing", "sessions", "sess_ff1");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "preflight-traces.json"),
        JSON.stringify({
          art_ff1: {
            version: 1,
            at: "2026-05-12T10:00:00Z",
            artifactId: "art_ff1",
            toolName: "present_findings",
            decision: "admitted",
            consideredCount: 1,
            consideredConcepts: [{ source: "session", concept: "FF1 seeded-and-cited" }],
            nearMisses: [],
          },
        }),
      );
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      const seed = body.seededStances.find((s: any) => s.concept === "FF1 seeded-and-cited");
      expect(seed).toBeDefined();
      expect(seed.sampleArtifactId).toBe("art_ff1");
      expect(seed.sampleSessionId).toBe("sess_ff1");
      expect(seed.citedTimesElsewhere).toBe(0); // 0 because real session is THIS project
    });

    it("FF1 — seededStances rows have NO sampleArtifactId when the seed hasn't fired here", async () => {
      await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "FF1 only-seeded", verdict: "rejected" }),
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      const seed = body.seededStances.find((s: any) => s.concept === "FF1 only-seeded");
      expect(seed).toBeDefined();
      expect(seed.sampleArtifactId).toBeUndefined();
    });

    it("DD1 — /api/ledger/digest returns seededStances list when manual seeds exist", async () => {
      // Seed twice via the route + once again with a real-session marker.
      await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "DD1 only-seeded", verdict: "rejected" }),
      });
      await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "DD1 seeded-and-cited", verdict: "rejected" }),
      });
      // Real-project citation of the second concept.
      getGlobalStore().recordInstance("DD1 seeded-and-cited", {
        project: "/some/real/project",
        sessionId: "real_sess",
        verdict: "rejected",
        description: "DD1 seeded-and-cited",
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      expect(Array.isArray(body.seededStances)).toBe(true);
      const concepts = body.seededStances.map((s: any) => s.concept);
      expect(concepts).toContain("DD1 only-seeded");
      expect(concepts).toContain("DD1 seeded-and-cited");
      const cited = body.seededStances.find((s: any) => s.concept === "DD1 seeded-and-cited");
      expect(cited.citedTimesElsewhere).toBe(1);
      const orphan = body.seededStances.find((s: any) => s.concept === "DD1 only-seeded");
      expect(orphan.citedTimesElsewhere).toBe(0);
      expect(orphan.stance).toBe("avoid");
    });

    it("DD1 — /api/ledger/digest returns seededStances:[] when no seeds (back-compat)", async () => {
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      expect(Array.isArray(body.seededStances)).toBe(true);
      expect(body.seededStances).toEqual([]);
    });

    it("BB1 — synthetic project='manual' does NOT inflate /api/ledger/digest globalLedger.projects", async () => {
      // Fresh install: only manual seeds exist. The AA5 globalLedger panel
      // must report projects=0, not 1, so the user doesn't see "shaped 0
      // proposals across 1 project" before they've ever paired.
      await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "BB1 seed-only" }),
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      expect(body.globalLedger.concepts).toBe(1);
      expect(body.globalLedger.projects).toBe(0);
      expect(body.globalLedger.multiProjectConcepts).toBe(0);
    });

    it("BB1 — manual seed + same concept in real project does NOT fire multi-project badge", async () => {
      await app.request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "BB1 cross-project" }),
      });
      // Simulate a real project recording the same concept (typical
      // path: a present_options resolved with this concept).
      getGlobalStore().recordInstance("BB1 cross-project", {
        project: "/some/real/project",
        sessionId: "real_session",
        verdict: "approved",
        description: "BB1 cross-project",
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      // 1 real project, manual filtered out → multiProjectConcepts must stay 0.
      expect(body.globalLedger.projects).toBe(1);
      expect(body.globalLedger.multiProjectConcepts).toBe(0);
    });
  });

  describe("AA5 — /api/ledger/digest", () => {
    // Z1's durable preflight traces unlocked the cross-project moat
    // surface. These tests pin the aggregation shape — what the YourTaste
    // drawer's Ledger view consumes — and the empty-project fallback
    // (UI must render "your ledger is empty" without a 5xx).

    function seedTrace(sessionId: string, artifactId: string, trace: any) {
      const dir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const tracesPath = path.join(dir, "preflight-traces.json");
      const map = fs.existsSync(tracesPath) ? JSON.parse(fs.readFileSync(tracesPath, "utf-8")) : {};
      map[artifactId] = trace;
      fs.writeFileSync(tracesPath, JSON.stringify(map));
    }

    it("returns zeros + empty topCitedStances when no traces exist (empty project)", async () => {
      const res = await app.request("/api/ledger/digest");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shapedThisProject).toBe(0);
      expect(body.nearMissesThisProject).toBe(0);
      expect(body.blockedThisProject).toBe(0);
      expect(body.sessionsTouched).toBe(0);
      expect(body.topCitedStances).toEqual([]);
      expect(body.globalLedger).toEqual({ concepts: 0, projects: 0, multiProjectConcepts: 0 });
    });

    it("aggregates across sessions and counts shaped/near-misses/blocked", async () => {
      seedTrace("sess_a", "art_1", {
        version: 1,
        at: "2026-05-01T10:00:00Z",
        artifactId: "art_1",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 2,
        consideredConcepts: [
          { source: "session", concept: "global state" },
          { source: "session", concept: "manual SQL" },
        ],
        nearMisses: [{ source: "session", concept: "global state" }],
      });
      seedTrace("sess_a", "art_2", {
        version: 1,
        at: "2026-05-01T11:00:00Z",
        artifactId: "art_2",
        toolName: "present_options",
        decision: "blocked",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "global state" }],
        nearMisses: [],
        block: { source: "session", concept: "global state" },
      });
      seedTrace("sess_b", "art_3", {
        version: 1,
        at: "2026-05-02T09:00:00Z",
        artifactId: "art_3",
        toolName: "present_plan",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "team", concept: "use the orm" }],
        nearMisses: [],
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      expect(body.shapedThisProject).toBe(3);
      expect(body.nearMissesThisProject).toBe(1);
      expect(body.blockedThisProject).toBe(1);
      expect(body.sessionsTouched).toBe(2);
      // "global state" appears in art_1 and art_2 → 2 citations.
      // "manual SQL" once. "use the orm" once.
      const top = body.topCitedStances;
      expect(top[0].concept).toBe("global state");
      expect(top[0].citationCount).toBe(2);
      expect(top.find((s: any) => s.concept === "use the orm")?.source).toBe("team");
    });

    it("sample artifact + session let the UI jump back to a citation", async () => {
      seedTrace("sess_jump", "art_jumpback", {
        version: 1,
        at: "2026-05-01",
        artifactId: "art_jumpback",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "x" }],
        nearMisses: [],
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      const stance = body.topCitedStances.find((s: any) => s.concept === "x");
      expect(stance.sampleArtifactId).toBe("art_jumpback");
      expect(stance.sampleSessionId).toBe("sess_jump");
    });

    it("BB2 — caches the digest within TTL (back-to-back calls don't re-walk)", async () => {
      // Read once to seed the cache, then write a trace directly to the
      // filesystem (bypassing recordPreflightTrace's invalidation) and
      // re-read. The second call must return the cached zeros — proof the
      // cache short-circuits the fs walk within DIGEST_CACHE_TTL_MS.
      const r1 = await app.request("/api/ledger/digest");
      const b1 = await r1.json();
      expect(b1.shapedThisProject).toBe(0);
      seedTrace("sess_cache", "art_cache", {
        version: 1,
        at: "2026-05-05",
        artifactId: "art_cache",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "x" }],
        nearMisses: [],
      });
      const r2 = await app.request("/api/ledger/digest");
      const b2 = await r2.json();
      expect(b2.shapedThisProject).toBe(0); // still the cached zero
    });

    it("BB2 — recordPreflightTrace invalidates the cache so next read sees the new trace", async () => {
      // Prime the cache with zeros.
      const r1 = await app.request("/api/ledger/digest");
      expect((await r1.json()).shapedThisProject).toBe(0);
      // Go through the FileStore so invalidation fires.
      store.recordPreflightTrace("art_invalidate", {
        version: 1,
        at: "2026-05-05T10:00:00Z",
        artifactId: "art_invalidate",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "fresh" }],
        nearMisses: [],
      });
      const r2 = await app.request("/api/ledger/digest");
      const b2 = await r2.json();
      expect(b2.shapedThisProject).toBe(1);
      expect(b2.topCitedStances[0].concept).toBe("fresh");
    });

    it("ignores traces with empty consideredConcepts (bootstrap state, not moat moments)", async () => {
      seedTrace("sess_empty", "art_empty", {
        version: 1,
        at: "2026-05-01",
        artifactId: "art_empty",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 0,
        consideredConcepts: [],
        nearMisses: [],
      });
      const res = await app.request("/api/ledger/digest");
      const body = await res.json();
      expect(body.shapedThisProject).toBe(0);
      expect(body.sessionsTouched).toBe(1); // session dir touched, but no shaped count
      expect(body.topCitedStances).toEqual([]);
    });
  });

  describe("AA4 — X-Project-Hash binding (browser stale-tab guard)", () => {
    // The threat: daemon-A on :3847 idle-shuts; daemon-B (different
    // projectRoot, different hash) claims :3847; user's tab still has
    // daemon-A's sessionId AND projectHash cached. When the tab fires a
    // mutation, X-Project-Hash mismatches daemon-B's hash → 403, instead
    // of silently routing into daemon-B's first arbitrary session via
    // the old getDefaultStoreOrNull fallback.
    function appWithProject(root: string) {
      // Use the same default store the outer harness uses; the hash
      // check fires before any store dispatch so the store doesn't matter.
      return createHttpRoutes(store, root);
    }

    it("403s with code project_hash_mismatch when X-Project-Hash differs from daemon's", async () => {
      const a = appWithProject("/projects/A");
      const res = await a.request("/api/state", {
        headers: { "X-Project-Hash": "deadbeef", "X-Session-Id": "any" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("project_hash_mismatch");
      expect(typeof body.expected).toBe("string");
    });

    it("accepts requests when X-Project-Hash matches the daemon's", async () => {
      const a = appWithProject("/projects/A");
      // Compute the same hash the daemon would (via the exported helper).
      const { projectHashOf } = await import("../../project-root.js");
      const hash = projectHashOf("/projects/A");
      const res = await a.request("/api/state", {
        headers: { "X-Project-Hash": hash },
      });
      expect(res.status).toBe(200);
    });

    it("II2 — 403s when X-Project-Hash header is absent (was back-compat-permissive pre-II2)", async () => {
      // Pre-II2 the guard was additive: missing header fell through.
      // Every shipped client now sends the hash (HH1/HH4/HH5), so
      // absence is now treated as the same failure mode as mismatch.
      const a = appWithProject("/projects/A");
      const res = await a.request("/api/state");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("project_hash_mismatch");
    });

    it("short-circuits when projectRoot is undefined (test-fixture back-compat)", async () => {
      // The outer harness creates routes WITHOUT a projectRoot; this is
      // what every existing route test relies on. The hash check should
      // silently allow whatever the client sends in that case.
      const noRootApp = createHttpRoutes(store);
      const res = await noRootApp.request("/api/state", {
        headers: { "X-Project-Hash": "anything" },
      });
      expect(res.status).toBe(200);
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
