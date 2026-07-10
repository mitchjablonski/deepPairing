import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemonRoutes, type SessionMeta } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

/**
 * H2-2 (#145) — internal routes that destructured a bare `await c.req.json()`
 * 500'd on a malformed body. They now return a clean 400. Two invariants:
 *   1. malformed body → 400 (never 500).
 *   2. the bearer gate fires BEFORE body parsing AND before the session-exists
 *      probe, so an unauthenticated caller gets an identical 401 for a real and
 *      a ghost session (no existence oracle); a token-bearing caller sees the
 *      real ordering: 400 (real session, bad body) vs 404 (ghost session).
 *
 * Fake, not mock: real FileStores in a Map, a real Hono app driven by
 * app.request().
 */
let tmpDir: string;
let sessions: Map<string, FileStore>;
let sessionMeta: Map<string, SessionMeta>;
let app: ReturnType<typeof createDaemonRoutes>;

const TOKEN = "test-secret-token";

function createSession(sessionId: string): FileStore {
  const store = new FileStore(tmpDir, sessionId);
  sessions.set(sessionId, store);
  return store;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-body-guard-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  sessions = new Map();
  sessionMeta = new Map();
  app = createDaemonRoutes(
    sessions,
    sessionMeta,
    createSession,
    () => {},
    undefined,
    tmpDir,
    TOKEN,
  );
  // Register a real session so requireStore resolves it.
  await app.request("/api/internal/sessions/real/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
});

afterEach(() => {
  setGlobalStoreForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const authed = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } as const;

/** Every previously-unguarded internal route + a representative malformed body. */
const GUARDED_ROUTES: Array<{ name: string; pathFor: (sid: string) => string }> = [
  { name: "session rename", pathFor: (s) => `/api/internal/sessions/${s}/rename` },
  { name: "artifact status", pathFor: (s) => `/api/internal/sessions/${s}/artifacts/a1/status` },
  { name: "plan-progress", pathFor: (s) => `/api/internal/sessions/${s}/artifacts/a1/plan-progress` },
  { name: "artifact rename", pathFor: (s) => `/api/internal/sessions/${s}/artifacts/a1/rename` },
  { name: "comment answered", pathFor: (s) => `/api/internal/sessions/${s}/comments/c1/answered` },
  { name: "decision resolve", pathFor: (s) => `/api/internal/sessions/${s}/decisions/d1/resolve` },
  { name: "plan-review record", pathFor: (s) => `/api/internal/sessions/${s}/plan-reviews` },
  { name: "plan-review resolve", pathFor: (s) => `/api/internal/sessions/${s}/plan-reviews/a1/resolve` },
  { name: "preflight-trace", pathFor: (s) => `/api/internal/sessions/${s}/preflight-traces/a1` },
  { name: "autonomy", pathFor: (s) => `/api/internal/sessions/${s}/autonomy` },
  // #139 — the detail-density setter is enum-validated too.
  { name: "detail-density", pathFor: (s) => `/api/internal/sessions/${s}/detail-density` },
  // H2-2 review — these two used `.catch(() => ({}))`, which only caught a
  // THROWN parse; a valid-JSON `null` then Typeerror'd on destructure → 500.
  { name: "comment mark-resolved", pathFor: (s) => `/api/internal/sessions/${s}/comments/c1/mark-resolved` },
];

describe("H2-2 — malformed body yields 400, never 500", () => {
  for (const route of GUARDED_ROUTES) {
    it(`${route.name}: non-JSON body → 400`, async () => {
      const res = await app.request(route.pathFor("real"), {
        method: "POST",
        headers: authed,
        body: "{ not json",
      });
      expect(res.status).toBe(400);
    });

    it(`${route.name}: null body → 400`, async () => {
      const res = await app.request(route.pathFor("real"), {
        method: "POST",
        headers: authed,
        body: "null",
      });
      expect(res.status).toBe(400);
    });
  }
});

describe("H2-2 review — /register accepts an empty body but rejects non-object bodies", () => {
  // /register is the ONE route that legitimately accepts "" (⇒ {}). But a
  // valid-JSON `null`/scalar used to sneak past `.catch(() => ({}))`: `null`
  // then TypeError'd on `body.expectedProjectRoot` (500); `42` silently 200'd.
  it("empty body → 200 (registers with defaults)", async () => {
    const res = await app.request("/api/internal/sessions/fresh1/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` }, // no Content-Type, no body
    });
    expect(res.status).toBe(200);
  });

  it("valid empty JSON object {} → 200", async () => {
    const res = await app.request("/api/internal/sessions/fresh2/register", { method: "POST", headers: authed, body: "{}" });
    expect(res.status).toBe(200);
  });

  it("literal null body → 400 (was a 500 TypeError on body.expectedProjectRoot)", async () => {
    const res = await app.request("/api/internal/sessions/fresh3/register", { method: "POST", headers: authed, body: "null" });
    expect(res.status).toBe(400);
  });

  it("scalar body 42 → 400 (was a silent 200 with a scalar)", async () => {
    const res = await app.request("/api/internal/sessions/fresh4/register", { method: "POST", headers: authed, body: "42" });
    expect(res.status).toBe(400);
  });

  it("malformed body → 400", async () => {
    const res = await app.request("/api/internal/sessions/fresh5/register", { method: "POST", headers: authed, body: "{ not json" });
    expect(res.status).toBe(400);
  });
});

describe("#139 — preference setters reject a poison enum value (autonomy fails CLOSED)", () => {
  it("autonomy: invalid level 'banana' → 400 and nothing written (dial stays supervised)", async () => {
    const store = sessions.get("real")!;
    expect(store.getAutonomyLevel()).toBe("supervised"); // default before
    const res = await app.request("/api/internal/sessions/real/autonomy", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ level: "banana" }),
    });
    expect(res.status).toBe(400);
    // In-memory unchanged…
    expect(store.getAutonomyLevel()).toBe("supervised");
    // …and nothing persisted: a fresh store over the same dir still reads supervised.
    expect(new FileStore(tmpDir, "real").getAutonomyLevel()).toBe("supervised");
  });

  it("autonomy: a valid level still round-trips (200 + persisted)", async () => {
    const res = await app.request("/api/internal/sessions/real/autonomy", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ level: "balanced" }),
    });
    expect(res.status).toBe(200);
    expect(sessions.get("real")!.getAutonomyLevel()).toBe("balanced");
    expect(new FileStore(tmpDir, "real").getAutonomyLevel()).toBe("balanced");
  });

  it("detail-density: invalid density 'banana' → 400 and nothing written (stays rich)", async () => {
    const store = sessions.get("real")!;
    expect(store.getDetailDensity()).toBe("rich");
    const res = await app.request("/api/internal/sessions/real/detail-density", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ density: "banana" }),
    });
    expect(res.status).toBe(400);
    expect(store.getDetailDensity()).toBe("rich");
    expect(new FileStore(tmpDir, "real").getDetailDensity()).toBe("rich");
  });

  it("detail-density: a valid density still round-trips (200 + persisted)", async () => {
    const res = await app.request("/api/internal/sessions/real/detail-density", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ density: "terse" }),
    });
    expect(res.status).toBe(200);
    expect(sessions.get("real")!.getDetailDensity()).toBe("terse");
    expect(new FileStore(tmpDir, "real").getDetailDensity()).toBe("terse");
  });
});

describe("H2-2 — bearer gate fires before body parse and before the session-exists probe", () => {
  const badBody = { method: "POST" as const, headers: { "Content-Type": "application/json" }, body: "{ not json" };
  const route = (sid: string) => `/api/internal/sessions/${sid}/artifacts/a1/status`;

  it("no token + malformed body → 401 for a REAL session (no parse, no 500)", async () => {
    const res = await app.request(route("real"), badBody);
    expect(res.status).toBe(401);
  });

  it("no token + malformed body → 401 for a GHOST session (identical — no existence oracle)", async () => {
    const res = await app.request(route("ghost"), badBody);
    expect(res.status).toBe(401);
  });

  it("with token: real session + bad body → 400; ghost session + valid body → 404", async () => {
    const realBad = await app.request(route("real"), {
      method: "POST",
      headers: authed,
      body: "{ not json",
    });
    expect(realBad.status).toBe(400);

    const ghostValid = await app.request(route("ghost"), {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ status: "approved" }),
    });
    expect(ghostValid.status).toBe(404);
  });
});
