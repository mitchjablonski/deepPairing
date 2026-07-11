/**
 * Daemon lifecycle management — detect, spawn, and connect to the
 * shared deepPairing HTTP daemon process.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTokenSidecar } from "./token.js";
import { projectHashOf, preferredPortFor } from "../project-root.js";
import { SERVER_VERSION, compareServerVersions } from "../version.js";

const __thisDir = path.dirname(fileURLToPath(import.meta.url));

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  /**
   * II1 — shared secret required by every `/api/internal/*` route. Optional
   * because (a) older daemons running an older build won't have minted one
   * yet, and (b) test fixtures sometimes construct DaemonInfo without it.
   * When present, DaemonClient stamps `Authorization: Bearer <token>` on
   * every internal call; absence means the wrapper can't authenticate and
   * should refuse to proceed against that daemon.
   */
  authToken?: string;
  /** Daemon's projectRoot — included for adoption checks; same value as projectHashOf source. */
  projectRoot?: string;
  /**
   * #136 — the SERVER_VERSION the running daemon was built from. Written into
   * daemon.json + advertised on /api/daemon-info. Optional because a daemon
   * from a pre-#136 build won't carry it — and absence is itself the signal
   * that the daemon is stale (it predates the version stamp) so ensureDaemon
   * restarts rather than adopts it.
   */
  version?: string;
}

const DAEMON_FILE = "daemon.json";
export const DEFAULT_PORT = 3847;
export const MAX_PORT_ATTEMPTS = 10;

/**
 * #136 — wrapper-side loud log for the stale-daemon restart path. This runs in
 * the MCP subprocess (not the daemon), so it has no daemon.log handle; stderr
 * is where Claude Code surfaces MCP-server diagnostics, which is exactly where
 * a user chasing "why is my updated plugin still buggy?" would look.
 */
function logStale(msg: string): void {
  try { process.stderr.write(`${msg}\n`); } catch { /* stderr closed — nothing to do */ }
}

function daemonInfoPath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", DAEMON_FILE);
}

function readDaemonInfo(projectRoot: string): DaemonInfo | null {
  const infoPath = daemonInfoPath(projectRoot);
  try {
    if (!fs.existsSync(infoPath)) return null;
    const info: DaemonInfo = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
    // III9 — on a non-POSIX project dir (WSL /mnt/c, NFS, SMB) the daemon
    // writes daemon.json WITHOUT the token (it can't hold 0600 there) and
    // stashes the token in a 0600 per-user runtime sidecar. Merge it back so
    // the wrapper can authenticate against /api/internal/*. The pid guard
    // rejects a stale sidecar left by a dead daemon of the same project.
    if (!info.authToken) {
      const sidecar = readTokenSidecar(projectRoot);
      if (sidecar?.authToken && (sidecar.pid === undefined || sidecar.pid === info.pid)) {
        info.authToken = sidecar.authToken;
      }
    }
    return info;
  } catch {
    return null;
  }
}

// II1 — removed wrapper-side writeDaemonInfo: it was overwriting the
// daemon's own daemon.json (which carries the authToken) with a salvage
// record that had no token. The daemon writes the canonical file on
// startup + every 30s heartbeat; wrappers only read.

/**
 * III9 follow-up — headers required to call the AA4-gated public daemon
 * surface (`/api/state` and friends). The `X-Project-Hash` is what the AA4
 * middleware actually checks; the bearer token is added when readable
 * (sidecar-aware, via readDaemonInfo) so the same headers also satisfy the
 * III5 Bearer-gated routes. Sending these lets a caller tell "alive but
 * auth-gated" (200/401/403 — a real HTTP response) apart from a refused
 * connection (the daemon is actually down).
 */
export function daemonAuthHeaders(projectRoot: string): Record<string, string> {
  const headers: Record<string, string> = { "X-Project-Hash": projectHashOf(projectRoot) };
  const info = readDaemonInfo(projectRoot);
  if (info?.authToken) headers.Authorization = `Bearer ${info.authToken}`;
  return headers;
}

/** Probe a port to check if a deepPairing daemon is responding.
 *  III9 — `/api/state` is gated by the AA4 X-Project-Hash middleware, so the
 *  probe must send the project-hash header; otherwise a healthy secured
 *  daemon answers 403 and we'd wrongly conclude it's dead. */
async function probeDaemon(port: number, projectRoot: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://localhost:${port}/api/state`, {
      signal: controller.signal,
      headers: daemonAuthHeaders(projectRoot),
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Ask a running daemon who it is. Returns null if unreachable or not a deepPairing daemon.
 *  II1 — /api/daemon-info does NOT include the authToken (that's the whole point —
 *  the token is delivered via the file-system permission boundary, not over HTTP).
 *  This probe is only for "is something there + what project does it serve". */
export async function probeDaemonIdentity(port: number, timeoutMs = 1500): Promise<{ pid: number; projectRoot: string; startedAt: string; version?: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://localhost:${port}/api/daemon-info`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    if (typeof data?.pid !== "number" || typeof data?.projectRoot !== "string") return null;
    // #136 — `version` is optional: a pre-#136 daemon answers /api/daemon-info
    // without it, and absence is meaningful (⇒ stale). Only pass through a
    // string; anything else collapses to undefined ("absent").
    return {
      pid: data.pid,
      projectRoot: data.projectRoot,
      startedAt: data.startedAt,
      version: typeof data.version === "string" ? data.version : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * AA3 — cooperative-shutdown call to a squatter daemon.
 *
 * Doctor uses this to ask the squatting daemon to flush + exit cleanly
 * BEFORE falling back to SIGTERM. Confirms the pid before sending the
 * request (defends against PID reuse — the original daemon may have died
 * and the OS recycled the pid into something unrelated).
 *
 * Returns:
 *   "evicted"       — daemon flushed + exited; port should be free.
 *   "pid_mismatch"  — the pid on the daemon's /api/daemon-info no longer
 *                     matches expectedPid; refuse to evict (don't kill
 *                     a recycled pid that isn't ours).
 *   "no_daemon"     — port has no daemon listening.
 *   "refused"       — daemon is running but rejected the evict (older
 *                     daemon, missing the /api/evict route).
 */
export async function evictDaemon(
  port: number,
  expectedPid: number,
  timeoutMs = 2000,
): Promise<"evicted" | "pid_mismatch" | "no_daemon" | "refused"> {
  const id = await probeDaemonIdentity(port, timeoutMs);
  if (!id) return "no_daemon";
  if (id.pid !== expectedPid) return "pid_mismatch";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://localhost:${port}/api/evict`, {
      method: "POST",
      // #161 — /api/evict is registered on the daemon's ROOT app AFTER the
      // public sub-app mount, and that sub-app's `use("*")` middleware (the
      // AA4 X-Project-Hash gate + SP1 bearer gate) matches root routes
      // registered after the mount. The confirm-pid header alone therefore
      // 403'd (project_hash_mismatch) against every current daemon — the
      // doctor's cooperative evict silently degraded to its SIGTERM fallback,
      // always. The daemon just told us its projectRoot via /api/daemon-info,
      // and the caller runs as the same uid, so it can resolve the SQUATTER
      // daemon's own hash + bearer token exactly the way DaemonClient does:
      // daemonAuthHeaders → projectHashOf(root) + readDaemonInfo (daemon.json,
      // III9 sidecar-aware). A daemon that still 403s (or predates the route)
      // keeps returning "refused" → the caller's SIGTERM fallback is unchanged.
      headers: {
        ...daemonAuthHeaders(id.projectRoot),
        "X-DeepPairing-Confirm-Pid": String(expectedPid),
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return "evicted";
    return "refused";
  } catch {
    return "refused";
  }
}

/**
 * Check if the daemon is running. Unlike the old version, this probes the
 * actual HTTP port rather than relying solely on the info file — if the
 * daemon is healthy but daemon.json is missing/stale, we still adopt it.
 *
 * N2.1: multi-project support — each project's daemon can bind a different
 * port (3847, 3848, …), so we sweep the range when daemon.json is missing
 * and only adopt a daemon whose /api/daemon-info reports OUR projectRoot.
 */
export async function isDaemonRunning(
  projectRoot: string,
  /** Optional port range override — primarily for tests so we don't hit 3847 in CI.
   *  Default sweep starts at this project's deterministic preferred port (so the
   *  cold sweep finds our own daemon in ~one probe), not the shared 3847 base. */
  range: { start: number; count: number } = { start: preferredPortFor(projectRoot), count: MAX_PORT_ATTEMPTS },
): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(projectRoot);

  // Fast path: info file present — verify PID and probe port.
  if (info) {
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    if (pidAlive && await probeDaemon(info.port, projectRoot)) return info;
  }

  // Slow path: daemon.json missing or stale. Sweep the candidate port range
  // and adopt only a daemon whose projectRoot matches ours — otherwise we'd
  // latch onto another project's daemon on port 3847.
  for (let attempt = 0; attempt < range.count; attempt++) {
    const port = range.start + attempt;
    const identity = await probeDaemonIdentity(port);
    if (!identity) continue;
    if (identity.projectRoot !== projectRoot) continue;
    // II1 — the daemon's own writeDaemonInfo on startup + heartbeat is the
    // source of truth for `authToken`. Re-read daemon.json after confirming
    // a matching live daemon: it may have appeared between our first read
    // and this point (race during daemon startup) and it carries the token
    // we need to talk to /api/internal/*. Don't OVERWRITE the file from
    // the wrapper side — pre-II1 we wrote a token-less salvage record back,
    // which silently broke wrapper auth the next time it ran.
    const fresh = readDaemonInfo(projectRoot);
    if (fresh && fresh.pid === identity.pid && fresh.port === port) {
      return fresh;
    }
    const adopted: DaemonInfo = {
      pid: identity.pid,
      port,
      startedAt: identity.startedAt,
      projectRoot: identity.projectRoot,
      // #136 — carry the probed version so ensureDaemon's stale-check has it
      // even on the daemon.json-less sweep path.
      version: identity.version,
    };
    // No token available — the caller (waitForDaemon) will poll a few more
    // times before timing out, giving the daemon's heartbeat a window to
    // land daemon.json.
    return adopted;
  }

  // Clean up stale info file now that we've confirmed no daemon is responding.
  if (info) {
    try { fs.unlinkSync(daemonInfoPath(projectRoot)); } catch {}
  }
  return null;
}

/** Wait for the daemon info file to appear (polls every 200ms). */
async function waitForDaemon(projectRoot: string, timeoutMs = 10000): Promise<DaemonInfo> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await isDaemonRunning(projectRoot);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 200));
  }

  // A4: informative timeout — include the port range we swept + anything
  // we can observe about what might be holding it.
  const hint = await describePortHolders(projectRoot);
  const first = DEFAULT_PORT;
  const last = DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1;
  throw new Error(
    `deepPairing daemon did not become ready within ${timeoutMs}ms (swept ports ${first}–${last}).\n${hint}\n` +
    `Run 'npx deeppairing doctor' to diagnose, or check .deeppairing/daemon.log.`,
  );
}

/** Best-effort port-holder description for the timeout error. */
async function describePortHolders(projectRoot: string): Promise<string> {
  const parts: string[] = [];
  const info = readDaemonInfo(projectRoot);
  if (info) {
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    parts.push(
      pidAlive
        ? `daemon.json reports PID ${info.pid} on port ${info.port} (started ${info.startedAt}) but it is not responding on /api/state`
        : `daemon.json reports PID ${info.pid} but that process is gone`,
    );
  } else {
    parts.push("No daemon.json found.");
  }
  // Report what's holding each candidate port so the user can tell if 3847
  // is a different project's daemon vs. nothing.
  const observations: string[] = [];
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = DEFAULT_PORT + attempt;
    const identity = await probeDaemonIdentity(port);
    if (identity) {
      const mine = identity.projectRoot === projectRoot ? " (this project)" : ` (other project: ${identity.projectRoot})`;
      observations.push(`  :${port} — deepPairing daemon, PID ${identity.pid}${mine}`);
    }
  }
  if (observations.length) {
    parts.push("Ports holding a daemon:");
    parts.push(...observations);
  } else {
    parts.push(`No daemons responding on ${DEFAULT_PORT}–${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1}.`);
  }
  return parts.join("\n");
}

/** Spawn the daemon as a detached background process. */
function spawnDaemon(projectRoot: string): { stderrTail: () => string } {
  // F4 — this file lives in src/daemon/ (or dist/daemon/) now: the tsc-built
  // entry is two levels up at dist/daemon/index.js. The flat-bundle fallback
  // below is unchanged (esbuild inlines this file beside daemon.js).
  const daemonScript = path.join(__thisDir, "../../dist/daemon/index.js");
  const scriptPath = fs.existsSync(daemonScript)
    ? daemonScript
    : path.join(__thisDir, "daemon.js");

  const child = spawn("node", [scriptPath], {
    cwd: projectRoot,
    detached: true,
    // A3: capture stderr so we can distinguish "starting" from "dead" and
    // include the bind-failure message in timeout errors. Keep stdin/stdout
    // ignored.
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, DEEPPAIRING_PROJECT_ROOT: projectRoot },
  });

  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrBuf += text;
    // Cap buffer to avoid unbounded growth.
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  child.unref();
  return { stderrTail: () => stderrBuf };
}

/**
 * #136 — version verdict for a discovered daemon vs. THIS process's build.
 *   - "same"    → adopt (fast common path, no behavior change).
 *   - "newer"   → adopt, do NOT kill (killing would DOWNGRADE the user; two
 *                 versions legitimately coexist across projects/terminals).
 *   - "older"   → restart (the whole point: an updated plugin must not keep
 *                 serving pre-fix behavior from the old process).
 *   - "absent"  → restart (no version field ⇒ pre-#136 daemon ⇒ definitely stale).
 *   - "unknown" → restart (a version we can't parse — fail loud, don't adopt
 *                 blind). Distinct from "absent" only for clearer logging.
 */
export type DaemonVersionVerdict = "same" | "newer" | "older" | "absent" | "unknown";

export function classifyDaemonVersion(
  runningVersion: string | undefined | null,
  myVersion: string,
): DaemonVersionVerdict {
  if (runningVersion === undefined || runningVersion === null || runningVersion === "") {
    return "absent";
  }
  const cmp = compareServerVersions(runningVersion, myVersion);
  if (Number.isNaN(cmp)) return "unknown";
  if (cmp < 0) return "older";
  if (cmp > 0) return "newer";
  return "same";
}

/** #136 — the three verdicts that mean "the running daemon is stale; restart it". */
function verdictIsStale(v: DaemonVersionVerdict): boolean {
  return v === "older" || v === "absent" || v === "unknown";
}

/**
 * #136 — `deeppairing doctor` staleness verdict for a daemon that serves THIS
 * project. Pure so it's unit-testable without spinning a daemon: given the
 * running daemon's version and this plugin's version, report whether the daemon
 * is stale and a human-readable line. "newer" is explicitly NOT stale (the user
 * legitimately runs a newer daemon elsewhere; doctor must not tell them to
 * restart it).
 */
export function describeDaemonVersionHealth(
  runningVersion: string | undefined,
  pluginVersion: string,
): { stale: boolean; verdict: DaemonVersionVerdict; message: string } {
  const verdict = classifyDaemonVersion(runningVersion, pluginVersion);
  if (verdict === "same") {
    return { stale: false, verdict, message: `Daemon version v${runningVersion} matches this plugin (v${pluginVersion}).` };
  }
  if (verdict === "newer") {
    return {
      stale: false,
      verdict,
      message: `Daemon is running v${runningVersion}, NEWER than this plugin (v${pluginVersion}) — not stale (you likely run a newer deepPairing in another project). Left as-is.`,
    };
  }
  const runningLabel =
    verdict === "absent" ? "an unversioned build (pre-0.1.4)" :
    verdict === "unknown" ? `an unparseable version ("${runningVersion}")` :
    `v${runningVersion}`;
  return {
    stale: true,
    verdict,
    message:
      `Daemon on this port is running ${runningLabel}, but this plugin is v${pluginVersion}. ` +
      `A plugin update does NOT restart a running daemon, so it keeps serving old code — every shipped fix stays invisible until it restarts.`,
  };
}

/**
 * #136 — block until the daemon we SIGTERM'd is provably down: the process has
 * exited AND the port refuses connections, so the fresh spawn can rebind
 * without EADDRINUSE. Mirrors the e2e teardown barrier (e2e/daemon-harness.ts).
 * Bounded: SIGTERM's graceful path (releaseListenSocket → flush → exit) frees
 * the port fast, but a wedged daemon can't hang the wrapper — after the grace
 * window we escalate to SIGKILL once, then give the kernel a moment to reap.
 * Injectable clock/kill/probe keep it unit-testable with fakes.
 */
async function portRefusesConnections(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (refuses: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(refuses);
    };
    socket.once("connect", () => done(false));
    // Only an active refusal proves the port is free; any other error (or a
    // timed-out connect against a wedged accept backlog) is treated as
    // still-bound. The outer deadline bounds total wait, so pessimism is free.
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(err.code === "ECONNREFUSED" || err.code === "ECONNRESET"),
    );
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPortRelease(
  port: number,
  pid: number,
  opts: { graceMs?: number; killWaitMs?: number; kill?: (pid: number, sig: NodeJS.Signals) => void } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? 6000;
  const killWaitMs = opts.killWaitMs ?? 2000;
  const kill = opts.kill ?? ((p, s) => { try { process.kill(p, s); } catch { /* already gone */ } });

  const isDown = async (): Promise<boolean> =>
    pidIsGone(pid) && (await portRefusesConnections(port));

  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline) {
    if (await isDown()) return;
    await sleep(50);
  }
  // Graceful window elapsed — escalate ONCE to SIGKILL (bounded fallback), then
  // wait a little longer for the kernel to release the LISTEN slot.
  kill(pid, "SIGKILL");
  const killDeadline = Date.now() + killWaitMs;
  while (Date.now() < killDeadline) {
    if (await isDown()) return;
    await sleep(50);
  }
  // Give-up is silent-return (the caller falls through to spawn, which its own
  // waitForDaemon backstops); a leftover socket would surface there as a bind
  // rescan, not a wrapper hang.
}

/**
 * #136 — decide + act on a running daemon that matched OUR projectRoot. Returns
 * whether the caller should adopt `existing` as-is or fall through to spawn a
 * fresh daemon:
 *   - "adopt"     → version is same/newer, or we couldn't re-confirm the
 *                   daemon's identity (never kill what we can't identify).
 *   - "restarted" → the stale daemon was SIGTERM'd (graceful flush + port
 *                   release) and is gone; the caller must spawn fresh.
 *
 * Deps are injectable so the branching is testable with fakes (no real spawn /
 * real kill / real sockets). Defaults wire the production implementations.
 */
export async function resolveStaleDaemon(
  existing: DaemonInfo,
  myVersion: string,
  projectRoot: string,
  deps: {
    probeIdentity?: (port: number) => Promise<{ pid: number; projectRoot: string; startedAt: string; version?: string } | null>;
    kill?: (pid: number, sig: NodeJS.Signals) => void;
    waitForRelease?: (port: number, pid: number) => Promise<void>;
    log?: (msg: string) => void;
  } = {},
): Promise<"adopt" | "restarted"> {
  const probeIdentity = deps.probeIdentity ?? probeDaemonIdentity;
  const kill = deps.kill ?? ((p, s) => { try { process.kill(p, s); } catch { /* already gone */ } });
  const waitForRelease = deps.waitForRelease ?? ((port, pid) => waitForPortRelease(port, pid));
  const log = deps.log ?? (() => {});

  const verdict = classifyDaemonVersion(existing.version, myVersion);
  if (!verdictIsStale(verdict)) {
    if (verdict === "newer") {
      // Adopt but WARN — this plugin is older than the daemon it's talking to.
      // Killing would downgrade the user; two versions coexist legitimately.
      log(
        `[deepPairing] daemon on :${existing.port} is running v${existing.version} which is NEWER than this plugin (v${myVersion}); adopting it (a newer daemon serves a different project/terminal — refusing to downgrade).`,
      );
    }
    return "adopt";
  }

  // Stale (older/absent/unknown). Re-confirm identity over HTTP BEFORE any
  // SIGTERM: never kill a foreign daemon (different projectRoot) or a recycled
  // pid, and never kill a daemon we can't identify (probe failed ⇒ it may have
  // already died / glitched ⇒ fail-safe adopt, don't hang).
  const identity = await probeIdentity(existing.port);
  if (!identity) {
    log(
      `[deepPairing] daemon on :${existing.port} looked stale (v${existing.version ?? "absent"}) but its identity could not be re-confirmed; adopting rather than signalling an unidentified process.`,
    );
    return "adopt";
  }
  if (identity.pid !== existing.pid || identity.projectRoot !== projectRoot) {
    // Foreign or recycled — the projectRoot guard is the safety net that stops
    // us ever SIGTERM'ing another project's daemon.
    log(
      `[deepPairing] refusing to restart daemon on :${existing.port}: identity drifted since discovery ` +
      `(expected pid ${existing.pid} for ${projectRoot}, now pid ${identity.pid} for ${identity.projectRoot}). Adopting instead.`,
    );
    return "adopt";
  }

  // /api/daemon-info is AUTHORITATIVE (daemon.json can lag a same-second restart
  // — the process writes the file on startup, not atomically with the version
  // it serves). Re-classify against the live version so a daemon.json that
  // merely looked old can't trigger a false-positive kill of an already-current
  // daemon.
  const liveVerdict = classifyDaemonVersion(identity.version, myVersion);
  if (!verdictIsStale(liveVerdict)) {
    log(
      `[deepPairing] daemon on :${existing.port} looked stale in daemon.json (v${existing.version ?? "absent"}) but its live /api/daemon-info reports v${identity.version ?? "absent"} (${liveVerdict}); adopting — not restarting a current daemon.`,
    );
    return "adopt";
  }

  const runningLabel = identity.version ?? (liveVerdict === "absent" ? "pre-0.1.4 (no version)" : "unknown");
  log(
    `[deepPairing] daemon was running v${runningLabel}, plugin is v${myVersion} — restarting it. ` +
    `A running Node process keeps serving old code after a plugin update; every shipped fix would be invisible until this restart.`,
  );
  // SIGTERM triggers the daemon's graceful path (releaseListenSocket → flush
  // pending session state → exit 0), so no in-flight review data is lost.
  kill(existing.pid, "SIGTERM");
  await waitForRelease(existing.port, existing.pid);
  return "restarted";
}

/**
 * Ensure the daemon is running. If not, spawn it and wait for readiness.
 * Returns the daemon's port number.
 */
export async function ensureDaemon(projectRoot: string): Promise<DaemonInfo> {
  // A1: probe before spawn — adopts a live daemon even if daemon.json is missing.
  // II1 — returns DaemonInfo (not just port) so the caller can pick up
  // the authToken needed to talk to /api/internal/*. Old `: number` return
  // shape was a strict subset of what wrappers need now.
  const existing = await isDaemonRunning(projectRoot);
  if (existing) {
    // #136 — version-gate the adoption. A plugin update leaves a NEW MCP
    // subprocess reattaching to the OLD daemon still on the port; without this
    // check it would serve pre-fix behavior indefinitely. resolveStaleDaemon
    // adopts same/newer (fast path), and SIGTERM-restarts older/absent after
    // confirming the daemon is really ours.
    const outcome = await resolveStaleDaemon(existing, SERVER_VERSION, projectRoot, { log: logStale });
    if (outcome === "adopt") return existing;
    // "restarted" — the stale daemon is down + its port is free; fall through
    // to spawn a fresh one below.
  }

  // Spawn daemon
  const { stderrTail } = spawnDaemon(projectRoot);

  // Wait for it to be ready
  try {
    return await waitForDaemon(projectRoot);
  } catch (err: any) {
    const tail = stderrTail().trim();
    if (tail) {
      throw new Error(`${err.message}\nDaemon stderr:\n${tail}`);
    }
    throw err;
  }
}
