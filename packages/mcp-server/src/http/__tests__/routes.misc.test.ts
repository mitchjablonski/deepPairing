// Split from routes.test.ts (G9): reject-concept capture, /api/prompts,
// /api/search, and /api/hook-state.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import fs from "node:fs";
import path from "node:path";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesApp } from "./routes.harness.js";

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
  describe("reject-concept capture (human-named ledger key)", () => {
    const reject = (id: string, body: Record<string, unknown>) =>
      app.request(`/api/artifacts/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected", ...body }),
      });

    it("keys the ledger on the HUMAN-named concept, over the agent's concept or the title", async () => {
      store.createArtifact({
        id: "art_rej_1",
        type: "research",
        title: "Add a global ConfigStore singleton",
        content: { concept: { name: "agent-named concept" } },
      });
      const res = await reject("art_rej_1", { feedback: "breaks testability", concept: "global mutable state for config" });
      expect(res.status).toBe(200);
      const entry = store.getSessionMemory().rejectedApproaches.find((r) => r.description === "Add a global ConfigStore singleton");
      expect(entry?.concept).toBe("global mutable state for config");
    });

    it("falls back to the agent's concept when the human leaves it blank", async () => {
      store.createArtifact({
        id: "art_rej_2",
        type: "research",
        title: "T2",
        content: { concept: { name: "agent fallback concept" } },
      });
      const res = await reject("art_rej_2", { feedback: "no" }); // no `concept` in body
      expect(res.status).toBe(200);
      const entry = store.getSessionMemory().rejectedApproaches.find((r) => r.description === "T2");
      expect(entry?.concept).toBe("agent fallback concept");
    });
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
});
