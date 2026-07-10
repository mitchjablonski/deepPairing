// #138 — GET /api/decisions: the project-wide decisions view's read route.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { DecisionOption } from "@deeppairing/shared";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, withHash, type RoutesTestContext } from "./routes.harness.js";

let ctx: RoutesTestContext;

const OPTS: DecisionOption[] = [
  { id: "o1", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "In-proc", description: "d", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
];

beforeEach(() => {
  ctx = createRoutesTestContext();
});

afterEach(() => {
  destroyRoutesTestContext(ctx);
  vi.restoreAllMocks();
});

describe("GET /api/decisions", () => {
  it("returns the empty shape when no decisions exist", async () => {
    const res = await ctx.app.request("/api/decisions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decisions: [], failedSessions: [] });
  });

  it("returns a resolved decision with its chosen option and session", async () => {
    ctx.store.createArtifact({ id: "a1", type: "decision", title: "Which cache?", content: {} });
    ctx.store.recordDecisionRequest({ decisionId: "d1", artifactId: "a1", context: "Which cache?", options: OPTS });
    ctx.store.resolveDecision("d1", "o1", "lowest latency");
    ctx.store.forceFlush();

    const res = await ctx.app.request("/api/decisions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failedSessions).toEqual([]);
    expect(body.decisions).toHaveLength(1);
    const d = body.decisions[0];
    expect(d.decisionId).toBe("d1");
    expect(d.sessionId).toBe("test_session");
    expect(d.resolved).toBe(true);
    expect(d.chosenOptionTitle).toBe("Redis");
    expect(d.reasoning).toBe("lowest latency");
  });

  it("surfaces a corrupt session in failedSessions rather than truncating silently", async () => {
    // A healthy decision in the bound session.
    ctx.store.createArtifact({ id: "a1", type: "decision", title: "Good", content: {} });
    ctx.store.recordDecisionRequest({ decisionId: "d_good", artifactId: "a1", context: "Good", options: OPTS });
    ctx.store.resolveDecision("d_good", "o1");
    ctx.store.forceFlush();

    // A second session whose decisions.json can't be parsed.
    const badDir = path.join(ctx.tmpDir, ".deeppairing", "sessions", "s_bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "decisions.json"), "not json ]");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await ctx.app.request("/api/decisions");
    const body = await res.json();
    expect(body.decisions.map((d: { decisionId: string }) => d.decisionId)).toContain("d_good");
    expect(body.failedSessions).toEqual([{ sessionId: "s_bad", reason: expect.any(String), kind: "unreadable" }]);
  });

  // #151 — the flush-lag hole: GET /api/decisions read decisions.json from
  // disk, so a decision recorded/resolved moments ago (still in the session's
  // in-memory FileStore, pre-debounced-flush) was missing from the view for
  // ~2-3s — the "did my action register?" confusion class. The daemon now
  // passes its live stores; live wins by sessionId over the disk scan.
  describe("live-session merge (#151)", () => {
    /** App wired the way the daemon wires it: with a live-sources getter that
     *  snapshots the registered stores' in-memory state per request. */
    const appWithLive = (stores: Record<string, FileStore>) =>
      withHash(
        createHttpRoutes(ctx.store, ctx.tmpDir, undefined, undefined, undefined, () =>
          Object.entries(stores).map(([sessionId, store]) => {
            const state = store.getFullState();
            return { sessionId, decisions: state.decisions, artifacts: state.artifacts };
          }),
        ),
        ctx.tmpDir,
      );

    it("includes a just-resolved decision BEFORE its debounced flush lands on disk", async () => {
      // Freeze timers so the ~100ms debounced flush provably cannot land
      // between resolve and the request — the exact field-test window.
      vi.useFakeTimers();
      try {
        const app = appWithLive({ test_session: ctx.store });
        ctx.store.createArtifact({ id: "a1", type: "decision", title: "Which cache?", content: {} });
        ctx.store.recordDecisionRequest({ decisionId: "d_fresh", artifactId: "a1", context: "Which cache?", options: OPTS });
        ctx.store.resolveDecision("d_fresh", "o1", "lowest latency");
        // Deliberately NO flush — the on-disk decisions.json does not exist yet.
        expect(fs.existsSync(path.join(ctx.tmpDir, ".deeppairing", "sessions", "test_session", "decisions.json"))).toBe(false);

        const res = await app.request("/api/decisions");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.decisions).toHaveLength(1);
        expect(body.decisions[0].decisionId).toBe("d_fresh");
        expect(body.decisions[0].resolved).toBe(true);
        expect(body.decisions[0].chosenOptionTitle).toBe("Redis");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not duplicate a session present on disk AND live (live wins by sessionId)", async () => {
      const app = appWithLive({ test_session: ctx.store });
      ctx.store.createArtifact({ id: "a1", type: "decision", title: "Which queue?", content: {} });
      ctx.store.recordDecisionRequest({ decisionId: "d_both", artifactId: "a1", context: "Which queue?", options: OPTS });
      ctx.store.forceFlush(); // unresolved state lands on disk…
      ctx.store.resolveDecision("d_both", "o2"); // …then resolved in memory only

      const body = await (await app.request("/api/decisions")).json();
      const rows = body.decisions.filter((d: { decisionId: string }) => d.decisionId === "d_both");
      expect(rows).toHaveLength(1);
      expect(rows[0].resolved).toBe(true); // the live (fresh) row, not the stale disk one
    });

    it("still lists a dead session from disk alongside live ones", async () => {
      const app = appWithLive({ test_session: ctx.store });
      ctx.store.createArtifact({ id: "a1", type: "decision", title: "Live", content: {} });
      ctx.store.recordDecisionRequest({ decisionId: "d_live", artifactId: "a1", context: "Live", options: OPTS });
      // A dead session on disk only (no live store for it).
      const deadDir = path.join(ctx.tmpDir, ".deeppairing", "sessions", "s_dead");
      fs.mkdirSync(deadDir, { recursive: true });
      fs.writeFileSync(path.join(deadDir, "decisions.json"), JSON.stringify([
        { decisionId: "d_dead", artifactId: "ax", context: "Old", options: [], createdAt: "2020-01-01T00:00:00Z" },
      ]));

      const body = await (await app.request("/api/decisions")).json();
      expect(body.decisions.map((d: { decisionId: string }) => d.decisionId).sort()).toEqual(["d_dead", "d_live"]);
    });

    it("degrades to the disk scan when the live-sources getter throws", async () => {
      const app = withHash(
        createHttpRoutes(ctx.store, ctx.tmpDir, undefined, undefined, undefined, () => {
          throw new Error("snapshot boom");
        }),
        ctx.tmpDir,
      );
      ctx.store.createArtifact({ id: "a1", type: "decision", title: "Flushed", content: {} });
      ctx.store.recordDecisionRequest({ decisionId: "d_disk", artifactId: "a1", context: "Flushed", options: OPTS });
      ctx.store.forceFlush();

      const res = await app.request("/api/decisions");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.decisions.map((d: { decisionId: string }) => d.decisionId)).toEqual(["d_disk"]);
    });
  });

  it("degrades to the empty shape (200, not 500) if the project read throws", async () => {
    // Force listAllDecisions to throw — the route must catch and degrade, like
    // the ledger reads, never surface an opaque 500 that blanks the whole view.
    vi.spyOn(FileStore, "listAllDecisions").mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await ctx.app.request("/api/decisions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decisions: [], failedSessions: [] });
  });

  it("is X-Project-Hash gated — no hash → 403 (unwrapped app)", async () => {
    // The harness app auto-injects the hash; construct a raw one to prove the
    // gate fires before the handler (no unauthenticated read of the list).
    const raw = createHttpRoutes(ctx.store, ctx.tmpDir);
    const res = await raw.request("/api/decisions");
    expect(res.status).toBe(403);
  });
});
