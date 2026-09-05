import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { TestInfo } from "@playwright/test";
import { BoundedDiagnosticTail, redactDiagnostic } from "./diagnostics.js";

const MAX_DAEMON_DIAGNOSTIC_BYTES = 64 * 1024;
interface DiagnosticStreamState { decoder: StringDecoder; pending: string; source: string; discarding: boolean }
interface DiagnosticState { tail: BoundedDiagnosticTail; streams: DiagnosticStreamState[] }
const daemonOutput = new WeakMap<ChildProcess, DiagnosticState>();
const diagnosticProcesses = new Set<ChildProcess>();

function retainLine(state: DiagnosticState, source: string, line: string): void {
  state.tail.record(`[${source}] ${line}`);
}

/** Capture a bounded tail of a daemon spawned with piped stdout/stderr. */
export function captureDaemonOutput(proc: ChildProcess): void {
  const state: DiagnosticState = { tail: new BoundedDiagnosticTail(MAX_DAEMON_DIAGNOSTIC_BYTES), streams: [] };
  daemonOutput.set(proc, state);
  const watch = (source: string, stream: NodeJS.ReadableStream | null | undefined) => {
    if (!stream) return;
    const streamState: DiagnosticStreamState = { decoder: new StringDecoder("utf8"), pending: "", source, discarding: false };
    state.streams.push(streamState);
    stream.on("data", (chunk: Buffer | string) => {
      let decoded = typeof chunk === "string" ? chunk : streamState.decoder.write(chunk);
      if (streamState.discarding) {
        const newline = decoded.indexOf("\n");
        if (newline < 0) return;
        decoded = decoded.slice(newline + 1);
        streamState.discarding = false;
      }
      streamState.pending += decoded;
      const parts = streamState.pending.split(/\r?\n/);
      streamState.pending = parts.pop() ?? "";
      for (const line of parts) retainLine(state, source, line);
      if (Buffer.byteLength(streamState.pending) > MAX_DAEMON_DIAGNOSTIC_BYTES) {
        streamState.pending = "";
        streamState.discarding = true;
      }
    });
    stream.once("end", () => {
      const tail = streamState.decoder.end();
      if (streamState.discarding) {
        streamState.pending = "";
        return;
      }
      streamState.pending += tail;
      if (streamState.pending) retainLine(state, source, streamState.pending);
      streamState.pending = "";
    });
  };
  watch("stdout", proc.stdout);
  watch("stderr", proc.stderr);
}

/** Spawn an E2E child with bounded, redacted stdout/stderr capture enabled. */
export function spawnDiagnosticProcess(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, "stdio"> = {},
): ChildProcess {
  const proc = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  captureDaemonOutput(proc);
  diagnosticProcesses.add(proc);
  return proc;
}

/** Test-only observation of bounded pre-newline state. */
export function diagnosticPendingBytesForTests(proc: ChildProcess): number {
  return daemonOutput.get(proc)?.streams.reduce(
    (total, stream) => total + Buffer.byteLength(stream.pending), 0,
  ) ?? 0;
}

export async function attachDaemonOutput(
  proc: ChildProcess | undefined,
  testInfo: TestInfo,
  opts: { force?: boolean; name?: string } = {},
): Promise<void> {
  if (!proc || (!opts.force && testInfo.status === testInfo.expectedStatus)) return;
  const state = daemonOutput.get(proc);
  if (!state) return;

  // Snapshot without consuming StringDecoder or pending state. Attachments can
  // happen more than once while a process is alive (setup catch, then teardown);
  // clearing a credential prefix here would let its later suffix through raw.
  const snapshot = new BoundedDiagnosticTail(MAX_DAEMON_DIAGNOSTIC_BYTES);
  for (const line of state.tail.lines) {
    snapshot.record(line.toString("utf8").replace(/\n$/, ""));
  }
  // Do not expose unterminated lines. A pending JSON/header credential may not
  // match a redactor until its closing quote arrives; the completed line will
  // be retained and scrubbed on the next newline/data event.
  for (const stream of state.streams) {
    if (stream.discarding || stream.pending) {
      snapshot.record(`[${stream.source}] [incomplete line withheld]`);
    }
  }
  if (snapshot.lines.length) {
    await testInfo.attach(opts.name ?? "daemon-diagnostics", {
      body: snapshot.body(),
      contentType: "text/plain",
    });
  }
}

export async function attachActiveDaemonOutputs(
  testInfo: TestInfo,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!opts.force && testInfo.status === testInfo.expectedStatus) return;
  let index = 0;
  for (const proc of diagnosticProcesses) {
    await attachDaemonOutput(proc, testInfo, {
      force: true,
      name: index++ === 0 ? "daemon-diagnostics" : `daemon-diagnostics-${index}`,
    });
  }
}

/** Attach all processes implicated in a setup hook without replacing its error. */
export async function attachSetupFailureOutputs(
  processes: Iterable<ChildProcess | undefined>,
  testInfo: TestInfo,
): Promise<void> {
  let index = 0;
  for (const proc of processes) {
    if (!proc) continue;
    try {
      await attachDaemonOutput(proc, testInfo, {
        force: true,
        name: index++ === 0 ? "daemon-diagnostics" : `daemon-diagnostics-${index}`,
      });
    } catch (attachmentError) {
      console.warn(`[e2e] could not attach daemon diagnostics: ${redactDiagnostic(String(attachmentError))}`);
    }
  }
}

/** Preserve a setup failure's process tail before Playwright skips test fixtures. */
export async function withSetupDiagnostics<T>(
  proc: ChildProcess,
  testInfo: TestInfo,
  setup: () => Promise<T>,
): Promise<T> {
  try {
    return await setup();
  } catch (error) {
    await attachSetupFailureOutputs([proc], testInfo);
    throw error;
  }
}

/**
 * Shared e2e teardown barrier.
 *
 * Diagnosis (I1): each spec boots its own daemon (`node dist/daemon/index.js`
 * against a mkdtemp projectRoot) in beforeAll and tore it down in afterAll with
 * a FIRE-AND-FORGET `proc.kill()` — no wait for the process to actually exit or
 * for its port to be released. The daemon's SIGTERM handler runs cleanup
 * (forceFlush every session + unlink daemon.json) and only THEN process.exit(0),
 * all asynchronous relative to the test runner; the sole backstop if the signal
 * is missed is the 60s idle auto-shutdown. So a killed daemon keeps LISTENING
 * for a while after afterAll returns.
 *
 * Confirmed empirically on WSL: sampling `pgrep daemon/index.js` across a single
 * `workers:1` suite run showed 3-4 daemons ALIVE AT ONCE (should be <=1), and an
 * isolated a11y run spent ~20s in beforeAll waiting for a slow-to-bind daemon.
 * Because every daemon picks its port deterministically inside the shared
 * [3847, 3974] window (preferredPortFor -> forward-scan on EADDRINUSE), the next
 * spec's daemon contends with the still-dying previous one: EADDRINUSE rescans,
 * inflated startup latency, and an occasional degraded first render/connection
 * that trips the following spec's 15s selector/poll waits. Always green in
 * isolation or on rerun (the zombie has idle-shut by then); never on CI (the
 * suite is the whole job, one run, cold ports).
 *
 * The fix: block afterAll until the daemon is provably DOWN - the process has
 * exited AND the port refuses connections - before the next spec spawns. Bounded
 * so a wedged daemon can't hang the suite: SIGTERM, poll ~5s, then SIGKILL + a
 * short final wait.
 */

/** Does anything accept a TCP connection on 127.0.0.1:port right now? */
function portAccepts(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (accepts: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(accepts);
    };
    socket.once("connect", () => done(true));
    // Review — only an ACTIVE refusal proves the port is free; any other
    // error (or a timed-out connect against a full accept backlog — the
    // wedged-daemon case) is treated as still-bound. The outer deadline
    // bounds total wait, so pessimism here costs nothing.
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(!(err.code === "ECONNREFUSED" || err.code === "ECONNRESET")),
    );
    socket.setTimeout(timeoutMs, () => done(true));
  });
}

/** Has `pid` exited? kill(pid, 0) throws ESRCH once the process is gone/reaped. */
function pidGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Signal the daemon and BLOCK until it is fully down: the process has exited
 * AND its port no longer accepts connections. Hard timeout falls back to
 * SIGKILL, then waits a little longer. Safe to call with an undefined proc.
 *
 * @param port the daemon's bound port (parsed from the spec's baseURL), or
 *   undefined to wait on process-exit only.
 */
export async function teardownDaemon(
  proc: ChildProcess | undefined,
  port: number | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  if (!proc) return;
  const pid = proc.pid;
  const timeoutMs = opts.timeoutMs ?? 5000;

  // Latch the real exit even if kill(pid,0) is racy around reaping.
  // Review — SEEDED: if the daemon already exited (60s idle auto-shutdown
  // during a slow spec), the 'exit' event fired long ago and a fresh
  // listener would never latch; correctness then rested on kill(pid,0)
  // against a possibly-REUSED pid.
  let exited = proc.exitCode !== null || proc.signalCode !== null;
  proc.once("exit", () => {
    exited = true;
  });

  const isDown = async (): Promise<boolean> => {
    if (!(exited || pidGone(pid))) return false;
    if (port !== undefined && (await portAccepts(port))) return false;
    return true;
  };

  proc.kill("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDown()) {
      diagnosticProcesses.delete(proc);
      return;
    }
    await sleep(50);
  }

  // Wedged daemon - escalate and give the kernel a moment to reap + release.
  try {
    // Handle-scoped kill (review): process.kill(pid) could hit a reused pid.
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) {
    if (await isDown()) {
      diagnosticProcesses.delete(proc);
      return;
    }
    await sleep(50);
  }
  // Review NIT — a silent give-up reproduces the original flake with zero
  // diagnostic; say exactly what's stuck.
  console.warn(
    `[e2e] teardownDaemon gave up: pid=${pid} port=${port} still up after SIGKILL — the next spec may flake`,
  );
  diagnosticProcesses.delete(proc);
}

/** Parse the daemon port out of a `http://localhost:PORT` base URL. */
export function portOf(baseURL: string | undefined): number | undefined {
  if (!baseURL) return undefined;
  const p = Number(new URL(baseURL).port);
  return Number.isFinite(p) && p > 0 ? p : undefined;
}
