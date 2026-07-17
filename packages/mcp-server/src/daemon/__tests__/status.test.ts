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

  // #186 review Fix 1 — hostile-input matrix for daemon.json. A daemon.json a
  // user (or a crashed daemon) left in ANY shape must never crash the resolver:
  // `deeppairing status` exiting 1 kills `$(deeppairing port)` scripting and
  // errors the MCP tool. Every hostile shape degrades to the deterministic
  // fallback with a type-clean result.
  describe("hostile daemon.json shapes never throw", () => {
    const HOSTILE_CONTENTS: Array<{ label: string; content: string }> = [
      { label: "projectRoot is a number", content: JSON.stringify({ projectRoot: 42, port: 3901 }) },
      { label: "projectRoot is null", content: JSON.stringify({ projectRoot: null, port: 3901 }) },
      { label: "projectRoot is an object", content: JSON.stringify({ projectRoot: { nested: true }, port: 3901 }) },
      { label: "whole file is a bare number", content: "42" },
      { label: "whole file is JSON null", content: "null" },
      { label: "whole file is a JSON string", content: '"not an object"' },
      { label: "whole file is a JSON array", content: "[1,2,3]" },
      { label: "pid/port/version are wrong types", content: JSON.stringify({ pid: "abc", port: "3901", version: 7 }) },
      { label: "empty object", content: "{}" },
    ];

    for (const { label, content } of HOSTILE_CONTENTS) {
      it(`${label} → no throw, deterministic port, type-clean shape`, async () => {
        const realRoot = fs.realpathSync(tmp);
        const dir = path.join(realRoot, ".deeppairing");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "daemon.json"), content);

        const status = await resolveDaemonStatus({
          startDir: realRoot,
          env: {},
          fetchImpl: deadFetch,
        });

        // The marker is still THIS project's — resolve to the walk-up dir.
        expect(status.projectRoot).toBe(realRoot);
        expect(status.port).toBe(preferredPortFor(realRoot));
        expect(status.alive).toBe(false);
        // Type-clean: hostile field types must not leak into the result.
        if (status.pid !== undefined) expect(typeof status.pid).toBe("number");
        if (status.version !== undefined) expect(typeof status.version).toBe("string");
        expect(typeof status.projectRoot).toBe("string");
      });
    }
  });

  // #186 review Fix 2 — port recycling: a stale daemon.json whose recorded port
  // is now held by a DIFFERENT project's daemon. The probe answers, but its
  // projectRoot is foreign — adopting it would report projB's root/hash as this
  // project's status (and `port` would print the foreign port with clean
  // stdout). Codebase norm: verify identity before trusting a port (evictDaemon
  // pid-checks; isDaemonRunning's sweep matches projectRoot). Mismatch ⇒
  // not-ours ⇒ alive:false + deterministic fallback.
  it("foreign daemon on the recorded port (recycled) → NOT adopted: alive:false + deterministic fallback", async () => {
    const realRoot = fs.realpathSync(tmp);
    // Stale record from OUR old daemon: our root, port 3901.
    writeDaemonJson(realRoot, { pid: 111, port: 3901, version: "0.1.10", projectRoot: realRoot });

    // A different project's daemon now answers on 3901.
    const status = await resolveDaemonStatus({
      startDir: realRoot,
      env: {},
      fetchImpl: fakeFetch(3901, { pid: 222, version: "0.1.11", projectRoot: "/some/other/project" }),
    });

    expect(status.alive).toBe(false); // not OUR daemon
    expect(status.port).toBe(preferredPortFor(realRoot)); // never the foreign port
    expect(status.projectRoot).toBe(realRoot); // never the foreign root
    expect(status.projectHash).toBe(projectHashOf(realRoot));
    // The foreign daemon's pid must not be reported as ours.
    expect(status.pid).not.toBe(222);
  });

  // #186 review nit — the corrupt-child-stops-the-walk behavior was claimed in
  // the findDaemonJson contract but untested: a corrupt daemon.json in the
  // child is still THIS project's marker, so the walk must stop there rather
  // than latch onto a PARENT project's (valid) daemon.json above it.
  it("corrupt daemon.json in child + valid one in parent → child wins (running:false, child's deterministic port)", async () => {
    const parent = fs.realpathSync(tmp);
    writeDaemonJson(parent, { pid: 1, port: 3900, version: "0.1.11", projectRoot: parent });
    const child = path.join(parent, "nested-project");
    fs.mkdirSync(path.join(child, ".deeppairing"), { recursive: true });
    fs.writeFileSync(path.join(child, ".deeppairing", "daemon.json"), "{corrupt json!!");

    const status = await resolveDaemonStatus({
      startDir: child,
      env: {},
      fetchImpl: deadFetch,
    });

    expect(status.projectRoot).toBe(child); // stopped at the child marker
    expect(status.running).toBe(false); // corrupt file carries no bound port
    expect(status.alive).toBe(false);
    expect(status.port).toBe(preferredPortFor(child)); // NOT the parent's 3900
  });
});
