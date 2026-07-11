#!/usr/bin/env node
/**
 * deepPairing Daemon — shared HTTP/WebSocket server (ENTRY).
 *
 * Spawned by the first MCP wrapper process as a detached background process.
 * Manages multiple sessions, serves the companion web UI, and broadcasts
 * events to connected browsers via WebSocket.
 *
 * Auto-shuts down after 60s of zero sessions + zero WebSocket clients.
 *
 * #157 — this file is deliberately thin: the COMPOSITION (guards → routes →
 * static UI, WS upgrade auth, watcher/heartbeat/ping/auto-open wiring) lives
 * in the importable factory `create-daemon.ts` so it is testable without
 * spawning a process. What stays here is exactly the process-owned surface:
 * env/args parsing, the log file, the port bind loop, signal handlers,
 * process.exit, and the process-level error guards. Startup ordering below
 * mirrors the pre-extraction script line-for-line.
 */

import { serve } from "@hono/node-server";
import type { WebSocketServer } from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runDaemonStartupSetup } from "../cli/setup-tasks.js";
import { flushAllMetrics } from "../store/metrics-store.js";
import { preferredPortFor, BASE_PORT, PORT_SPAN } from "../project-root.js";
import { createDaemon } from "./create-daemon.js";

const MAX_PORT_ATTEMPTS = 10;
const projectRoot = process.env.DEEPPAIRING_PROJECT_ROOT ?? process.cwd();
const dpDir = path.join(projectRoot, ".deeppairing");
const logFile = path.join(dpDir, "daemon.log");
const startedAt = new Date().toISOString();
// II1 — shared secret minted at daemon startup. Written into daemon.json
// (mode 0600, by the factory's writeDaemonInfo) so only the same uid can read
// it. DaemonClient picks it up via daemon-lifecycle.readDaemonInfo and stamps
// it on every `/api/internal/*` request as `Authorization: Bearer <token>`.
// Other local processes that can't read the file get a 401.
const daemonAuthToken = crypto.randomBytes(32).toString("hex");

// --- Logging ---

// III7 — daemon.log rotation. Pre-III7 the log was an unbounded
// appendFileSync that, on long-lived dev boxes, accumulated MB of
// per-status-mutation breadcrumbs (header.sid, store.sid, artifactId,
// fromStatus, toStatus, reason). Same-uid attackers (and accidental
// `cat ~/.deeppairing/daemon.log` snapshots in screenshots/screencasts)
// got a full trace of the user's review activity. Rotate at 1 MB with
// 3 keep-files so the log stays useful for post-mortems without
// growing unbounded. Pure janitorial — no behavior change.
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_FILES = 3;

function maybeRotateLog(): void {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < LOG_MAX_BYTES) return;
    // Roll: daemon.log.2 → drop; daemon.log.1 → daemon.log.2; daemon.log → daemon.log.1
    for (let i = LOG_KEEP_FILES - 1; i >= 1; i--) {
      const src = i === 1 ? logFile : `${logFile}.${i - 1}`;
      const dst = `${logFile}.${i}`;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch {}
    }
  } catch {
    // statSync may ENOENT on first write — that's fine, nothing to rotate.
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [daemon] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    maybeRotateLog();
    fs.appendFileSync(logFile, line);
  } catch {}
}

// --- Graceful shutdown / prompt port release (I5) ---
//
// `httpServer` (the @hono/node-server accept socket) is created inside main(),
// but THREE exit paths need to close it: the SIGINT/SIGTERM handlers here, the
// idle auto-shutdown timer, and the AA3 evict route (both inside the factory,
// which receives `releaseListenSocket` as a dep). The handles are mirrored
// here at module scope so all paths reach them.
//
// Root cause (I5): every exit path did `cleanup(); process.exit(0)` and NEVER
// called server.close(). The LISTEN socket therefore stayed bound through
// cleanup()'s synchronous per-session forceFlush loop, only releasing when the
// process actually exited. A fast-follow binder — the multi-project port
// window, a restart, a `doctor` probe, or the e2e teardown barrier — hit
// EADDRINUSE during that window and rescanned/degraded. Closing the accept
// socket FIRST frees the port immediately; the flush + exit then run while the
// next daemon is already free to bind.
let httpServer: ReturnType<typeof serve> | null = null;
let wsServer: WebSocketServer | null = null;
let shuttingDown = false;

/**
 * I5 — release the accept socket ASAP. `httpServer.close()` stops *accepting*
 * new connections immediately (in-flight requests drain on their own, and
 * already-upgraded WS connections stay alive), which frees the LISTEN port for
 * the next binder even while cleanup() is still flushing. httpServer is the
 * ONLY thing holding the port: wss is noServer:true, so it owns no LISTEN
 * socket — the upgrade path is wired onto httpServer's "upgrade" event, which
 * close() also tears down.
 *
 * Fire-and-forget: we deliberately do NOT await the close callback — the point
 * is prompt port release, then a synchronous flush + exit. Safe to call more
 * than once (a second SIGTERM, or exit-after-evict): close() on an already-
 * closed server just invokes its callback with an error we ignore.
 *
 * `closeWs` defaults true: stop the WS server ACCEPTING new upgrades before we
 * exit. Note wss is noServer:true, so close() does NOT terminate connected
 * clients — the synchronous process.exit(0) that follows drops their sockets.
 * The AA3 evict path passes false: it just broadcast `daemon_evicting` and
 * holds a 250ms grace so those frames reach the wire — stopping the WS server
 * would still let the grace run, but leaving it fully alone keeps the intent
 * obvious. Either way, freeing the HTTP port is what releases the LISTEN
 * socket for the next binder; the WS server owns no listen socket of its own.
 */
function releaseListenSocket({ closeWs = true }: { closeWs?: boolean } = {}): void {
  try { httpServer?.close?.(); } catch {}
  if (closeWs) {
    try { wsServer?.close?.(); } catch {}
  }
}

// --- Composition root ---
//
// The factory builds the app + WS server + all wiring at IMPORT time (exactly
// like the pre-#157 module-scope script did); main() below only binds the
// port and starts the periodic machinery. The process-level seams
// (exitProcess, releaseListenSocket) are passed in HERE — the factory itself
// never calls process.exit, so tests can build daemons safely.
const daemon = createDaemon({
  projectRoot,
  authToken: daemonAuthToken,
  log,
  startedAt,
  exitProcess: (code) => process.exit(code),
  releaseListenSocket,
});
// I5 — mirror the WS server handle for releaseListenSocket (created by the
// factory; assigned before any exit path can run).
wsServer = daemon.wss;

/**
 * I5 — unified signal handler. Release the LISTEN socket FIRST (so the next
 * binder isn't blocked by our flush), then run the existing cleanup + exit.
 * The `shuttingDown` guard makes a second signal a no-op instead of double-
 * closing / double-flushing.
 */
function gracefulShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (${signal})`);
  releaseListenSocket();
  daemon.cleanup();
  process.exit(0);
}

// --- Auto-shutdown cadence ---
// Check every 30s (the 60s idle timer itself lives in the factory's
// checkAutoShutdown, which is also re-triggered by WS client closes).
setInterval(() => daemon.checkAutoShutdown(), 30000);

// --- Start server ---

async function main() {
  log(`Daemon starting (PID ${process.pid})`);
  log(`Project root: ${projectRoot}`);

  // III4 — process-level error guards. II5 added per-ws + wss error
  // listeners, but the daemon process itself had zero global async-error
  // safety net. A single rejected promise anywhere — `broadcastNewFires`
  // when `fs.watch` callback throws on a macOS APFS rename, install-health
  // ping fetch failures, the demo-script broadcast — exits the daemon
  // with the same "daemon mysteriously died overnight" symptom II5 was
  // supposed to close. The wrapper has no auto-respawn for that mode.
  //
  // unhandledRejection: log + continue. Most rejections we'd see here are
  // best-effort fire-and-forget side effects (broadcast taps, fetch
  // probes) where the user-visible work has already succeeded; killing
  // the daemon over them would be worse than swallowing them.
  //
  // IV5 — rate-limit counter. The III4 TODO landed here: if rejections
  // fire >100/min, something is structurally wrong (probably a stuck
  // fs.watch callback or a broadcast loop) and silent log-and-continue
  // is doing more harm than good. Above threshold, exit(1) so the
  // wrapper sees the crash and the user reaches for doctor.
  //
  // uncaughtException: log + exit(1). These are programmer-error throws
  // on the synchronous path; the daemon's invariants are no longer
  // trustworthy. Better to die loudly than to limp on with half-updated
  // state.
  const REJECTION_THRESHOLD = 100;
  const REJECTION_WINDOW_MS = 60_000;
  const rejectionTimes: number[] = [];
  // SP3 — persist any debounced-but-unflushed metrics on a clean exit. Covers
  // every process.exit() path: idle auto-shutdown, cooperative AA3 evict, the
  // fatal handlers below, AND SIGTERM/SIGINT (both route through
  // process.exit(0)). Synchronous (writeJsonAtomic), so it's safe in an 'exit'
  // listener. Only SIGKILL/SIGHUP/power-loss bypass it, losing <1s of counts —
  // accepted for non-critical display telemetry. (A genuinely-concurrent second
  // daemon — port-collision/sleep-handoff — can clobber a flush batch, but the
  // cooperative evict flushes+exits before handoff, so only true concurrent
  // writers lose updates, a class that predates SP3.)
  process.on("exit", () => {
    try { flushAllMetrics(); } catch {}
  });
  process.on("unhandledRejection", (reason: any) => {
    const msg = reason?.stack ?? reason?.message ?? String(reason);
    log(`[unhandledRejection] ${msg}`);
    const now = Date.now();
    rejectionTimes.push(now);
    // Trim out anything older than the window. O(n) trim is fine —
    // n caps at the threshold so this is bounded.
    // `!` safe: the length check in the same condition guarantees [0] exists.
    while (rejectionTimes.length && now - rejectionTimes[0]! > REJECTION_WINDOW_MS) {
      rejectionTimes.shift();
    }
    if (rejectionTimes.length >= REJECTION_THRESHOLD) {
      log(`[unhandledRejection] FATAL: ${REJECTION_THRESHOLD} rejections in ${REJECTION_WINDOW_MS}ms — structural error, exiting so the wrapper can respawn cleanly.`);
      process.exit(1);
    }
  });
  process.on("uncaughtException", (err) => {
    log(`[uncaughtException] FATAL: ${err?.stack ?? err?.message ?? err}`);
    // Flush daemon.log synchronously before exit so the post-mortem has
    // the trace. We rely on log()'s appendFileSync being synchronous.
    process.exit(1);
  });

  // N2.2: plugin install path doesn't run `npx deeppairing init`, so the
  // daemon picks up the slack: ensure .deeppairing/, .gitignore entry, and
  // Stop hook. CLAUDE.md mutation stays opt-in via init — too invasive to
  // do silently from a backgrounded MCP server.
  for (const result of runDaemonStartupSetup(projectRoot)) {
    if (!result.ok) {
      log(`Setup task warning: ${result.message}`);
    } else if (result.changed) {
      log(`Setup task: ${result.message}`);
    }
  }

    // N2.1: probe sequential ports on EADDRINUSE so multiple projects can run
    // concurrent daemons (project A on 3847, project B on 3848, …). The bound
    // port is then written into daemon.json so each project's wrapper connects
    // to the right daemon.
    const preferredPort = preferredPortFor(projectRoot);
    let port = preferredPort;
    let server: ReturnType<typeof serve> | null = null;
    let lastBindErr: any = null;
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      // Start at this project's deterministic preferred port, then probe
      // forward within the [BASE_PORT, BASE_PORT+PORT_SPAN) window (wrapping)
      // so a collision/squatter degrades to the next free slot without
      // escaping the reserved range.
      const candidate = BASE_PORT + (((preferredPort - BASE_PORT) + attempt) % PORT_SPAN);
      // GG1 — bind 127.0.0.1 explicitly. Pre-GG1 the call omitted
      // `hostname` and the underlying @hono/node-server passed undefined
      // to server.listen, which Node interprets as "all interfaces"
      // (0.0.0.0). Combined with the WS upgrade handler (GG2 fixes that
      // separately) this exposed the daemon to anyone on the local
      // network — every artifact, comment, and trace was reachable
      // from a sibling laptop on the same wifi. Comments throughout
      // this file claimed localhost-only; now the code matches.
      const candidateServer = serve({ fetch: daemon.app.fetch, port: candidate, hostname: "127.0.0.1" });
      const result = await new Promise<{ ok: true } | { ok: false; err: any }>((resolve) => {
        const s: any = candidateServer;
        const onError = (err: any) => {
          s.off?.("listening", onListening);
          resolve({ ok: false, err });
        };
        const onListening = () => {
          s.off?.("error", onError);
          resolve({ ok: true });
        };
        if (typeof s.once === "function") {
          s.once("error", onError);
          s.once("listening", onListening);
        } else {
          // Fallback for environments where listening fires before we subscribe.
          setTimeout(() => resolve({ ok: true }), 50);
        }
      });

      if (result.ok) {
        server = candidateServer;
        httpServer = candidateServer; // I5 — expose the accept socket to the module-scope shutdown paths
        port = candidate;
        daemon.setBoundPort(candidate); // MP1 — expose to route handlers (/api/projects isSelf)
        if (attempt > 0) log(`Preferred port ${preferredPort} busy — bound to ${candidate} instead (recorded in daemon.json).`);
        break;
      }
      lastBindErr = result.err;
      if (result.err?.code !== "EADDRINUSE") {
        log(`FATAL bind error on port ${candidate}: ${result.err}`);
        // U6 — point users at the recovery command in every fatal stderr.
        process.stderr.write(
          `deepPairing daemon: bind failed — ${result.err?.message ?? result.err}\n` +
          `Run \`npx deeppairing doctor --fix\` to diagnose and heal common causes.\n`,
        );
        process.exit(3);
      }
      // Close the failed server before trying the next port.
      try { (candidateServer as any).close?.(); } catch {}
    }

    if (!server) {
      // U6 — `--fix` so the user gets the heal-it path, not just the diagnose-it one.
      const msg = `No free port in ${MAX_PORT_ATTEMPTS} slots from this project's preferred ${preferredPort} (range ${BASE_PORT}–${BASE_PORT + PORT_SPAN - 1}). Last error: ${lastBindErr?.message ?? lastBindErr}. Run \`npx deeppairing doctor --fix\` to diagnose and heal.`;
      log(`FATAL: ${msg}`);
      process.stderr.write(`deepPairing daemon: ${msg}\n`);
      process.exit(2);
    }

    // GG2 — the authed WS upgrade path (Origin + fail-closed X-Project-Hash)
    // rides the accept socket's "upgrade" event; the checks themselves live in
    // the factory so they're testable against a real socket.
    daemon.attachUpgradeHandler(server);

    // A2: write daemon.json on startup AND on a recurring heartbeat so a
    // missing/stale info file self-heals without user intervention.
    //
    // STARTUP/PERIODIC FATALITY ASYMMETRY (H1-3, reviewed twice — preserve!):
    // this startup call is deliberately UNWRAPPED — writeDaemonInfo throws on
    // a boot-time write failure and main().catch exits loudly (a daemon that
    // can't write its discovery file on boot is useless). The PERIODIC ticks
    // inside daemon.startHeartbeat are wrapped in safeHeartbeatTick (log +
    // continue + H2-3 escalation) so a transient ENOSPC at a 30s tick can't
    // kill a healthy daemon.
    daemon.writeDaemonInfo(port);
    daemon.startHeartbeat(port);

    // X7 — hooks-state watcher (through guardWatcher — see factory).
    daemon.startHooksWatcher();

    log(`Daemon running on http://localhost:${port}`);

    // H4/#152 — auto-open the companion UI (env-gated; see factory).
    daemon.maybeAutoOpenBrowser(port);

    // R4 — opt-in install-health ping (env-gated; see factory).
    daemon.scheduleInstallHealthPing();

  // Graceful shutdown
  process.on("exit", () => daemon.cleanup());
  // I5 — gracefulShutdown closes the LISTEN socket BEFORE the flush (prompt
  // port release for the next binder), guards against a double signal, and
  // preserves the existing "Shutting down (SIG…)" log + exit-0.
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
