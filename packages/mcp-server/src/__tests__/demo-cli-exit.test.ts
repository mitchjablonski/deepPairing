/**
 * #168 — the CLI-exits check + NO_OPEN, EXECUTED (not reasoned). Spawns the
 * REAL `deeppairing demo` CLI against a fresh tmp project (a genuine cold
 * start: the CLI spawns a fresh daemon), and proves:
 *
 *  - Bug #168.2 (the hang): a successful cold `demo` run EXITS cleanly. The old
 *    spawnDaemon piped the detached child's stderr and `child.unref()` didn't
 *    unref the PIPE, so the parent event loop stayed alive forever after
 *    printing. The fix releases the pipe once the daemon is adopted.
 *  - Bug #168.5 (NO_OPEN): with DEEPPAIRING_NO_OPEN=1 the CLI must NOT launch a
 *    browser and must instead print "open <url> in your browser".
 *
 * Depends on a built `dist/daemon/index.js` (the CLI spawns `node dist/...`);
 * CI's test task builds first (turbo). A bare unbuilt run is skipped rather
 * than flaking. SLOW: real cold daemon spawn — hence its own long budget + a
 * home in vitest.config.ts SPAWN_SUITES.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dir, "../cli/init.ts");
const tsxBin = path.resolve(__dir, "../../node_modules/.bin/tsx");
const distDaemon = path.resolve(__dir, "../../dist/daemon/index.js");

const spawnedDaemons: string[] = []; // tmp project roots to reap

afterEach(() => {
  for (const root of spawnedDaemons) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing", "daemon.json"), "utf-8"));
      if (typeof info.pid === "number") { try { process.kill(info.pid, "SIGKILL"); } catch { /* gone */ } }
    } catch { /* no daemon.json */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  spawnedDaemons.length = 0;
});

// The CLI prints with ANSI colour (bold/dim) wrapping words, so strip escapes
// before matching human-readable phrases (\x1b = ESC).
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number; }

function runDemo(projectRoot: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(tsxBin, [cliEntry, "demo"], {
      cwd: projectRoot,
      env: { ...process.env, DEEPPAIRING_NO_OPEN: "1", DEEPPAIRING_PROJECT_ROOT: projectRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
}

describe("#168 deeppairing demo — cold run exits cleanly + respects NO_OPEN", () => {
  it.skipIf(!fs.existsSync(distDaemon))(
    "exits (does not hang) after printing, and prints the NO_OPEN fallback URL line",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-demo-cli-"));
      spawnedDaemons.push(root);

      // The whole point: the process must EXIT on its own. If the stderr-pipe
      // hang regressed, SIGKILL fires at the timeout and code === null /
      // signal === "SIGKILL" — the assertions below fail loudly.
      const res = await runDemo(root, 75_000);

      const out = stripAnsi(res.stdout);
      expect(res.signal).toBeNull();       // NOT killed by our timeout
      expect(res.code).toBe(0);            // clean exit
      // NO_OPEN suppression path prints the URL for the human to open manually.
      expect(out).toMatch(/open http:\/\/localhost:\d+\/\?session=demo_\d+ in your browser/);
      // Sanity: the daemon actually came up.
      expect(out).toMatch(/Daemon ready on port \d+/);
    },
    90_000,
  );
});
