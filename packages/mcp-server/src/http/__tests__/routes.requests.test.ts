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
