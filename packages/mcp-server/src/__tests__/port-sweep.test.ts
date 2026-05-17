/**
 * N2.1: multi-project port sweep — when daemon.json is missing, adopt only
 * a daemon on the candidate port range whose projectRoot matches ours.
 * Uses ephemeral high-port fake daemons so tests stay hermetic (don't bind
 * 3847 in CI).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDaemonRunning, probeDaemonIdentity } from "../daemon-lifecycle.js";

function fakeDaemon(port: number, projectRoot: string, pid = 99999, startedAt = "2026-04-19T00:00:00.000Z") {
  const app = new Hono();
  app.get("/api/daemon-info", (c) => c.json({ pid, projectRoot, startedAt }));
  app.get("/api/state", (c) => c.json({ ok: true }));
  return serve({ fetch: app.fetch, port });
}

const TEST_RANGE_START = 24847; // arbitrary high port unlikely to collide
const RANGE = { start: TEST_RANGE_START, count: 5 };

describe("port sweep adoption", () => {
  let tmpDir: string;
  let servers: Array<{ close?: (cb?: () => void) => void }> = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-port-sweep-"));
  });

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => {
      try { s.close?.(() => resolve()); } catch { resolve(); }
    })));
    servers = [];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adopts a daemon whose projectRoot matches ours", async () => {
    servers.push(fakeDaemon(TEST_RANGE_START, tmpDir, 12345, "2026-04-19T01:02:03.000Z"));
    await new Promise((r) => setTimeout(r, 50));

    const adopted = await isDaemonRunning(tmpDir, RANGE);
    expect(adopted).not.toBeNull();
    expect(adopted?.port).toBe(TEST_RANGE_START);
    expect(adopted?.pid).toBe(12345);

    // II1 — wrapper-side writeDaemonInfo is gone (it was overwriting the
    // daemon's authToken-bearing file with a salvage record). The real
    // daemon writes daemon.json on startup + heartbeat; the wrapper only
    // reads. Test fakes don't write daemon.json, so adoption returns the
    // in-memory probe record without persisting. This is correct now.
  });

  it("does NOT adopt another project's daemon on the same range", async () => {
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "dp-other-"));
    servers.push(fakeDaemon(TEST_RANGE_START, otherProject));
    await new Promise((r) => setTimeout(r, 50));

    const adopted = await isDaemonRunning(tmpDir, RANGE);
    expect(adopted).toBeNull();
    fs.rmSync(otherProject, { recursive: true, force: true });
  });

  it("finds our daemon at offset 2 even when 0 and 1 belong to other projects", async () => {
    const otherA = fs.mkdtempSync(path.join(os.tmpdir(), "dp-otherA-"));
    const otherB = fs.mkdtempSync(path.join(os.tmpdir(), "dp-otherB-"));
    servers.push(fakeDaemon(TEST_RANGE_START, otherA));
    servers.push(fakeDaemon(TEST_RANGE_START + 1, otherB));
    servers.push(fakeDaemon(TEST_RANGE_START + 2, tmpDir, 77777));
    await new Promise((r) => setTimeout(r, 50));

    const adopted = await isDaemonRunning(tmpDir, RANGE);
    expect(adopted?.port).toBe(TEST_RANGE_START + 2);
    expect(adopted?.pid).toBe(77777);

    fs.rmSync(otherA, { recursive: true, force: true });
    fs.rmSync(otherB, { recursive: true, force: true });
  });

  it("returns null when no daemon responds on the range", async () => {
    const adopted = await isDaemonRunning(tmpDir, RANGE);
    expect(adopted).toBeNull();
  });

  it("probeDaemonIdentity returns null for unreachable ports", async () => {
    const identity = await probeDaemonIdentity(TEST_RANGE_START + 9, 200);
    expect(identity).toBeNull();
  });

  it("probeDaemonIdentity returns the daemon-info payload when reachable", async () => {
    servers.push(fakeDaemon(TEST_RANGE_START, "/some/project", 4242, "2026-01-01T00:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 50));

    const identity = await probeDaemonIdentity(TEST_RANGE_START);
    expect(identity).toEqual({ pid: 4242, projectRoot: "/some/project", startedAt: "2026-01-01T00:00:00.000Z" });
  });
});
