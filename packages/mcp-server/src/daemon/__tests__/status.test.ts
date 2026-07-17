/**
 * #163 — shared daemon status resolver. Fakes not mocks: a scratch project dir
 * with a real `.deeppairing/daemon.json`, and an injected `fetchImpl` fake that
 * answers `/api/daemon-info` for a chosen port (no real sockets).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDaemonStatus, findDaemonJson } from "../status.js";
import { preferredPortFor, projectHashOf } from "../../project-root.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-status-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeDaemonJson(root: string, info: Record<string, unknown>): void {
  const dir = path.join(root, ".deeppairing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify(info));
}

/** Fake fetch that answers /api/daemon-info on exactly `alivePort`. */
function fakeFetch(alivePort: number, body: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u === `http://localhost:${alivePort}/api/daemon-info`) {
      return { ok: true, json: async () => body } as Response;
    }
    // Anything else — refuse (simulates nothing listening).
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

/** Fake fetch that refuses every connection (nothing listening anywhere). */
const deadFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

describe("#163 resolveDaemonStatus", () => {
  it("running daemon → reports the real bound port from daemon.json + alive:true", async () => {
    const realRoot = fs.realpathSync(tmp);
    writeDaemonJson(realRoot, { pid: 4242, port: 3901, version: "0.1.11", projectRoot: realRoot });

    const status = await resolveDaemonStatus({
      startDir: realRoot,
      env: {},
      fetchImpl: fakeFetch(3901, { pid: 4242, version: "0.1.11", projectRoot: realRoot }),
    });

    expect(status.port).toBe(3901);
    expect(status.companionUrl).toBe("http://localhost:3901");
    expect(status.alive).toBe(true);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(4242);
    expect(status.version).toBe("0.1.11");
    expect(status.projectRoot).toBe(realRoot);
    expect(status.projectHash).toBe(projectHashOf(realRoot));
  });

  it("walk-up: `!`-run from a SUBDIRECTORY still finds the daemon.json above it", async () => {
    const realRoot = fs.realpathSync(tmp);
    writeDaemonJson(realRoot, { pid: 7, port: 3888, version: "0.1.11", projectRoot: realRoot });
    const subdir = path.join(realRoot, "packages", "deep", "nested");
    fs.mkdirSync(subdir, { recursive: true });

    const status = await resolveDaemonStatus({
      startDir: subdir,
      env: {},
      fetchImpl: fakeFetch(3888, { pid: 7, version: "0.1.11", projectRoot: realRoot }),
    });

    expect(status.port).toBe(3888);
    expect(status.alive).toBe(true);
    expect(status.running).toBe(true);
    expect(status.projectRoot).toBe(realRoot);
  });

  it("no daemon.json → deterministic port + running:false + alive:false", async () => {
    const realRoot = fs.realpathSync(tmp);
    const status = await resolveDaemonStatus({
      startDir: realRoot,
      env: {},
      fetchImpl: deadFetch,
    });

    expect(status.running).toBe(false);
    expect(status.alive).toBe(false);
    expect(status.port).toBe(preferredPortFor(realRoot));
    expect(status.companionUrl).toBe(`http://localhost:${preferredPortFor(realRoot)}`);
    expect(status.projectRoot).toBe(realRoot);
  });

  it("stale daemon.json (port not responding) → running:true, alive:false, port falls back to deterministic", async () => {
    const realRoot = fs.realpathSync(tmp);
    writeDaemonJson(realRoot, { pid: 999, port: 3901, version: "0.1.9", projectRoot: realRoot });

    // No fake answer for 3901 → the probe throws → alive:false.
    const status = await resolveDaemonStatus({
      startDir: realRoot,
      env: {},
      fetchImpl: deadFetch,
    });

    expect(status.running).toBe(true); // daemon.json claims a bound port
    expect(status.alive).toBe(false); // ...but it's not actually responding
    // Not reachable → surface the deterministic "would bind here" port.
    expect(status.port).toBe(preferredPortFor(realRoot));
  });

  it("knownPort (MCP session) is authoritative and always reported", async () => {
    const realRoot = fs.realpathSync(tmp);
    // A daemon.json for a DIFFERENT port exists, but the active session knows 3950.
    writeDaemonJson(realRoot, { pid: 1, port: 3888, projectRoot: realRoot });

    const status = await resolveDaemonStatus({
      startDir: realRoot,
      env: {},
      knownPort: 3950,
      fetchImpl: fakeFetch(3950, { pid: 55, version: "0.1.11", projectRoot: realRoot }),
    });

    expect(status.port).toBe(3950);
    expect(status.companionUrl).toBe("http://localhost:3950");
    expect(status.running).toBe(true);
    expect(status.alive).toBe(true);
    expect(status.pid).toBe(55);
  });

  it("findDaemonJson returns null when no .deeppairing/daemon.json exists on the path", () => {
    const realRoot = fs.realpathSync(tmp);
    expect(findDaemonJson(realRoot)).toBeNull();
  });
});
