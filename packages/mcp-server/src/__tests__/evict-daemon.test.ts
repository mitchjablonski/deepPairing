/**
 * AA3 — evictDaemon helper. Used by doctor's project-mismatch
 * remediation to ask a squatting daemon to flush + exit cleanly BEFORE
 * falling back to SIGTERM. These tests pin the wire contract:
 *   - Confirms the pid via /api/daemon-info before sending evict.
 *   - Sends the right confirm header.
 *   - Returns the right discriminator on each branch (evicted /
 *     pid_mismatch / no_daemon / refused).
 *
 * Uses a fake Hono server so we don't have to spin up the real daemon
 * (which would actually exit the test process on success).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import net from "node:net";
import { evictDaemon } from "../daemon/lifecycle.js";

// port 0 — OS-assigned per fakeDaemon (was a hardcoded 24860; hardcoded slots
// raced parallel workers and leftover listeners). fakeDaemon records the
// bound port here for the test body.
let TEST_PORT = 0;
let server: { close?: (cb?: () => void) => void } | null = null;
let confirmHeaderReceived: string | undefined;
let evictHits = 0;

/** A port with (very probably) nothing listening: bind 0, note it, release it. */
async function freeUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function fakeDaemon(opts: {
  pid?: number;
  projectRoot?: string;
  evictBehavior?: "ok" | "refused" | "missing";
}): Promise<typeof server> {
  const app = new Hono();
  app.get("/api/daemon-info", (c) =>
    c.json({
      pid: opts.pid ?? 12345,
      projectRoot: opts.projectRoot ?? "/projects/A",
      startedAt: "2026-05-01T00:00:00.000Z",
    }),
  );
  if (opts.evictBehavior !== "missing") {
    app.post("/api/evict", (c) => {
      confirmHeaderReceived = c.req.header("X-DeepPairing-Confirm-Pid");
      evictHits++;
      if (opts.evictBehavior === "refused") {
        return c.json({ error: "no" }, 403);
      }
      return c.json({ status: "evicting", pid: opts.pid ?? 12345 });
    });
  }
  // The listeningListener resolves with the bound port, so there is no
  // bind race to sleep over anymore.
  let s: typeof server = null;
  TEST_PORT = await new Promise<number>((resolve) => {
    s = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  return s;
}

beforeEach(() => {
  confirmHeaderReceived = undefined;
  evictHits = 0;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      try { server!.close?.(() => resolve()); } catch { resolve(); }
    });
    server = null;
  }
});

describe("evictDaemon (AA3)", () => {
  it("returns 'no_daemon' when nothing is listening", async () => {
    const result = await evictDaemon(await freeUnusedPort(), 999);
    expect(result).toBe("no_daemon");
    expect(evictHits).toBe(0);
  });

  it("returns 'pid_mismatch' when the daemon's pid doesn't match expected", async () => {
    server = await fakeDaemon({ pid: 12345, evictBehavior: "ok" });
    const result = await evictDaemon(TEST_PORT, 99999);
    expect(result).toBe("pid_mismatch");
    // Crucially, evict was NOT called — defends against killing a recycled PID.
    expect(evictHits).toBe(0);
  });

  it("returns 'evicted' when the daemon accepts the evict", async () => {
    server = await fakeDaemon({ pid: 12345, evictBehavior: "ok" });
    const result = await evictDaemon(TEST_PORT, 12345);
    expect(result).toBe("evicted");
    expect(evictHits).toBe(1);
    expect(confirmHeaderReceived).toBe("12345");
  });

  it("returns 'refused' when the daemon rejects the evict (older daemon, missing route)", async () => {
    server = await fakeDaemon({ pid: 12345, evictBehavior: "refused" });
    const result = await evictDaemon(TEST_PORT, 12345);
    expect(result).toBe("refused");
    expect(evictHits).toBe(1);
  });

  it("returns 'refused' when /api/evict 404s (route missing entirely)", async () => {
    server = await fakeDaemon({ pid: 12345, evictBehavior: "missing" });
    const result = await evictDaemon(TEST_PORT, 12345);
    expect(result).toBe("refused");
  });

  it("sends the X-DeepPairing-Confirm-Pid header so the daemon can verify", async () => {
    server = await fakeDaemon({ pid: 12345, evictBehavior: "ok" });
    await evictDaemon(TEST_PORT, 12345);
    expect(confirmHeaderReceived).toBe("12345");
  });
});
