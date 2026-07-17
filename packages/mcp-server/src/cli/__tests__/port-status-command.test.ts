/**
 * #163 — `deeppairing port` + `deeppairing status`. Spawns the REAL CLI (under
 * tsx, no build) against a scratch project + scratch HOME (never real
 * ~/.deeppairing). Fakes not mocks: a real node:http server stands in for a live
 * daemon on the alive path so we exercise the actual probe.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";
import { preferredPortFor } from "../../project-root.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "../init.ts");
const tsxBin = path.resolve(here, "../../../node_modules/.bin/tsx");

let tmp: string;
let scratchHome: string;
let projectDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-portcmd-"));
  scratchHome = path.join(tmp, "home");
  projectDir = path.join(tmp, "project");
  fs.mkdirSync(scratchHome, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run the CLI in `cwd` with a clean env (scratch HOME, no project-root env
 *  leak), capturing stdout + stderr separately.
 *
 *  ASYNC (not spawnSync): the alive-path tests run an in-process http server
 *  that stands in for the daemon, and the CLI child probes it. spawnSync would
 *  BLOCK this worker's event loop, so the fake daemon could never answer the
 *  probe (it'd read stale). An async spawn keeps the loop free to serve it. */
function runCliBoth(cmd: string, cwd = projectDir): Promise<{ stdout: string; stderr: string; status: number }> {
  const env = { ...process.env, HOME: scratchHome };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.DEEPPAIRING_PROJECT_ROOT;
  // Vitest injects its own loader via NODE_OPTIONS; passing it to the spawned
  // tsx makes the child try to require vitest's loader and die with empty
  // stdout. Strip it so the child is a clean tsx run.
  delete env.NODE_OPTIONS;
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [cliEntry, cmd], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (status) => resolve({ stdout, stderr, status: status ?? 0 }));
  });
}

describe("#163 `deeppairing port`", () => {
  it("not running → prints the deterministic port to STDOUT + a note to STDERR", async () => {
    const { stdout, stderr } = await runCliBoth("port");
    const expectedPort = preferredPortFor(fs.realpathSync(projectDir));
    expect(stdout.trim()).toBe(String(expectedPort));
    expect(stderr).toContain("no daemon running");
  });

  it("running → prints ONLY the bare bound port to stdout (clean for scripting)", async () => {
    // Stand up a fake daemon on an OS-assigned port, then record it in daemon.json.
    const realRoot = fs.realpathSync(projectDir);
    const server = http.createServer((req, res) => {
      if (req.url === "/api/daemon-info") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ pid: 1234, version: "0.1.11", projectRoot: realRoot }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    fs.mkdirSync(path.join(projectDir, ".deeppairing"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".deeppairing", "daemon.json"),
      JSON.stringify({ pid: 1234, port, version: "0.1.11", projectRoot: realRoot }),
    );
    try {
      const { stdout, stderr } = await runCliBoth("port");
      expect(stdout.trim()).toBe(String(port));
      expect(stderr.trim()).toBe(""); // no note when alive
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}, 30_000);

describe("#163 `deeppairing status`", () => {
  it("not running → friendly picture with the deterministic port + 'not running'", async () => {
    const { stdout } = await runCliBoth("status");
    const expectedPort = preferredPortFor(fs.realpathSync(projectDir));
    expect(stdout).toContain("deepPairing status");
    expect(stdout).toContain("not running");
    expect(stdout).toContain(`http://localhost:${expectedPort}`);
    expect(stdout).toContain("projectRoot:");
    expect(stdout).toContain("projectHash:");
    // Mentions both discovery paths.
    expect(stdout).toContain("!deeppairing port");
  });

  it("running → shows running + companion URL + pid + version", async () => {
    const realRoot = fs.realpathSync(projectDir);
    const server = http.createServer((req, res) => {
      if (req.url === "/api/daemon-info") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ pid: 4321, version: "0.1.11", projectRoot: realRoot }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    fs.mkdirSync(path.join(projectDir, ".deeppairing"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".deeppairing", "daemon.json"),
      JSON.stringify({ pid: 4321, port, version: "0.1.11", projectRoot: realRoot }),
    );
    try {
      const { stdout } = await runCliBoth("status");
      expect(stdout).toContain("running");
      expect(stdout).toContain(`http://localhost:${port}`);
      expect(stdout).toContain("4321");
      expect(stdout).toContain("v0.1.11");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("walk-up: `status` run from a SUBDIRECTORY resolves the project's daemon.json", async () => {
    const realRoot = fs.realpathSync(projectDir);
    const server = http.createServer((req, res) => {
      if (req.url === "/api/daemon-info") {
        res.end(JSON.stringify({ pid: 9, version: "0.1.11", projectRoot: realRoot }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    fs.mkdirSync(path.join(projectDir, ".deeppairing"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".deeppairing", "daemon.json"),
      JSON.stringify({ pid: 9, port, version: "0.1.11", projectRoot: realRoot }),
    );
    const subdir = path.join(projectDir, "src", "deep");
    fs.mkdirSync(subdir, { recursive: true });
    try {
      const { stdout } = await runCliBoth("status", subdir);
      expect(stdout).toContain(`http://localhost:${port}`);
      expect(stdout).toContain("running");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}, 30_000);
