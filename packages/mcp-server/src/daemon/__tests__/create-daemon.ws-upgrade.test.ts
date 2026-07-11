/**
 * #157 / GG2 — the WS-upgrade AUTH, exercised through the factory's REAL
 * upgrade handler on a REAL listening socket (port 0). The mutation audit
 * deleted both checks (isAllowedWsOrigin + the fail-closed project-hash
 * gate) from the old daemon/index.ts and the suite stayed green — the only
 * coverage was a source-text pin. These tests connect actual WebSocket
 * clients:
 *
 *   - bad Origin            → 403 rejected (WS ignores CORS; this check is
 *                              the only thing between a hostile loopback
 *                              page and a live artifact stream);
 *   - missing project hash  → 403 rejected (II2 fail-closed);
 *   - wrong project hash    → 403 rejected;
 *   - good client           → accepted, receives the real `connected` frame.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { projectHashOf } from "../../project-root.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

let tmpDir: string;
let daemon: Daemon;
let server: ReturnType<typeof serve>;
let port = 0;
let hash = "";

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ws-upgrade-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  hash = projectHashOf(tmpDir);
  daemon = createDaemon({
    projectRoot: tmpDir,
    authToken: "test-token",
    log: () => {},
    exitProcess: () => {},
    releaseListenSocket: () => {},
    env: {},
  });
  // Port 0 — the factory never listens itself (that's index.ts's job); the
  // test plays the entry's role: bind, then attach the authed upgrade path.
  server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    const s = server as unknown as { address(): AddressInfo | null; once(ev: string, cb: () => void): void };
    if (s.address()) return resolve();
    s.once("listening", () => resolve());
  });
  port = ((server as unknown as { address(): AddressInfo }).address()).port;
  daemon.attachUpgradeHandler(server as unknown as Parameters<Daemon["attachUpgradeHandler"]>[0]);
});

afterAll(() => {
  daemon.dispose();
  try { server.close(); } catch { /* already closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

type Attempt =
  | { outcome: "open"; firstMessage: unknown }
  | { outcome: "rejected"; status: number | null };

/** Connect a real ws client; resolve with how the daemon treated the upgrade. */
function attempt(pathAndQuery: string, headers?: Record<string, string>): Promise<Attempt> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`, { headers });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* already dead */ }
      resolve({ outcome: "rejected", status: null });
    }, 5000);
    ws.on("message", (data) => {
      clearTimeout(timer);
      let parsed: unknown = null;
      try { parsed = JSON.parse(String(data)); } catch { /* leave null */ }
      resolve({ outcome: "open", firstMessage: parsed });
      ws.close();
    });
    // A rejected upgrade is a plain HTTP response (our handler writes
    // "HTTP/1.1 403 Forbidden") — ws surfaces it as 'unexpected-response'.
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      resolve({ outcome: "rejected", status: res.statusCode ?? null });
      try { ws.terminate(); } catch { /* already dead */ }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve({ outcome: "rejected", status: null });
    });
  });
}

describe("GG2/II2 — WS upgrade auth through the real handler", () => {
  it("accepts a well-formed client and sends the real `connected` frame", async () => {
    const result = await attempt(`/ws?projectHash=${hash}`);
    expect(result.outcome).toBe("open");
    const msg = (result as Extract<Attempt, { outcome: "open" }>).firstMessage as {
      type?: string;
      projectHash?: string;
      daemonStartedAt?: string;
    };
    expect(msg.type).toBe("connected");
    expect(msg.projectHash).toBe(hash); // AA4 — echoed for X-Project-Hash
    expect(typeof msg.daemonStartedAt).toBe("string"); // U4 — restart detection
  });

  it("rejects a disallowed Origin with 403 even when the hash is correct", async () => {
    const result = await attempt(`/ws?projectHash=${hash}`, { Origin: "http://evil.example" });
    expect(result.outcome).toBe("rejected");
    expect((result as Extract<Attempt, { outcome: "rejected" }>).status).toBe(403);
  });

  it("rejects a cross-loopback-port Origin (the D5 hostile-local-page vector)", async () => {
    // Same loopback host, DIFFERENT port than the daemon — the old
    // any-loopback policy admitted exactly this page.
    const result = await attempt(`/ws?projectHash=${hash}`, {
      Origin: `http://127.0.0.1:${port + 1}`,
    });
    expect(result.outcome).toBe("rejected");
    expect((result as Extract<Attempt, { outcome: "rejected" }>).status).toBe(403);
  });

  it("rejects a client with NO project hash — fail-closed (II2)", async () => {
    const result = await attempt("/ws");
    expect(result.outcome).toBe("rejected");
    expect((result as Extract<Attempt, { outcome: "rejected" }>).status).toBe(403);
  });

  it("rejects a client with the WRONG project hash", async () => {
    const result = await attempt("/ws?projectHash=deadbeefdeadbeef");
    expect(result.outcome).toBe("rejected");
    expect((result as Extract<Attempt, { outcome: "rejected" }>).status).toBe(403);
  });
});
