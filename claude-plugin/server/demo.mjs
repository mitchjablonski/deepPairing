import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli/demo-entry.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// src/cli/isolated-demo.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// src/demo-script.ts
var DEFAULT_REJECTION_CONCEPT = "global mutable state for config";
var DEFAULT_REPROPOSAL = "Add a global mutable state singleton to hold config";
function demoNarrationLines() {
  return [
    { at: "t+0.5s", text: "Agent proposes a global mutable ConfigStore singleton." },
    { at: "t+2.5s", text: `You reject it as "${DEFAULT_REJECTION_CONCEPT}", with your reason.` },
    { at: "", text: "\u2192 Added to Your taste (this project's ledger)." },
    { at: "t+5.0s", text: `Agent re-proposes it in new words: "${DEFAULT_REPROPOSAL}".` },
    { at: "", text: "\u2192 \u{1F6E1} Pre-flight refuses it: every word of the concept is there. Hero toast fires." }
  ];
}

// src/daemon/auto-open.ts
function shouldAutoOpenBrowser(env) {
  const noOpen = (env.DEEPPAIRING_NO_OPEN ?? "").trim().toLowerCase();
  if (noOpen === "1" || noOpen === "true" || noOpen === "yes") return false;
  const openFlag = env.DEEPPAIRING_OPEN_BROWSER;
  return openFlag !== "0" && openFlag !== "false" && openFlag !== "no";
}

// src/cli/isolated-demo.ts
var DEMO_PORT_BASE = 41e3;
var DEMO_PORT_SPAN = 64;
var DEMO_SANDBOX_PREFIX = "deeppairing-demo-";
function createDemoSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), DEMO_SANDBOX_PREFIX));
  const home = path.join(root, "home");
  const project = path.join(root, "sample-project");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "README.md"),
    "# Sample project (deepPairing demo)\n\nSynthetic files for the scripted demo. This directory is deleted when the demo ends.\n"
  );
  fs.writeFileSync(
    path.join(project, "src", "config.ts"),
    '// Synthetic sample: a config loader the scripted agent proposes to refactor.\nexport function loadConfig(env: Record<string, string | undefined>) {\n  return { port: Number(env.PORT ?? 3000), logLevel: env.LOG_LEVEL ?? "info" };\n}\n'
  );
  return { root, home, project };
}
function demoDaemonEnv(base, sandbox) {
  const env = { ...base };
  for (const key of [
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_CODE_SESSION_ID",
    "DEEPPAIRING_PORT_BASE",
    "DEEPPAIRING_PORT_SPAN",
    "DEEPPAIRING_PING",
    "DEEPPAIRING_PING_URL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME"
  ]) delete env[key];
  return {
    ...env,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    DEEPPAIRING_PROJECT_ROOT: sandbox.project,
    DEEPPAIRING_PORT_BASE: String(DEMO_PORT_BASE),
    DEEPPAIRING_PORT_SPAN: String(DEMO_PORT_SPAN),
    DEEPPAIRING_NO_OPEN: "1",
    DEEPPAIRING_OPEN_BROWSER: "0"
  };
}
function defaultOpenUrl(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var DemoCancelled = class extends Error {
  constructor() {
    super("cancelled");
  }
};
function cancellableSleep(ms, signal) {
  if (signal.aborted) return Promise.reject(new DemoCancelled());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DemoCancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function waitForDemoDaemon(child, sandbox, timeoutMs, stderrTail, cancel) {
  const infoPath = path.join(sandbox.project, ".deeppairing", "daemon.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancel.aborted) throw new DemoCancelled();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the demo daemon exited during startup (${child.signalCode ?? `exit code ${child.exitCode}`}).
${stderrTail()}`);
    }
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      if (info.port && info.pid === child.pid) {
        const res = await fetch(`http://127.0.0.1:${info.port}/`, { signal: AbortSignal.any([AbortSignal.timeout(1e3), cancel]) });
        if (res.ok) return info.port;
      }
    } catch {
    }
    await cancellableSleep(100, cancel);
  }
  throw new Error(`the demo daemon did not become ready within ${Math.round(timeoutMs / 1e3)}s.
${stderrTail()}`);
}
async function stopDaemon(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", () => r()));
  try {
    child.kill("SIGTERM");
  } catch {
  }
  const timedOut = await Promise.race([exited.then(() => false), sleep(5e3).then(() => true)]);
  if (timedOut) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
    await Promise.race([exited, sleep(2e3)]);
  }
}
function removeSandbox(sandbox) {
  fs.rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
async function runIsolatedDemo(opts) {
  const print = opts.print ?? ((line) => process.stdout.write(`${line}
`));
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
    windowsHide: true
  });
  child.stderr?.on("data", (d) => {
    stderrBuf = (stderrBuf + d.toString()).slice(-4e3);
  });
  const tail = () => stderrBuf.trim() ? `Daemon stderr:
${stderrBuf.trim()}` : "";
  const cancel = new AbortController();
  let endReason = null;
  let resolveEnd;
  const ended = new Promise((r) => {
    resolveEnd = r;
  });
  const end = (why) => {
    if (endReason) return;
    endReason = why;
    cancel.abort();
    resolveEnd(why);
  };
  const onInt = () => end("SIGINT");
  const onTerm = () => end("SIGTERM");
  const onDaemonExit = () => end("daemon-exit");
  let acceptingEnter = false;
  const onData = (chunk) => {
    if (acceptingEnter && String(chunk).includes("\n")) end("enter");
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  child.once("exit", onDaemonExit);
  input.on("data", onData);
  input.resume?.();
  const onProcessExit = () => {
    try {
      child.kill("SIGKILL");
    } catch {
    }
    try {
      removeSandbox(sandbox);
    } catch {
    }
  };
  process.once("exit", onProcessExit);
  let shutdown = null;
  const shutdownOnce = () => {
    shutdown ??= (async () => {
      input.removeListener("data", onData);
      input.pause?.();
      child.removeListener("exit", onDaemonExit);
      await stopDaemon(child);
      removeSandbox(sandbox);
      process.removeListener("exit", onProcessExit);
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    })();
    return shutdown;
  };
  const finish = async (code, message) => {
    await shutdownOnce();
    if (message) print(message);
    return code;
  };
  print("");
  print("  deepPairing demo \u2014 a SCRIPTED SAMPLE, not a real agent");
  print("  No AI model is called. A script plays the agent's part; all content is synthetic.");
  print(`  Sandbox: ${sandbox.root}`);
  print("  (a temporary HOME and sample project, deleted when the demo ends \u2014 your real");
  print("  projects, ~/.deeppairing and running deepPairing daemons are never touched)");
  print("");
  let port;
  let sessionId;
  try {
    port = await waitForDemoDaemon(child, sandbox, opts.readyTimeoutMs ?? 4e4, tail, cancel.signal);
    const res = await fetch(`http://127.0.0.1:${port}/api/demo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([AbortSignal.timeout(5e3), cancel.signal])
    });
    if (!res.ok) throw new Error(`the demo daemon refused to start the script (HTTP ${res.status})`);
    sessionId = (await res.json()).sessionId;
    if (cancel.signal.aborted) throw new DemoCancelled();
  } catch (err) {
    if (endReason === "SIGINT" || endReason === "SIGTERM") {
      return finish(0, "  Demo cancelled. Its temporary data was deleted.");
    }
    const why = endReason === "daemon-exit" ? `the demo daemon exited during startup (${child.signalCode ?? `exit code ${child.exitCode}`}).
${tail()}` : err.message;
    return finish(1, `  \u2717 Could not start the demo: ${why}
  Its temporary data was deleted.`);
  }
  const url = `http://localhost:${port}/?session=${sessionId}`;
  const willOpen = shouldAutoOpenBrowser(baseEnv);
  if (willOpen) (opts.openUrl ?? defaultOpenUrl)(url);
  print(willOpen ? "  \u2713 Companion opened in your browser:" : "  \u2713 Companion ready. Open this in your browser:");
  print(`    ${url}`);
  print("");
  print("  What the script does (watch the companion). It plays your part too \u2014");
  print("  in a real session the rejection below is your own click and reason:");
  for (const line of demoNarrationLines()) print(`    ${line.at.padEnd(6)}  ${line.text}`);
  print("    t+7s    An explainer and a closing debrief summarise the run.");
  print("");
  print("  The match is on words (plus a short synonym list), not meaning.");
  print("");
  print("  Next \u2014 your first real review: install the plugin in Claude Code");
  print("    /plugin marketplace add https://github.com/mitchjablonski/deepPairing");
  print("    /plugin install deeppairing@deeppairing");
  print("  then open Claude Code in your own project and ask for real work. See");
  print("  https://github.com/mitchjablonski/deepPairing#your-first-review");
  print("");
  print("  Press Enter to end the demo and delete its data (Ctrl+C also works).");
  acceptingEnter = true;
  const reason = await ended;
  if (reason === "daemon-exit") {
    return finish(1, `  \u2717 The demo daemon stopped unexpectedly. ${tail()}
  Its temporary data was deleted.`);
  }
  return finish(0, "  Demo ended. Its temporary data was deleted.");
}

// src/cli/demo-entry.ts
var here = path2.dirname(fileURLToPath(import.meta.url));
var daemonScript = [path2.join(here, "daemon.js"), path2.join(here, "../daemon/index.js")].find((p) => fs2.existsSync(p));
if (!daemonScript) {
  process.stderr.write(`deepPairing demo: could not find the daemon next to ${here} (expected daemon.js). Re-install the plugin.
`);
  process.exit(1);
} else {
  const code = await runIsolatedDemo({ daemonScript });
  process.exit(code);
}
