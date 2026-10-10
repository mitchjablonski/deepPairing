/**
 * #471 — the no-build demo runs from the SHIPPED bundle in an isolated
 * sandbox and leaves the user's real HOME and project byte-identical.
 *
 * Copies only `claude-plugin/` (what a marketplace install or a repo download
 * has — no dist, no node_modules) and runs `node server/demo.mjs` with plain
 * node, the way an evaluator would. The child is given a FAKE "real" HOME and
 * "real" project (seeded with a ledger, a project registry and preferences),
 * CLAUDE_PROJECT_DIR pointing at that project (as when run from inside Claude
 * Code), and a user DEEPPAIRING_PORT_BASE — and must ignore all of them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_PORT_BASE, DEMO_PORT_SPAN, DEMO_SANDBOX_PREFIX } from "../cli/isolated-demo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginSrc = path.resolve(here, "../../../../claude-plugin");
const shippedDemo = path.join(pluginSrc, "server", "demo.mjs");

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* best effort */ } } });

/** Every file under `dir` → sha256 of its bytes (a byte-exact snapshot). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(true); });
  });
}

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface Running { child: ChildProcess; out: () => string; exited: Promise<number | null> }

function startDemo(world: { tmp: string; home: string; project: string; plugin: string; tmpdir: string }): Running {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: world.home, USERPROFILE: world.home,
    TMPDIR: world.tmpdir, TEMP: world.tmpdir, TMP: world.tmpdir,
    CLAUDE_PROJECT_DIR: world.project,           // as if run from inside Claude Code
    DEEPPAIRING_PORT_BASE: "26000",              // a user override the demo must not use
    DEEPPAIRING_NO_OPEN: "1", BROWSER: "none",   // never open a browser in tests
  };
  delete env.VITEST; delete env.NODE_ENV;
  const child = spawn(process.execPath, [path.join(world.plugin, "server", "demo.mjs")], {
    cwd: world.project, env, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  cleanups.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  return { child, out: () => out, exited };
}

async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-471-"));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const world = {
    tmp,
    home: path.join(tmp, "real-home"),
    project: path.join(tmp, "real-project"),
    plugin: path.join(tmp, "plugin"),
    tmpdir: path.join(tmp, "tmpdir"),
  };
  fs.cpSync(pluginSrc, world.plugin, { recursive: true });
  fs.mkdirSync(world.tmpdir);
  // A "real" user: a cross-project ledger, a project registry, and a project
  // with its own preferences and session history.
  fs.mkdirSync(path.join(world.home, ".deeppairing", "philosophy"), { recursive: true });
  fs.writeFileSync(path.join(world.home, ".deeppairing", "philosophy", "v1.json"), JSON.stringify({ version: 1, concepts: {} }));
  fs.writeFileSync(path.join(world.home, ".deeppairing", "projects.json"), JSON.stringify({ projects: [] }));
  fs.mkdirSync(path.join(world.project, ".deeppairing", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(world.project, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: [{ description: "keep me" }] }));
  fs.writeFileSync(path.join(world.project, "index.ts"), "export const real = true;\n");
  return world;
}

describe.runIf(fs.existsSync(shippedDemo))("#471 — isolated no-build demo from the shipped bundle", () => {
  it("plays the scripted review in a sandbox, then Enter stops it and deletes the sandbox; real HOME and project untouched", async () => {
    const world = makeWorld();
    const before = { home: snapshot(world.home), project: snapshot(world.project) };

    const demo = startDemo(world);
    await waitFor(() => demo.out().includes("Press Enter to end the demo"), 45_000, `the demo to be ready; output:\n${demo.out()}`);
    const out = demo.out();
    expect(out).toContain("SCRIPTED SAMPLE, not a real agent");
    expect(out).toContain("No AI model is called");

    // Its own port window — not the canonical one, not the user's override.
    const url = out.match(/http:\/\/localhost:(\d+)\/\?session=(demo_\d+_[a-f0-9]+)/)!;
    const port = Number(url[1]);
    const sessionId = url[2]!;
    expect(port).toBeGreaterThanOrEqual(DEMO_PORT_BASE);
    expect(port).toBeLessThan(DEMO_PORT_BASE + DEMO_PORT_SPAN);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);

    // The sandbox lives under the (redirected) temp dir; the daemon serves IT.
    const sandbox = out.match(/Sandbox: (.+)/)![1]!.trim();
    expect(path.dirname(sandbox)).toBe(world.tmpdir);
    expect(path.basename(sandbox).startsWith(DEMO_SANDBOX_PREFIX)).toBe(true);
    const info = JSON.parse(fs.readFileSync(path.join(sandbox, "sample-project", ".deeppairing", "daemon.json"), "utf8"));
    expect(info.projectRoot).toBe(path.join(sandbox, "sample-project"));

    // The scripted review plays out: a proposal rejected with a reason, the
    // remembered block, an explainer and a closing debrief.
    const hash = crypto.createHash("sha256").update(info.projectRoot).digest("hex").slice(0, 8);
    const state = await waitFor(async () => {
      const s = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "X-Project-Hash": hash, "X-Session-Id": sessionId } })).json() as { artifacts?: Array<{ type: string; status: string }> };
      const types = (s.artifacts ?? []).map((a) => a.type);
      return types.includes("debrief") ? s : null;
    }, 20_000, "the scripted session to finish");
    const research = state.artifacts!.find((a) => a.type === "research")!;
    expect(research.status).toBe("rejected");
    expect(state.artifacts!.map((a) => a.type)).toEqual(expect.arrayContaining(["research", "explainer", "debrief"]));

    // Exit: Enter ends it, stops the daemon, deletes the sandbox.
    demo.child.stdin!.write("\n");
    expect(await demo.exited).toBe(0);
    expect(demo.out()).toContain("Demo ended. Its temporary data was deleted.");
    expect(fs.existsSync(sandbox)).toBe(false);
    expect(fs.readdirSync(world.tmpdir)).toEqual([]);
    expect(pidAlive(info.pid)).toBe(false);
    expect(await portAccepts(port)).toBe(false);

    // The user's real HOME and project are byte-identical.
    expect(snapshot(world.home)).toEqual(before.home);
    expect(snapshot(world.project)).toEqual(before.project);
  }, 90_000);

  it.runIf(process.platform !== "win32")("Ctrl+C / SIGTERM also stops the daemon and deletes the sandbox", async () => {
    const world = makeWorld();
    const demo = startDemo(world);
    await waitFor(() => demo.out().includes("Press Enter to end the demo"), 45_000, "the demo to be ready");
    const sandbox = demo.out().match(/Sandbox: (.+)/)![1]!.trim();
    const pid = JSON.parse(fs.readFileSync(path.join(sandbox, "sample-project", ".deeppairing", "daemon.json"), "utf8")).pid as number;
    demo.child.kill("SIGINT");
    expect(await demo.exited).toBe(0);
    expect(fs.existsSync(sandbox)).toBe(false);
    expect(pidAlive(pid)).toBe(false);
  }, 90_000);

  /**
   * #481 review — cancelling DURING STARTUP must still stop the daemon and
   * delete the sandbox. The copied bundle's daemon.js is swapped for a thin
   * wrapper around the real one that makes startup deliberately slow, so the
   * signal provably lands mid-startup rather than winning a timing race:
   *   - "listening": the real daemon binds and writes daemon.json, but every
   *     HTTP request is held for 30 s, so the runner is still polling for
   *     readiness (Astra's repro: an orphan daemon left LISTENING);
   *   - "pre-bind": the daemon process sleeps 30 s before loading at all.
   */
  const SLOW_WRAPPERS = {
    listening: [
      'import http from "node:http";',
      "const emit = http.Server.prototype.emit;",
      'http.Server.prototype.emit = function (ev, ...args) { if (ev === "request") { setTimeout(() => emit.call(this, ev, ...args), 30000); return true; } return emit.call(this, ev, ...args); };',
      'await import("./daemon-real.js");',
    ].join("\n"),
    "pre-bind": [
      'import fs from "node:fs"; import path from "node:path";',
      'fs.writeFileSync(path.join(process.env.DEEPPAIRING_PROJECT_ROOT, "..", "daemon-started"), String(process.pid));',
      "await new Promise((r) => setTimeout(r, 30000));",
      'await import("./daemon-real.js");',
    ].join("\n"),
  } as const;

  const cases: Array<["SIGINT" | "SIGTERM", keyof typeof SLOW_WRAPPERS]> = [
    ["SIGINT", "listening"], ["SIGTERM", "listening"], ["SIGINT", "pre-bind"], ["SIGTERM", "pre-bind"],
  ];
  for (const [signal, mode] of cases) {
    it.runIf(process.platform !== "win32")(`${signal} during a slow startup (${mode}) stops the owned daemon and deletes the sandbox`, async () => {
      const world = makeWorld();
      const server = path.join(world.plugin, "server");
      fs.renameSync(path.join(server, "daemon.js"), path.join(server, "daemon-real.js"));
      fs.writeFileSync(path.join(server, "daemon.js"), SLOW_WRAPPERS[mode]);
      const before = { home: snapshot(world.home), project: snapshot(world.project) };

      const demo = startDemo(world);
      const sandbox = await waitFor(() => demo.out().match(/Sandbox: (.+)/)?.[1]?.trim(), 30_000, "the sandbox line");
      // Wait until the daemon process is provably running mid-startup.
      const { pid, port } = await waitFor(() => {
        try {
          if (mode === "pre-bind") {
            return { pid: Number(fs.readFileSync(path.join(sandbox, "daemon-started"), "utf8")), port: null as number | null };
          }
          const info = JSON.parse(fs.readFileSync(path.join(sandbox, "sample-project", ".deeppairing", "daemon.json"), "utf8"));
          return info.pid ? { pid: info.pid as number, port: info.port as number } : null;
        } catch { return null; }
      }, 30_000, "the daemon to be mid-startup");
      // Owned by this test: never leave it running even if an assertion fails.
      cleanups.push(() => { if (pidAlive(pid)) process.kill(pid, "SIGKILL"); });
      expect(pidAlive(pid)).toBe(true);
      if (port !== null) expect(await portAccepts(port)).toBe(true); // listening, not yet ready
      expect(demo.out()).not.toContain("Companion ready");

      demo.child.kill(signal);
      expect(await demo.exited).toBe(0);
      const out = demo.out();
      expect(out).toContain("Demo cancelled. Its temporary data was deleted.");
      expect(out).not.toContain("Companion ready"); // no success printed after cancel
      expect(pidAlive(pid)).toBe(false);
      if (port !== null) expect(await portAccepts(port)).toBe(false);
      expect(fs.existsSync(sandbox)).toBe(false);
      expect(fs.readdirSync(world.tmpdir)).toEqual([]);
      expect(snapshot(world.home)).toEqual(before.home);
      expect(snapshot(world.project)).toEqual(before.project);
    }, 90_000);
  }
});
