// Split from routes.test.ts (G9): the philosophy-ledger + metrics surfaces —
// /api/philosophy (+digest/seed/override), /api/predictions, /api/metrics,
// /api/team-preferences, /api/retrospectives, and /api/ledger/digest (AA5).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { GlobalStore, getGlobalStore } from "../../store/global-store.js";
import fs from "node:fs";
import path from "node:path";
import { createRoutesTestContext, destroyRoutesTestContext, withHash, type RoutesApp } from "./routes.harness.js";

let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
});

afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

describe("HTTP Routes", () => {
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
      const freshApp = withHash(createHttpRoutes(freshStore, tmpDir, () => {}), tmpDir);
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

  describe("POST /api/philosophy/override (scope-down a false-positive block)", () => {
    it("retires a personal stance so it stops blocking, and reports the count", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway", concept: "pay-per-request hosting" });
      const res = await app.request("/api/philosophy/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "session", concept: "pay-per-request hosting" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("overridden");
      expect(body.retired).toBe(1);
      // The stance is gone from the project's pre-flight memory.
      expect(
        store.getSessionMemory().rejectedApproaches.map((r) => r.concept),
      ).not.toContain("pay-per-request hosting");
    });

    it("refuses a team-rule block (400 — that's committed, edit team.json)", async () => {
      const res = await app.request("/api/philosophy/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "team", concept: "whatever" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/team\.json/);
    });

    it("400s when neither description nor concept identifies a stance", async () => {
      const res = await app.request("/api/philosophy/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "session" }),
      });
      expect(res.status).toBe(400);
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
});

describe("POST /api/philosophy/remove — first-class stance removal", () => {
  const ledgerPath = () => path.join(tmpDir, "philosophy.json");

  function seedLedger() {
    const ledger = new GlobalStore(ledgerPath());
    ledger.recordInstance("global mutable state for config", {
      project: "repo-a", sessionId: "s1", verdict: "rejected", reason: "broke testability",
    });
    ledger.recordInstance("keep me", { project: "repo-a", sessionId: "s1", verdict: "approved" });
  }

  it("removes an existing stance, reports the backup, and the drawer read no longer lists it", async () => {
    seedLedger();
    const res = await app.request("/api/philosophy/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concept: "Global Mutable State for Config" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("removed");
    expect(body.concept).toBe("global mutable state for config");
    expect(body.instancesRemoved).toBe(1);
    expect(body.backupPath).toBeTruthy();
    expect(fs.existsSync(body.backupPath)).toBe(true);
    // The pre-removal backup still carries the removed stance (reversible).
    const backup = JSON.parse(fs.readFileSync(body.backupPath, "utf-8"));
    expect(backup.concepts["global mutable state for config"]).toBeTruthy();

    const read = await app.request("/api/philosophy?limit=200");
    const entries = (await read.json()).entries as Array<{ concept: string }>;
    expect(entries.map((e) => e.concept)).toEqual(["keep me"]);
    // Live file still valid JSON.
    expect(() => JSON.parse(fs.readFileSync(ledgerPath(), "utf-8"))).not.toThrow();
  });

  it("404s cleanly on a nonexistent concept with NO write and NO backup", async () => {
    seedLedger();
    const before = fs.readFileSync(ledgerPath());
    const res = await app.request("/api/philosophy/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concept: "never recorded" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("stance_not_found");
    expect(fs.readFileSync(ledgerPath()).equals(before)).toBe(true);
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".removed-"))).toHaveLength(0);
  });

  it("400s with code=validation_error when concept is missing/empty", async () => {
    for (const body of [JSON.stringify({}), JSON.stringify({ concept: "  " }), JSON.stringify({ concept: 42 })]) {
      const res = await app.request("/api/philosophy/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("validation_error");
    }
  });

  it("400s on invalid JSON body", async () => {
    const res = await app.request("/api/philosophy/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("401s without the daemon bearer when one is configured (auth posture identical to siblings)", async () => {
    seedLedger();
    const gated = withHash(createHttpRoutes(store, tmpDir, () => {}, undefined, "tok-remove"), tmpDir);
    const noBearer = await gated.request("/api/philosophy/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concept: "keep me" }),
    });
    expect(noBearer.status).toBe(401);
    expect((await noBearer.json()).code).toBe("daemon_auth_required");
    // Nothing was removed.
    expect(getGlobalStore().get("keep me")).toBeTruthy();

    const withBearer = await gated.request("/api/philosophy/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-remove" },
      body: JSON.stringify({ concept: "keep me" }),
    });
    expect(withBearer.status).toBe(200);
    expect(getGlobalStore().get("keep me")).toBeNull();
  });
});
