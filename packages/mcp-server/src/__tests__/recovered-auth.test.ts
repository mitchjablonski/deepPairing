/**
 * #468 — the `/recovered` notification must travel the same authenticated,
 * project-bound transport as every other internal call.
 *
 * DaemonClient used to send it with a bare `fetch`: no bearer token, no
 * X-Project-Hash. Every production daemon requires the token on
 * /api/internal/*, so it answered 401 — and because fetch resolves on HTTP
 * errors and the call was fire-and-forget, nobody noticed. Re-registration and
 * the retried call still worked, but `daemon_resumed` never reached the
 * companion, so it never refetched full state. The older daemon-integration
 * coverage ran with no token on either side and could not see it.
 *
 * Every test here runs the REAL daemon routes over HTTP with a token on both
 * sides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { createDaemonRoutes, type SessionMeta } from "../daemon/routes.js";
import { DaemonClient } from "../daemon/client.js";
import { FileStore } from "../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "./global-store-fixture.js";

const TOKEN = "tok-468-secret";
const SID = "s468";

let fx: GlobalStoreFixture;
let sessions: Map<string, FileStore>;
let broadcasts: Array<{ sessionId: string; event: { type: string } }>;
let requests: string[];
let failRecoveredWith: number | null;
let server: { close: () => void } | undefined;
let port: number;

beforeEach(async () => {
  fx = withGlobalStore("dp-468-");
  sessions = new Map();
  broadcasts = [];
  requests = [];
  failRecoveredWith = null;
  const routes = createDaemonRoutes(
    sessions,
    new Map<string, SessionMeta>(),
    (id) => fx.track(new FileStore(fx.dir, id)),
    (sessionId, event) => broadcasts.push({ sessionId, event }),
    undefined,
    fx.dir,
    TOKEN,
  );
  port = await new Promise<number>((resolve) => {
    server = serve({
      fetch: (req: Request) => {
        const url = new URL(req.url);
        requests.push(`${req.method} ${url.pathname}`);
        // Simulate a daemon that refuses the notification, for the
        // non-fatal / non-2xx tests.
        if (failRecoveredWith && url.pathname.endsWith("/recovered")) {
          return new Response(JSON.stringify({ error: "nope", code: "boom" }), { status: failRecoveredWith });
        }
        return routes.fetch(req);
      },
      port: 0,
    }, (info) => resolve(info.port)) as unknown as { close: () => void };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  server?.close();
  fx.dispose();
});

async function registeredClient(): Promise<DaemonClient> {
  const client = new DaemonClient(port, SID, fx.dir, TOKEN);
  await client.register({ title: "t", project: "p", expectedProjectRoot: fx.dir });
  return client;
}

/** The daemon restarted: its session map is empty, the wrapper doesn't know. */
function forgetSession(): void {
  sessions.get(SID)?.dispose();
  sessions.delete(SID);
}

const count = (needle: string) => requests.filter((r) => r.endsWith(needle)).length;

describe("#468 — /recovered over the authenticated transport", () => {
  it("session_not_registered → re-register → retry succeeds → daemon_resumed is broadcast", async () => {
    const client = await registeredClient();
    forgetSession();
    broadcasts.length = 0;
    const warn = vi.spyOn(process.stderr, "write");

    const artifacts = await client.getArtifacts();

    expect(Array.isArray(artifacts)).toBe(true);
    expect(sessions.has(SID)).toBe(true); // re-registered
    expect(broadcasts.filter((b) => b.sessionId === SID && b.event.type === "daemon_resumed")).toHaveLength(1);
    // Announced BEFORE the retried call ran, so the companion refetches a state that includes it.
    const order = requests.slice(-4);
    expect(order).toEqual([
      `GET /api/internal/sessions/${SID}/artifacts`,
      `POST /api/internal/sessions/${SID}/register`,
      `POST /api/internal/sessions/${SID}/recovered`,
      `GET /api/internal/sessions/${SID}/artifacts`,
    ]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("/recovered failed"))).toBe(false);
  });

  it("a refused notification is non-fatal but reported, and never starts another recovery", async () => {
    const client = await registeredClient();
    for (const status of [401, 404, 500]) {
      forgetSession();
      failRecoveredWith = status;
      requests.length = 0;
      const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await expect(client.getArtifacts()).resolves.toBeDefined(); // recovery still completes

      expect(warn.mock.calls.some((c) => String(c[0]).includes(`POST /recovered failed: ${status} boom`))).toBe(true);
      // Bounded: exactly one re-register, one notification, one retry.
      expect(count("/register")).toBe(1);
      expect(count("/recovered")).toBe(1);
      expect(count("/artifacts")).toBe(2);
      warn.mockRestore();
    }
  });

  it("an unknown session's /recovered is 404 session_not_registered with no resumed or activity broadcast", async () => {
    await registeredClient();
    broadcasts.length = 0;
    const res = await fetch(`http://localhost:${port}/api/internal/sessions/ghost/recovered`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("session_not_registered");
    expect(broadcasts.filter((b) => b.sessionId === "ghost")).toEqual([]);
    expect(sessions.has("ghost")).toBe(false);
  });

  it("/recovered without the bearer token is still 401 (the auth gate covers it)", async () => {
    await registeredClient();
    broadcasts.length = 0;
    const res = await fetch(`http://localhost:${port}/api/internal/sessions/${SID}/recovered`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(broadcasts).toEqual([]);
  });
});
