// G1 (#198b) — the request composer's HTTP surface: POST /api/requests (create),
// GET /api/requests (list), and GET /api/state including requests.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
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

describe("HTTP Routes — requests (#198b)", () => {
  it("POST /api/requests creates a request", async () => {
    const res = await app.request("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "the auth middleware", intent: "explain" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request.text).toBe("the auth middleware");
    expect(body.request.intent).toBe("explain");
    expect(body.request.id).toMatch(/^req_/);
    expect(body.request.servedByArtifactId).toBeUndefined();
  });

  it("POST /api/requests validates the intent enum + non-empty text", async () => {
    const badIntent = await app.request("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", intent: "wat" }),
    });
    expect(badIntent.status).toBe(400);
    const emptyText = await app.request("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "", intent: "plan" }),
    });
    expect(emptyText.status).toBe(400);
  });

  it("GET /api/requests lists them, and GET /api/state includes requests", async () => {
    store.addRequest({ text: "plan the cache", intent: "plan" });
    const list = await app.request("/api/requests");
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.requests).toHaveLength(1);
    expect(listBody.requests[0].intent).toBe("plan");

    const state = await app.request("/api/state");
    const stateBody = await state.json();
    expect(stateBody.requests).toHaveLength(1);
  });
});

/**
 * P2 (round-11 MED 3) — SCOPE AS DATA. A one-click "Explain this hunk" request
 * used to be byte-indistinguishable from a hand-typed composer request: the
 * scope lived only in the prose, so copy drift silently degraded it into a
 * whole-codebase tour and the agent had nothing to auto-link
 * `relatedArtifactIds` from. `source` + `scope` are OPTIONAL additions — these
 * pin both the round-trip and the back-compat.
 */
describe("HTTP Routes — request source + scope (P2)", () => {
  it("round-trips source + scope through create → list → state", async () => {
    const scope = { artifactId: "art_cs", filePath: "auth/middleware.ts", lineStart: 25, lineEnd: 27 };
    const res = await app.request("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Walk me through the change to auth/middleware.ts at lines 25–27",
        intent: "explain",
        source: "walk_me_through",
        scope,
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()).request;
    expect(created.source).toBe("walk_me_through");
    expect(created.scope).toEqual(scope);

    const listed = (await (await app.request("/api/requests")).json()).requests[0];
    expect(listed.source).toBe("walk_me_through");
    expect(listed.scope).toEqual(scope);

    const stateReq = (await (await app.request("/api/state")).json()).requests[0];
    expect(stateReq.scope).toEqual(scope);
  });

  it("BACK-COMPAT: a request without them is stored with NEITHER key (old shape, byte-for-byte)", async () => {
    const res = await app.request("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "the auth middleware", intent: "explain" }),
    });
    const created = (await res.json()).request;
    expect(created).not.toHaveProperty("source");
    expect(created).not.toHaveProperty("scope");
    expect(Object.keys(created).sort()).toEqual(["createdAt", "id", "intent", "text"]);
  });

  it("validates the new fields at the boundary (bad source / bad line number → 400)", async () => {
    const badSource = await app.request("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", intent: "explain", source: "telepathy" }),
    });
    expect(badSource.status).toBe(400);
    const badScope = await app.request("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", intent: "explain", scope: { lineStart: -4 } }),
    });
    expect(badScope.status).toBe(400);
  });
});
