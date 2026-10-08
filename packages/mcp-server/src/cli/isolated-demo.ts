/**
 * #471 — the isolated, no-build demo of a first useful review.
 *
 * One runner behind two entry points:
 *   - `node <plugin>/server/demo.mjs` — the shipped bundle (no clone, no
 *     pnpm, no build; plain Node 20.11+). See src/cli/demo-entry.ts.
 *   - `deeppairing demo` — the source CLI, which now runs the same sandbox.
 *
 * What it isolates (the old `demo` started the REAL daemon for the current
 * project, on the canonical 3847-3974 window, and wrote its demo sessions,
 * logs and daemon.json into that project's `.deeppairing/` and the project
 * registry into the real `~/.deeppairing/`):
 *   - a fresh temporary directory holds a throwaway HOME and a synthetic sample
 *     project; the demo daemon gets HOME/USERPROFILE pointed at it, so the
 *     cross-project ledger, the project registry and every other per-user file
 *     it could touch live there;
 *   - CLAUDE_PROJECT_DIR is removed and DEEPPAIRING_PROJECT_ROOT set, so the
 *     daemon can never resolve the user's real project (CLAUDE_PROJECT_DIR
 *     outranks DEEPPAIRING_PROJECT_ROOT in resolveProjectRoot);
 *   - the daemon binds its own port window (DEMO_PORT_BASE..+SPAN), never the
 *     canonical one, so it can neither collide with nor be mistaken for a real
 *     project daemon;
 *   - the daemon never auto-opens a browser (the runner opens the one demo URL
 *     itself, honouring DEEPPAIRING_NO_OPEN) and the opt-in install-health
 *     ping is forced off;
 *   - on Enter, Ctrl+C or SIGTERM the daemon is stopped and the whole
 *     temporary directory is deleted.
 *
 * The content is the existing scripted session (demo-script.ts): an agent's
 * proposal you reject with a reason, the remembered block when it is
 * re-proposed in new words, an explainer, and a closing debrief. Nothing calls
 * a model; the terminal and the companion both say it is a scripted sample.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { demoNarrationLines } from "../demo-script.js";
import { shouldAutoOpenBrowser } from "../daemon/auto-open.js";

/** The demo daemon's own port window — clear of the canonical 3847-3974. */
export const DEMO_PORT_BASE = 41000;
export const DEMO_PORT_SPAN = 64;
/** Prefix of the sandbox directory under os.tmpdir(). */
export const DEMO_SANDBOX_PREFIX = "deeppairing-demo-";

export interface IsolatedDemoOptions {
  /** The daemon entry to run with plain node (bundled daemon.js or dist). */
  daemonScript: string;
  /** Where lines are printed (default: stdout). */
  print?: (line: string) => void;
  /** Ends the demo when a line arrives (default: process.stdin). */
  input?: NodeJS.ReadableStream;
  /** Environment to derive the daemon's from (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Opens the demo URL (default: the platform opener, if allowed by env). */
  openUrl?: (url: string) => void;
  /** Readiness ceiling for the demo daemon. */
  readyTimeoutMs?: number;
}

export interface DemoSandbox { root: string; home: string; project: string }

/** Create the throwaway HOME + synthetic sample project. */
export function createDemoSandbox(): DemoSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), DEMO_SANDBOX_PREFIX));
  const home = path.join(root, "home");
  const project = path.join(root, "sample-project");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "README.md"),
    "# Sample project (deepPairing demo)\n\nSynthetic files for the scripted demo. This directory is deleted when the demo ends.\n",
  );
  fs.writeFileSync(
    path.join(project, "src", "config.ts"),
    "// Synthetic sample: a config loader the scripted agent proposes to refactor.\n" +
      "export function loadConfig(env: Record<string, string | undefined>) {\n" +
      "  return { port: Number(env.PORT ?? 3000), logLevel: env.LOG_LEVEL ?? \"info\" };\n}\n",
  );
  return { root, home, project };
}

/** The demo daemon's environment: the user's, minus anything that could point
 *  it at real data, plus the sandbox. Exported for the isolation tests. */
export function demoDaemonEnv(base: NodeJS.ProcessEnv, sandbox: DemoSandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of [
    "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID", "DEEPPAIRING_PORT_BASE", "DEEPPAIRING_PORT_SPAN",
    "DEEPPAIRING_PING", "DEEPPAIRING_PING_URL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  ]) delete env[key];
  return {
    ...env,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    DEEPPAIRING_PROJECT_ROOT: sandbox.project,
    DEEPPAIRING_PORT_BASE: String(DEMO_PORT_BASE),
    DEEPPAIRING_PORT_SPAN: String(DEMO_PORT_SPAN),
    DEEPPAIRING_NO_OPEN: "1",
    DEEPPAIRING_OPEN_BROWSER: "0",
  };
}

function defaultOpenUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* no opener: the URL is printed anyway */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForDemoDaemon(
  child: ChildProcess, sandbox: DemoSandbox, timeoutMs: number, stderrTail: () => string,
): Promise<number> {
  const infoPath = path.join(sandbox.project, ".deeppairing", "daemon.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the demo daemon exited during startup (${child.signalCode ?? `exit code ${child.exitCode}`}).\n${stderrTail()}`);
    }
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as { port?: number; pid?: number };
      if (info.port && info.pid === child.pid) {
        const res = await fetch(`http://127.0.0.1:${info.port}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return info.port;
      }
    } catch { /* not ready yet */ }
    await sleep(100);
  }
  throw new Error(`the demo daemon did not become ready within ${Math.round(timeoutMs / 1000)}s.\n${stderrTail()}`);
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  try { child.kill("SIGTERM"); } catch { /* gone */ }
  const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut) {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    await Promise.race([exited, sleep(2000)]);
  }
}

function removeSandbox(sandbox: DemoSandbox): void {
  fs.rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * Run the demo until the user ends it. Resolves with a process exit code.
 */
export async function runIsolatedDemo(opts: IsolatedDemoOptions): Promise<number> {
  const print = opts.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const baseEnv = opts.env ?? process.env;
  const input = opts.input ?? process.stdin;
  const sandbox = createDemoSandbox();
  let stderrBuf = "";
  const child = spawn(process.execPath, [opts.daemonScript], {
    cwd: sandbox.project,
    env: demoDaemonEnv(baseEnv, sandbox),
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (d) => { stderrBuf = (stderrBuf + d.toString()).slice(-4000); });
  const tail = () => (stderrBuf.trim() ? `Daemon stderr:\n${stderrBuf.trim()}` : "");

  // Last-resort cleanup if this process dies without reaching `finish`.
  const onProcessExit = () => {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { removeSandbox(sandbox); } catch { /* best effort */ }
  };
  process.once("exit", onProcessExit);

  let finished = false;
  const finish = async (code: number, message?: string): Promise<number> => {
    if (finished) return code;
    finished = true;
    await stopDaemon(child);
    removeSandbox(sandbox);
    process.removeListener("exit", onProcessExit);
    if (message) print(message);
    return code;
  };

  print("");
  print("  deepPairing demo — a SCRIPTED SAMPLE, not a real agent");
  print("  No AI model is called. A script plays the agent's part; all content is synthetic.");
  print(`  Sandbox: ${sandbox.root}`);
  print("  (a temporary HOME and sample project, deleted when the demo ends — your real");
  print("  projects, ~/.deeppairing and running deepPairing daemons are never touched)");
  print("");

  let port: number;
  let sessionId: string;
  try {
    port = await waitForDemoDaemon(child, sandbox, opts.readyTimeoutMs ?? 40_000, tail);
    const res = await fetch(`http://127.0.0.1:${port}/api/demo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`the demo daemon refused to start the script (HTTP ${res.status})`);
    sessionId = ((await res.json()) as { sessionId: string }).sessionId;
  } catch (err) {
    return finish(1, `  ✗ Could not start the demo: ${(err as Error).message}\n  Its temporary data was deleted.`);
  }

  const url = `http://localhost:${port}/?session=${sessionId}`;
  const willOpen = shouldAutoOpenBrowser(baseEnv);
  if (willOpen) (opts.openUrl ?? defaultOpenUrl)(url);
  print(willOpen ? "  ✓ Companion opened in your browser:" : "  ✓ Companion ready. Open this in your browser:");
  print(`    ${url}`);
  print("");
  print("  What the script does (watch the companion). It plays your part too —");
  print("  in a real session the rejection below is your own click and reason:");
  for (const line of demoNarrationLines()) print(`    ${line.at.padEnd(6)}  ${line.text}`);
  print("    t+7s    An explainer and a closing debrief summarise the run.");
  print("");
  print("  The match is on words (plus a short synonym list), not meaning.");
  print("");
  print("  Next — your first real review: install the plugin in Claude Code");
  print("    /plugin marketplace add https://github.com/mitchjablonski/deepPairing");
  print("    /plugin install deeppairing@deeppairing");
  print("  then open Claude Code in your own project and ask for real work. See");
  print("  https://github.com/mitchjablonski/deepPairing#your-first-review");
  print("");
  print("  Press Enter to end the demo and delete its data (Ctrl+C also works).");

  const reason = await new Promise<string>((resolve) => {
    let decided = false;
    const decide = (why: string) => {
      if (decided) return;
      decided = true;
      input.removeListener("data", onData);
      (input as NodeJS.ReadStream).pause?.();
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      child.removeListener("exit", onDaemonExit);
      resolve(why);
    };
    const onData = (chunk: Buffer | string) => { if (String(chunk).includes("\n")) decide("enter"); };
    const onInt = () => decide("SIGINT");
    const onTerm = () => decide("SIGTERM");
    const onDaemonExit = () => decide("daemon-exit");
    input.on("data", onData);
    (input as NodeJS.ReadStream).resume?.(); // let 'data' flow from a paused stdin
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    child.once("exit", onDaemonExit);
  });

  if (reason === "daemon-exit") {
    return finish(1, `  ✗ The demo daemon stopped unexpectedly. ${tail()}\n  Its temporary data was deleted.`);
  }
  return finish(0, "  Demo ended. Its temporary data was deleted.");
}
