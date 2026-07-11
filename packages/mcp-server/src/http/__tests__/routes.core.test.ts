// Split from routes.test.ts (G9): basic CRUD + comments + status + rename,
// request-body Zod validation, no-active-session handling, X-Session-Id
// routing, and the F6 cross-session mutation guards.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
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
    // F6 — comments now require the bound session to OWN the artifact.
    store.createArtifact({ id: "art_1", type: "research", title: "t", content: {} });
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

  it("POST /api/comments/:id/mark-resolved sets humanResolvedAt + broadcasts, leaving acknowledged untouched", async () => {
    // Capture broadcasts to assert the UI gets a refresh signal.
    const events: any[] = [];
    const local = withHash(
      createHttpRoutes(store, tmpDir, (event) => events.push(event)),
      tmpDir,
    );

    const q = store.addComment({
      id: "q1",
      artifactId: "art_1",
      content: "Why this approach?",
      author: "human",
      intent: "question",
    });
    expect(q.acknowledged).toBe(false);
    expect(q.humanResolvedAt).toBeUndefined();

    const res = await local.request(`/api/comments/${q.id}/mark-resolved`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("resolved");
    expect(typeof body.comment.humanResolvedAt).toBe("string");

    // Persisted on the store.
    expect(store.getComment("q1")?.humanResolvedAt).toBeTruthy();
    // CRITICAL: the agent's drain queue is untouched.
    expect(store.getComment("q1")?.acknowledged).toBe(false);

    // UI refresh signal emitted.
    const updated = events.find((e) => e.type === "comment_updated");
    expect(updated).toBeTruthy();
    expect(updated.comment.id).toBe("q1");
    expect(updated.comment.humanResolvedAt).toBeTruthy();
  });

  it("F6 — mark-resolved for an unknown comment FAILS LOUDLY (was: graceful 200 no-op that resurrected questions on reload)", async () => {
    const events: any[] = [];
    const local = withHash(
      createHttpRoutes(store, tmpDir, (event) => events.push(event)),
      tmpDir,
    );
    const res = await local.request(`/api/comments/nope/mark-resolved`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("comment_not_in_session");
    // No comment_updated broadcast for a comment that doesn't exist.
    expect(events.some((e) => e.type === "comment_updated")).toBe(false);
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

  it("POST /api/decisions/:id flips the decision artifact to approved even with no decision RECORD (matches by content.decisionId)", async () => {
    // Repro: a decision artifact exists but the daemon's decisions map has no
    // record for it (separate-process desync, or seeded out-of-band). Without
    // the fallback the route returned 200 "resolved" yet left the artifact in
    // draft, so it kept showing as "waiting for you".
    store.createArtifact({
      id: "art_dec",
      type: "decision",
      title: "pick a cache layer",
      content: { decisionId: "dec1", context: "which?", options: [] },
    });
    const res = await app.request("/api/decisions/dec1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "o1", reasoning: "go" }),
    });
    expect(res.status).toBe(200);
    const artifacts = await store.getArtifacts();
    expect(artifacts.find((a) => a.id === "art_dec")?.status).toBe("approved");
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
      // F6 — the routed-to session must OWN the artifact now.
      storeB.createArtifact({ id: "art_b1", type: "research", title: "b", content: {} });
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
      // F6 — ownership guard: seed the artifact in the default store.
      storeDefault.createArtifact({ id: "art_d", type: "research", title: "d", content: {} });
      const multiApp = withHash(
        createHttpRoutes(
          (sid?: string) => (sid === "other_session" ? storeOther : storeDefault),
          tmpDir,
          () => {},
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
});
describe("F6 — cross-session mutation guards (the silent-no-op class)", () => {
  // Round-4 review, verified: mutations on artifacts the bound session
  // doesn't own returned 200 while writing nothing (status/resolve/rename)
  // or writing into the WRONG session (comments). Every guard fails loudly;
  // the UI's safeFetch toasts non-2xx and rolls back the optimistic flip.

  it("status write on a foreign artifact → 404 artifact_not_in_session (was: 200 + silent no-op)", async () => {
    const res = await app.request("/api/artifacts/art_foreign/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("artifact_not_in_session");
  });

  it("artifact-targeted comment on a foreign artifact → 404 (was: stored in the WRONG session)", async () => {
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "art_foreign", content: "lost forever", target: { artifactId: "art_foreign" } }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("artifact_not_in_session");
    expect((await store.getUnacknowledgedComments()).some((c) => c.content === "lost forever")).toBe(false);
  });

  it("session-level (__session__) comments keep working without an artifact", async () => {
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "__session__", content: "directive", target: { artifactId: "__session__" } }),
    });
    expect(res.status).toBe(200);
  });

  it("decision resolve for an unknown decision → 404 decision_not_in_session (was: 200 'resolved' with the F2 guard skipped)", async () => {
    const res = await app.request("/api/decisions/dec_foreign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "o1" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("decision_not_in_session");
  });

  it("rename on a foreign artifact → 404", async () => {
    const res = await app.request("/api/artifacts/art_foreign/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "new name" }),
    });
    expect(res.status).toBe(404);
  });

  it("owned artifacts still mutate normally (the guard is scoped, not a lockout)", async () => {
    store.createArtifact({ id: "art_owned", type: "research", title: "mine", content: {} });
    const res = await app.request("/api/artifacts/art_owned/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(200);
    expect((await store.getArtifacts()).find((a) => a.id === "art_owned")?.status).toBe("approved");
  });
});
