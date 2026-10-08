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

/** Thrown inside startup when the user cancels (Ctrl+C / SIGTERM). */
class DemoCancelled extends Error {
  constructor() { super("cancelled"); }
}

/** Sleep that ends early (rejecting) when `signal` aborts. */
function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DemoCancelled());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DemoCancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForDemoDaemon(
  child: ChildProcess, sandbox: DemoSandbox, timeoutMs: number, stderrTail: () => string, cancel: AbortSignal,
): Promise<number> {
  const infoPath = path.join(sandbox.project, ".deeppairing", "daemon.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancel.aborted) throw new DemoCancelled();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the demo daemon exited during startup (${child.signalCode ?? `exit code ${child.exitCode}`}).\n${stderrTail()}`);
    }
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as { port?: number; pid?: number };
      if (info.port && info.pid === child.pid) {
        const res = await fetch(`http://127.0.0.1:${info.port}/`, { signal: AbortSignal.any([AbortSignal.timeout(1000), cancel]) });
        if (res.ok) return info.port;
      }
    } catch { /* not ready yet (or cancelled — checked at the loop top) */ }
    await cancellableSleep(100, cancel);
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
 *
 * Lifecycle (#481 review): the cancellation handlers (SIGINT, SIGTERM) are
 * installed BEFORE the first asynchronous step, so a Ctrl+C during a slow
 * startup is handled by us — not by Node's default handler, which would kill
 * this process without stopping the daemon or deleting the sandbox (an
 * 'exit' listener does not run on a default-signal death). Cancellation aborts
 * readiness polling and a pending /api/demo/run, and every path ends in ONE
 * shared shutdown (stop the daemon, then delete the sandbox) that is awaited
 * before the runner returns.
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
    // POSIX: its own process group, so a terminal Ctrl+C reaches only this
    // runner — which then stops the daemon itself, in order. (Windows has no
    // process-group signal fan-out; `detached` there would open a console.)
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stderr?.on("data", (d) => { stderrBuf = (stderrBuf + d.toString()).slice(-4000); });
  const tail = () => (stderrBuf.trim() ? `Daemon stderr:\n${stderrBuf.trim()}` : "");

  // --- Cancellation + end-of-demo signals, armed before anything async. ---
  const cancel = new AbortController();
  let endReason: string | null = null;
  let resolveEnd!: (why: string) => void;
  const ended = new Promise<string>((r) => { resolveEnd = r; });
  const end = (why: string) => {
    if (endReason) return;
    endReason = why;
    cancel.abort();
    resolveEnd(why);
  };
  const onInt = () => end("SIGINT");
  const onTerm = () => end("SIGTERM");
  const onDaemonExit = () => end("daemon-exit");
  let acceptingEnter = false;
  const onData = (chunk: Buffer | string) => { if (acceptingEnter && String(chunk).includes("\n")) end("enter"); };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  child.once("exit", onDaemonExit);
  input.on("data", onData);
  (input as NodeJS.ReadStream).resume?.(); // let 'data' flow from a paused stdin

  // Last-resort cleanup if this process dies some other way (uncaught error).
  const onProcessExit = () => {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { removeSandbox(sandbox); } catch { /* best effort */ }
  };
  process.once("exit", onProcessExit);

  // --- The one shared shutdown. ---
  let shutdown: Promise<void> | null = null;
  const shutdownOnce = () => {
    shutdown ??= (async () => {
      input.removeListener("data", onData);
      (input as NodeJS.ReadStream).pause?.();
      child.removeListener("exit", onDaemonExit);
      await stopDaemon(child);
      removeSandbox(sandbox);
      process.removeListener("exit", onProcessExit);
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    })();
    return shutdown;
  };
  const finish = async (code: number, message?: string): Promise<number> => {
    await shutdownOnce();
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
    port = await waitForDemoDaemon(child, sandbox, opts.readyTimeoutMs ?? 40_000, tail, cancel.signal);
    const res = await fetch(`http://127.0.0.1:${port}/api/demo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([AbortSignal.timeout(5000), cancel.signal]),
    });
    if (!res.ok) throw new Error(`the demo daemon refused to start the script (HTTP ${res.status})`);
    sessionId = ((await res.json()) as { sessionId: string }).sessionId;
    if (cancel.signal.aborted) throw new DemoCancelled();
  } catch (err) {
    if (endReason === "SIGINT" || endReason === "SIGTERM") {
      return finish(0, "  Demo cancelled. Its temporary data was deleted.");
    }
    const why = endReason === "daemon-exit"
      ? `the demo daemon exited during startup (${child.signalCode ?? `exit code ${child.exitCode}`}).\n${tail()}`
      : (err as Error).message;
    return finish(1, `  ✗ Could not start the demo: ${why}\n  Its temporary data was deleted.`);
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
  acceptingEnter = true;

  const reason = await ended;
  if (reason === "daemon-exit") {
    return finish(1, `  ✗ The demo daemon stopped unexpectedly. ${tail()}\n  Its temporary data was deleted.`);
  }
  return finish(0, "  Demo ended. Its temporary data was deleted.");
}
