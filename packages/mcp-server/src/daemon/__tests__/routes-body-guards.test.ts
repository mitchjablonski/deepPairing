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
