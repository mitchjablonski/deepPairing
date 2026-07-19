/**
 * deepPairing Daemon composition root — the importable factory (#157).
 *
 * Extracted from daemon/index.ts, which was a ~1200-line entry SCRIPT that
 * exported nothing — so no vitest test could import the wiring, and a
 * mutation audit proved it: deleting the #136 version gate, the H1-2/H1-3
 * crash guards, the #151 live-decisions closure, and the GG2 WS-upgrade auth
 * each shipped with the full suite green. This factory owns the COMPOSITION
 * (guards → routes → static UI, the WS upgrade/connection handlers, the
 * watcher/heartbeat/ping/auto-open wiring) so tests can drive the real thing.
 *
 * What deliberately does NOT live here (see daemon/index.ts):
 *   - the port bind loop / listen socket (tests use app.fetch or port 0);
 *   - signal handlers and process.exit (`exitProcess` and
 *     `releaseListenSocket` are REQUIRED deps precisely so a factory-built
 *     daemon can never kill a test runner or hold a runner's port);
 *   - the process-level unhandledRejection/uncaughtException guards.
 *
 * This is a mechanical extraction: the moved code (and its review-history
 * comments) is unchanged except for dependency threading. Ordering that
 * matters — top-level guards BEFORE any sub-app mount, /api routes BEFORE the
 * static-UI catch-all — is preserved exactly and commented at each site.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import { spawn } from "node:child_process";
import { ERROR_CODES } from "../error-codes.js";
import { FileStore } from "../store/file-store.js";
import type { LiveDecisionSource } from "../store/session-scan.js";
import { createHttpRoutes } from "../http/routes.js";
import { mountStaticUi } from "../http/static-ui.js";
import { createDaemonRoutes, createActiveSessionRoutes, type SessionMeta } from "./routes.js";
import { applyTopLevelGuards } from "../http/guards.js";
import { runDemoScript } from "../demo-script.js";
import { recordMetricEvent } from "../store/metrics-store.js";
import { recordBroadcastMetric } from "../store/metrics-tap.js";
import { buildPingPayload, decidePing, sendPing } from "../ping.js";
import { SERVER_VERSION } from "../version.js";
import {
  fsHonorsPosixMode,
  tokenPlacement,
  writeTokenSidecar,
  unlinkTokenSidecar,
} from "./token.js";
// AA4 — projectHash is the deterministic short identity advertised on
// /api/daemon-info + the WS `connected` event. The browser echoes it
// back in `X-Project-Hash` and any per-session route 403s on mismatch,
// closing the stale-tab-after-port-recycling write hole.
import { projectHashOf, BASE_PORT, PORT_SPAN } from "../project-root.js";
import { corsAllowedOrigin, isAllowedWsOrigin } from "../http/origin-policy.js";
import {
  guardWatcher,
  safeHeartbeatTick,
  type HeartbeatState,
  type ErrorEmittingWatcher,
} from "./watchdog.js";
import { shouldAutoOpenBrowser } from "./auto-open.js";
import { writeJsonAtomic } from "../store/atomic-write.js";

/**
 * Cross-platform "open URL in default browser" without pulling in an npm
 * dep. macOS = open, Linux = xdg-open, Windows = start. Best-effort: failure
 * is logged but non-fatal.
 */
async function defaultOpenBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {}); // swallow spawn errors (e.g. xdg-open missing on headless Linux)
  child.unref();
}

/** Minimal structural type for the accept socket the upgrade handler rides —
 *  matches how index.ts always called it: `(server as any).on?.("upgrade", …)`. */
export interface UpgradeCapableServer {
  on?: (event: "upgrade", cb: (request: unknown, socket: unknown, head: unknown) => void) => unknown;
}

export interface CreateDaemonDeps {
  /** The project this daemon serves — everything (store paths, projectHash,
   *  daemon.json, hooks watcher) derives from it. */
  projectRoot: string;
  /** II1 — shared secret minted by the ENTRY (index.ts) at startup; the
   *  factory only wires it into the routes + daemon.json/static-UI injection. */
  authToken: string;
  log: (msg: string) => void;
  /**
   * Process seam — REQUIRED (no default) so constructing a daemon in a test
   * can never kill the test runner. index.ts passes process.exit; every exit
   * the FACTORY initiates (idle auto-shutdown, the AA3 evict route) goes
   * through this. Signal handlers stay in index.ts entirely.
   */
  exitProcess: (code: number) => void;
  /**
   * I5 seam — frees the LISTEN socket. The accept socket is created by
   * index.ts's bind loop (the factory never listens), so releasing it is the
   * entry's job; the factory calls this on its own exit paths (idle shutdown,
   * evict) so the port frees BEFORE the flush, exactly as before.
   */
  releaseListenSocket: (opts?: { closeWs?: boolean }) => void;
  /** Daemon start timestamp; index.ts stamps it once at import time. */
  startedAt?: string;
  /** Env consulted by the auto-open (#152) and install-health-ping (R4)
   *  GUARDS — injectable so the guard call sites are testable. */
  env?: NodeJS.ProcessEnv;
  /**
   * #136 — the version this daemon advertises (daemon.json, /api/daemon-info,
   * the R4 ping). Defaults to SERVER_VERSION; overriding it exists ONLY so the
   * version-gate regression test can spawn a REAL daemon that serves an old
   * version (a genuinely old build can't be spawned from current source).
   * Production (index.ts) never passes it.
   */
  version?: string;
  /** H4 — browser opener; injectable so the #152 guard test can observe calls. */
  openBrowser?: (url: string) => Promise<void>;
  /** X7/H1-2 — hooks-dir watcher factory; defaults to fs.watch. Injectable so
   *  the guardWatcher wiring test can hand in a fake (real EventEmitter). */
  watch?: (
    dir: string,
    listener: (event: string, filename: string | Buffer | null) => void,
  ) => ErrorEmittingWatcher;
  /** A2 heartbeat cadence — 30s in production; tests shrink it. */
  heartbeatIntervalMs?: number;
}

export interface Daemon {
  /** The fully-composed Hono app (guards → internal → public → root routes → static UI). */
  app: Hono;
  /** The WS server (noServer: true — it owns no LISTEN socket; see I5). */
  wss: WebSocketServer;
  /** GG2 — wires the authed upgrade path onto the entry's accept socket. */
  attachUpgradeHandler: (server: UpgradeCapableServer) => void;
  /** MP1 — index.ts reports the port its bind loop actually won. */
  setBoundPort: (port: number) => void;
  createSession: (sessionId: string) => FileStore;
  sessions: Map<string, FileStore>;
  sessionMeta: Map<string, SessionMeta>;
  activeSessions: Set<string>;
  broadcast: (sessionId: string, event: unknown) => void;
  broadcastAll: (event: unknown) => void;
  getClientCount: () => number;
  checkAutoShutdown: () => void;
  /** THROWS on failure — the STARTUP call in index.ts stays fatal (main().catch);
   *  only the periodic heartbeat wraps it in safeHeartbeatTick. */
  writeDaemonInfo: (port: number) => void;
  /** H1-3 — periodic daemon.json rewrite through safeHeartbeatTick. */
  startHeartbeat: (port: number) => ReturnType<typeof setInterval>;
  /** X7 + H1-2 — hooks-state watcher through guardWatcher. */
  startHooksWatcher: () => void;
  /** H4/#152 — auto-open gated on shouldAutoOpenBrowser(env). */
  maybeAutoOpenBrowser: (port: number) => void;
  /** R4 — install-health ping gated on decidePing(env). */
  scheduleInstallHealthPing: () => void;
  /** Flush every session + remove daemon.json and the III9 token sidecar. */
  cleanup: () => void;
  /** Test teardown ONLY (production exits the process instead): clears the
   *  factory's timers/watcher and closes the WS server so a suite doesn't
   *  leak handles. Never called by index.ts. */
  dispose: () => void;
}

export function createDaemon(deps: CreateDaemonDeps): Daemon {
  const {
    projectRoot,
    authToken: daemonAuthToken,
    log,
    exitProcess,
    releaseListenSocket,
    startedAt = new Date().toISOString(),
    env = process.env,
    version = SERVER_VERSION,
    openBrowser = defaultOpenBrowser,
    watch = (dir, listener) => fs.watch(dir, listener),
    heartbeatIntervalMs = 30_000,
  } = deps;

  const daemonProjectHash = projectHashOf(projectRoot);
  // MP1 — the actual bound port, set once index.ts's bind loop succeeds.
  // Factory-scoped so route handlers defined before the server starts can read
  // it at call time (e.g. /api/projects, to mark which discovered daemon is self).
  let boundPort = 0;
  const dpDir = path.join(projectRoot, ".deeppairing");
  const daemonInfoFile = path.join(dpDir, "daemon.json");

  // --- Session management ---

  const sessions = new Map<string, FileStore>();
  const sessionMeta = new Map<string, SessionMeta>();
  // C-3 — sessions with a LIVE registered wrapper (added on /register, removed
  // on /unregister), distinct from the `sessions` data map which is retained
  // after unregister so the UI can keep reading. Idle-shutdown keys on this set
  // + the client count; `sessions.size` is monotonic and never reaches 0, which
  // is why the daemon used to leak a process per project forever.
  const activeSessions = new Set<string>();

  function createSession(sessionId: string): FileStore {
    log(`Creating session: ${sessionId}`);
    const store = new FileStore(projectRoot, sessionId);
    sessions.set(sessionId, store);
    // R1: count session starts so "N sessions deep" stats become real.
    // Demo sessions are excluded — they're throwaway proof of the hook,
    // not pairing work worth measuring.
    if (!sessionId.startsWith("demo_")) {
      try { recordMetricEvent(projectRoot, { kind: "session_started" }); } catch {}
    }
    return store;
  }

  // U0.6 — Default session resolver for the public web UI. Returns the first
  // active session if one exists; returns NULL otherwise. Crucially, this no
  // longer creates a session on demand — that was the source of orphan
  // `session_${Date.now()}` directories that appeared whenever the UI loaded
  // before any MCP wrapper had registered. Now: no wrapper, no session.
  function getDefaultStoreOrNull(): FileStore | null {
    const first = sessions.values().next().value;
    return first ?? null;
  }

  // --- Session-scoped WebSocket broadcast ---

  const wsClients = new Map<string, Set<WebSocket>>();
  // Also keep a global set for the "all sessions" view
  const globalClients = new Set<WebSocket>();

  // #168 — money-shot replay. The demo's hero moment (`preflight_blocked` at
  // t+5s) is a transient broadcast, NOT part of a session's persisted state, so
  // a tab opened after t+5s (the human clicks the printed URL a few seconds
  // late) reconnects, gets the artifact/ledger state via `connected`, and MISSES
  // the block toast — the entire point of the demo. We stash the last
  // preflight_blocked per DEMO session and replay it to any late-joining WS
  // client. Only demo sessions (throwaway) and only this one event type — real
  // pairing toasts are live signals we must never resurrect on reconnect.
  const demoReplayEvents = new Map<string, any>();

  function broadcast(sessionId: string, event: any): void {
    if (sessionId.startsWith("demo_") && event?.type === "preflight_blocked") {
      demoReplayEvents.set(sessionId, event);
    }
    const data = JSON.stringify({ ...event, sessionId });

    // Send to session-specific clients
    const sessionClients = wsClients.get(sessionId);
    if (sessionClients) {
      for (const ws of sessionClients) {
        try { ws.send(data); } catch { sessionClients.delete(ws); }
      }
    }

    // Send to global (all-sessions) clients
    for (const ws of globalClients) {
      try { ws.send(data); } catch { globalClients.delete(ws); }
    }

    // R1: local telemetry. Broadcast is the canonical point where every
    // daemon-side metric-worthy event passes through, so we tap it once here
    // (the pure mapping lives in store/metrics-tap.ts so it's unit-testable).
    try {
      recordBroadcastMetric(projectRoot, sessionId, event);
    } catch {
      // Telemetry must never break a broadcast.
    }
  }

  /**
   * B1 — broadcast an event to EVERY connected client exactly once. The naive
   * "loop sessions calling broadcast(sid, …)" pattern delivered N_sessions + 1
   * copies to each global (no-session) client — broadcast() already fans out to
   * globalClients — and recorded the metric N times. Session clients get the
   * event stamped with their own sessionId (matching the old per-session sends);
   * global clients get it once with sessionId: null.
   */
  function broadcastAll(event: any): void {
    for (const [sid, sessionClients] of wsClients) {
      const data = JSON.stringify({ ...event, sessionId: sid });
      for (const ws of sessionClients) {
        try { ws.send(data); } catch { sessionClients.delete(ws); }
      }
    }
    const globalData = JSON.stringify({ ...event, sessionId: null });
    for (const ws of globalClients) {
      try { ws.send(globalData); } catch { globalClients.delete(ws); }
    }
    try {
      recordBroadcastMetric(projectRoot, "__all__", event);
    } catch {
      // Telemetry must never break a broadcast.
    }
  }

  function getClientCount(): number {
    let count = globalClients.size;
    for (const clients of wsClients.values()) count += clients.size;
    return count;
  }

  // --- Auto-shutdown ---
  // (The 30s cadence `setInterval(checkAutoShutdown, 30000)` stays in
  // index.ts — timers that only exist to run forever belong to the entry.)

  let shutdownTimer: ReturnType<typeof setInterval> | null = null;

  // #168 — demo-aware idle grace. A `deeppairing demo` run creates a demo
  // session but registers NO wrapper (activeSessions stays empty) and, once the
  // CLI exits, holds NO WS client — so the plain idle check would shut the
  // daemon down 60s later and the printed URL would die (connection refused) if
  // the human clicked it even a minute late. We chose a SERVER-SIDE grace over
  // holding the CLI open: bug #168.2 requires the `demo` command to EXIT cleanly
  // (a foreground hold reintroduces exactly the pinned-loop feel we just fixed),
  // and the grace keeps the command's fire-and-forget shape while giving the
  // daemon a demo-aware lifetime. 10 minutes is comfortably longer than "click
  // the link I just printed" without leaking a daemon for the rest of the day.
  const DEMO_IDLE_GRACE_MS = 10 * 60_000;

  function demoGraceActive(nowMs = Date.now()): boolean {
    // Key off the `demo_` sessionId prefix — the same demo-session marker #193
    // established (FileStore.isDemoSession = sessionId.startsWith("demo_")) and
    // that the replay stash below and the /api/demo/run eviction already use.
    for (const [sessionId, meta] of sessionMeta.entries()) {
      if (!sessionId.startsWith("demo_")) continue;
      const createdAt = Date.parse(meta.registeredAt);
      if (Number.isNaN(createdAt)) continue;
      if (nowMs - createdAt < DEMO_IDLE_GRACE_MS) return true;
    }
    return false;
  }

  function checkAutoShutdown(): void {
    // #168 — while a freshly-created demo session is inside its grace window,
    // hold the daemon open even with no clients so a late click on the printed
    // URL still connects. The 30s cadence (index.ts) re-invokes this, so once
    // the grace expires the normal 60s idle shutdown proceeds on the next tick.
    if (activeSessions.size === 0 && getClientCount() === 0 && demoGraceActive()) {
      if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
      return;
    }
    if (activeSessions.size === 0 && getClientCount() === 0) {
      if (!shutdownTimer) {
        log("No active sessions or clients — will shut down in 60s if still idle");
        shutdownTimer = setTimeout(() => {
          // #168 — the callback MUST re-check the demo grace too, not just
          // idleness. A timer armed while idle can fire AFTER a `deeppairing
          // demo` run created an in-grace session in the intervening window
          // (warm-adopt path: no cold spawn, no WS client) — without this
          // check it would exitProcess(0) despite just printing "URL stays
          // live ~10 minutes". /api/demo/run also calls checkAutoShutdown() to
          // disarm this timer immediately, but this guard is the backstop for
          // any arm/fire race the eager disarm doesn't cover.
          if (activeSessions.size === 0 && getClientCount() === 0 && !demoGraceActive()) {
            log("Auto-shutting down (idle)");
            // I5 — same close gap as the signal handlers: free the port before
            // the flush so an incoming daemon can rebind immediately.
            releaseListenSocket();
            cleanup();
            exitProcess(0);
          }
          shutdownTimer = null;
        }, 60000);
      }
    } else if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
  }

  // --- Build the HTTP app ---

  const app = new Hono();

  // CORS for localhost
  app.use("/*", cors({
      // D5 — vscode-webview:// ONLY (see origin-policy.ts). Loopback-origin
      // reflection let any local web page read responses cross-origin —
      // including the served HTML with the injected bearer token.
      origin: (origin) => corsAllowedOrigin(origin) as unknown as string,
    }));

  // Top-level guards (body-size cap + DNS-rebinding Host check) applied to the
  // ROOT app BEFORE any sub-app mount, so coverage is order-independent rather
  // than depending on the sub-app middleware leaking upward by mount order.
  // The body cap MEASURES the stream (chunked-safe), unlike the prior
  // header-only check. See http/guards.ts. This call site is the ONLY 64KB cap
  // covering the root-level routes (/api/evict, /api/demo/run, the internal
  // routes) — regression-pinned by create-daemon.test.ts.
  applyTopLevelGuards(app, { maxBodyBytes: 64 * 1024 });

  // Mount internal daemon routes (for MCP wrappers).
  // II1 — pass authToken so every /api/internal/* requires Authorization.
  const daemonRoutes = createDaemonRoutes(sessions, sessionMeta, createSession, broadcast, log, projectRoot, daemonAuthToken, activeSessions);
  app.route("/", daemonRoutes);

  // Mount public web UI routes (for browser)
  // Pass a session-lookup function so each request routes to the correct store.
  // Returns null when no session matches AND none exist — routes treat null as
  // "no active session" rather than silently spawning one. This is the
  // U0.6 prevention layer: the UI can't accidentally create orphan sessions
  // just by loading localhost:3847 before Claude Code is up.
  const publicRoutes = createHttpRoutes(
    (sessionId?: string) => {
      if (sessionId) {
        const store = sessions.get(sessionId);
        // AA4 — when the browser explicitly sent X-Session-Id, NEVER fall
        // back to the default store. Pre-AA4 a stale-tab sessionId from a
        // pre-restart daemon would route into the new daemon's first
        // arbitrary session via getDefaultStoreOrNull. Now we return null
        // and the route degrades to the no_active_session response,
        // surfacing the desync instead of silently corrupting state.
        // The X-Project-Hash check (added to createHttpRoutes) catches
        // the cross-project case earlier with a louder 403; this is the
        // belt-and-suspenders for clients that don't yet send the hash.
        return store ?? null;
      }
      return getDefaultStoreOrNull();
    },
    projectRoot,
    (event, sessionId) => {
      // Session-scoped broadcast for public routes
      if (sessionId) {
        broadcast(sessionId, event);
      } else {
        // No-session fallback: one copy per client (the old loop-over-sessions
        // duplicated to global clients N times and multi-counted metrics).
        broadcastAll(event);
      }
    },
    log,
    // III5 — pass the daemon's bearer token so /api/prompts requires
    // Authorization. The browser receives this token via the
    // window.__deepPairingToken injection in the index.html serve path
    // (see static-serve block below).
    daemonAuthToken,
    // #151 — snapshot every registered session's IN-MEMORY decisions +
    // artifacts so GET /api/decisions reflects a decision the instant it is
    // recorded/resolved, not after the debounced flush lands on disk. The
    // `sessions` map deliberately retains stores after /unregister — those
    // in-memory copies are still at least as fresh as their files, so live-
    // wins-by-sessionId stays correct for them too. A single failing store is
    // skipped (that session falls back to the disk scan) rather than losing
    // the live view for every other session.
    (): LiveDecisionSource[] => {
      const out: LiveDecisionSource[] = [];
      for (const [sessionId, store] of sessions.entries()) {
        try {
          const state = store.getFullState();
          out.push({ sessionId, decisions: state.decisions, artifacts: state.artifacts });
        } catch (err) {
          log(`[decisions] live snapshot failed for ${sessionId}, using disk: ${err}`);
        }
      }
      return out;
    },
  );
  app.route("/", publicRoutes);

  // N2.1: daemon identity endpoint so multi-project clients can verify they're
  // adopting the right daemon before trusting a port (avoids cross-project
  // adoption when daemon.json has been deleted). Includes projectRoot + port.
  // MP1 — count items waiting on the human across ALL of this daemon's sessions.
  // This is exactly "your turn": draft reviewable artifacts you must Approve/
  // Revise/Reject/Dismiss. Mirrors the web lib/pending.ts rule so the cross-
  // project badge matches the in-app PendingBanner. Advertised on
  // /api/daemon-info so the discovery sweep can show a per-project "agent
  // waiting" count without the browser polling every daemon.
  //
  // A human's own unanswered question is deliberately NOT counted: that's the
  // AGENT's turn (you asked, it owes the answer), and TurnIndicator already
  // surfaces it as a violet "waiting on the agent" badge. Counting it here made
  // the "waiting on YOU" badge stay lit on something you can't action — see the
  // matching exclusion in lib/pending.ts.
  const PENDING_REVIEWABLE = new Set(["research", "spec", "plan", "decision", "code_change"]);
  function computeDaemonPendingCount(): number {
    let n = 0;
    for (const store of sessions.values()) {
      try {
        // PP4 — getArtifacts() is the in-memory array; getFullState() additionally
        // re-read preferences.json from disk per session (via getSessionMemory) +
        // ran getEngagementMetrics — all unused here, and this runs per
        // /api/daemon-info poll across every session.
        for (const a of store.getArtifacts()) {
          if (a.status === "draft" && PENDING_REVIEWABLE.has(a.type)) n++;
        }
      } catch { /* skip a store that can't render state */ }
    }
    return n;
  }

  app.get("/api/daemon-info", (c) => {
    // AA4 — projectHash is the value the browser must send back in
    // X-Project-Hash for any X-Session-Id'd request. Advertised here so a
    // future client can verify before sending mutations.
    // MP1 — pendingCount drives the cross-project "agent waiting" badge.
    // #136 — advertise the running daemon's SERVER_VERSION so a freshly-updated
    // wrapper's ensureDaemon can tell "this daemon is running OLD code" and
    // restart it instead of silently adopting the stale process. This is the
    // authoritative source (daemon.json mirrors it for a no-HTTP probe).
    return c.json({ pid: process.pid, projectRoot, projectHash: daemonProjectHash, startedAt, version, pendingCount: computeDaemonPendingCount() });
  });

  // MP1 (multi-project spike) — discover every live deepPairing daemon so the
  // SPA can offer a one-page project switcher. The browser can't quickly sweep
  // 128 ports itself, so the daemon does it server-side (reusing the same
  // probeDaemonIdentity used by `deeppairing list`) and returns the peers,
  // including itself. This is a read-only discovery endpoint (no session data),
  // so it's exempt from the X-Project-Hash gate like /api/daemon-info.
  // B1 — the sweep is expensive (PORT_SPAN=128 parallel probes, and every live
  // peer daemon answers /api/daemon-info), and every visible tab polls this
  // endpoint. Uncached that's ~1,500 socket attempts/min per tab, cross-traffic
  // multiplying across daemons. Cache the sweep daemon-side so all tabs share one
  // sweep per TTL window; a switcher badge lagging ≤15s is imperceptible.
  // D6 (P3) — TTL 35s > the 30s browser poll: review-caught, TTL == poll is a
  // knife-edge race (the cache is stamped at sweep COMPLETION; sub-second
  // sweeps made hit/miss a coin flip). 35s makes every poll deterministically
  // ride the cache (sweep cadence settles at 60s). Freshness where it matters
  // comes from the ?fresh=1 bypass the dropdown-open refresh sends.
  const PROJECTS_SWEEP_TTL_MS = 35_000;
  let projectsSweepCache: { at: number; payload: unknown } | null = null;
  // Single-flight: concurrent requests during a sweep share the same promise
  // instead of each launching their own 128-probe fan-out.
  let projectsSweepInFlight: Promise<unknown> | null = null;

  app.get("/api/projects", async (c) => {
    const fresh = c.req.query("fresh") === "1";
    // fresh=1 bypasses the TTL but still rides a <2s-old result — CORS blocks
    // cross-origin READS, not request execution, so without this floor a
    // drive-by page could force back-to-back 128-probe sweeps.
    const maxAge = fresh ? 2_000 : PROJECTS_SWEEP_TTL_MS;
    if (projectsSweepCache && Date.now() - projectsSweepCache.at < maxAge) {
      return c.json(projectsSweepCache.payload as any);
    }
    if (!projectsSweepInFlight) {
      projectsSweepInFlight = sweepProjects().finally(() => {
        projectsSweepInFlight = null;
      });
    }
    const payload = await projectsSweepInFlight;
    return c.json(payload as any);
  });

  async function sweepProjects(): Promise<unknown> {
    const { probeDaemonIdentity } = await import("./lifecycle.js");
    const probes: Array<Promise<{ port: number; identity: any | null }>> = [];
    for (let port = BASE_PORT; port < BASE_PORT + PORT_SPAN; port++) {
      probes.push(probeDaemonIdentity(port, 300).then((identity) => ({ port, identity })));
    }
    const results = await Promise.all(probes);
    const projects = results
      .filter((r) => r.identity !== null)
      .map((r) => {
        const root = r.identity!.projectRoot as string;
        const segs = root.split(/[\\/]/).filter(Boolean);
        return {
          projectRoot: root,
          projectHash: projectHashOf(root),
          port: r.port,
          label: segs[segs.length - 1] ?? root,
          isSelf: r.port === boundPort,
          // MP1 — per-project "agent waiting" count (from each peer's
          // /api/daemon-info). Drives the switcher badge + global indicator.
          pendingCount: typeof r.identity.pendingCount === "number" ? r.identity.pendingCount : 0,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const payload = { projects, selfPort: boundPort, selfHash: daemonProjectHash };
    projectsSweepCache = { at: Date.now(), payload };
    return payload;
  }

  // AA3 — cooperative shutdown endpoint. The doctor's project-mismatch
  // remediation calls this BEFORE falling back to SIGTERM, so the squatter
  // daemon can:
  //   - flush its in-memory metrics (reviewLatencies → metrics.json)
  //   - broadcast `daemon_evicting` to its WS clients (the OTHER project's
  //     companion UI knows it's about to lose its socket)
  //   - exit cleanly so its process supervisor doesn't auto-respawn
  //     immediately, giving this project's daemon a window to claim the port
  //
  // Guards:
  //   - Localhost-only (the daemon already binds 127.0.0.1, but explicit).
  //   - X-DeepPairing-Confirm-Pid must match this process's pid. Defends
  //     against an attacker on the local machine probing the port and
  //     issuing the call against a stale PID — they'd need the actual
  //     current pid, which they get from /api/daemon-info.
  app.post("/api/evict", async (c) => {
    const confirmPid = c.req.header("X-DeepPairing-Confirm-Pid");
    if (confirmPid !== String(process.pid)) {
      return c.json(
        { error: `Confirm-pid ${confirmPid ?? "(none)"} does not match daemon pid ${process.pid}`, code: ERROR_CODES.evict_pid_mismatch },
        403,
      );
    }
    log(`[evict] requested for pid=${process.pid} project=${projectRoot} — flushing + broadcasting + exiting`);
    // Broadcast to every active session so the OTHER project's UI can
    // surface a banner instead of just losing its WS connection.
    for (const sid of sessions.keys()) {
      broadcast(sid, { type: "daemon_evicting", reason: "evicted_by_doctor", projectRoot, pid: process.pid });
    }
    // I5 — release the HTTP LISTEN port NOW so THIS project's incoming daemon
    // (the doctor's project-mismatch remediation is racing to bind) doesn't hit
    // EADDRINUSE while we flush + hold the 250ms broadcast grace. closeWs:false —
    // the daemon_evicting frames above still need the WS clients open; freeing
    // the HTTP accept socket leaves already-upgraded connections untouched.
    releaseListenSocket({ closeWs: false });
    // Cleanup persists everything (forceFlush per session, including the
    // AA3 reviewLatencies → metrics.json round-trip).
    cleanup();
    // 250ms grace so broadcasts make it onto the wire before the process
    // dies. Fire the response first so the caller sees the success.
    evictTimer = setTimeout(() => exitProcess(0), 250);
    return c.json({ status: "evicting", pid: process.pid });
  });

  // O1a: skill-load detection. Two signals inform whether the agent is likely
  // wired up to actually call deepPairing tools:
  //   (a) Config signal — CLAUDE.md has the deepPairing marker, which means
  //       `npx deeppairing init` has run.
  //   (b) Runtime signal — any session has created an artifact recently, which
  //       proves the agent is picking up the pairing-protocol skill (since only
  //       MCP tool calls create artifacts).
  // Either signal flips `pairingProtocolSkillLikelyLoaded` to true. The UI uses
  // this to decide whether to show a "Claude isn't using deepPairing" banner.
  app.get("/api/skill-status", (c) => {
    const claudeMdPath = path.join(projectRoot, "CLAUDE.md");
    let claudeMdHasMarker = false;
    try {
      if (fs.existsSync(claudeMdPath)) {
        claudeMdHasMarker = fs.readFileSync(claudeMdPath, "utf-8").includes("<!-- deepPairing -->");
      }
    } catch {}

    // Runtime signal: scan live sessions for a recent artifact.
    const RECENT_WINDOW_MS = 10 * 60 * 1000;
    const now = Date.now();
    let recentArtifactActivity = false;
    let latestArtifactAt: string | null = null;
    for (const store of sessions.values()) {
      const artifacts = store.getArtifacts();
      for (const a of artifacts) {
        const t = new Date(a.createdAt).getTime();
        if (!Number.isFinite(t)) continue;
        if (!latestArtifactAt || t > new Date(latestArtifactAt).getTime()) {
          latestArtifactAt = a.createdAt;
        }
        if (now - t < RECENT_WINDOW_MS) {
          recentArtifactActivity = true;
        }
      }
    }

    const likely = claudeMdHasMarker || recentArtifactActivity;
    const evidence = likely
      ? claudeMdHasMarker
        ? recentArtifactActivity
          ? "CLAUDE.md carries the deepPairing marker AND the agent has created an artifact in the last 10 min"
          : "CLAUDE.md carries the deepPairing marker"
        : "the agent has created an artifact in the last 10 min (skill appears active)"
      : "no CLAUDE.md marker AND no artifact created in the last 10 min";

    return c.json({
      claudeMdHasMarker,
      recentArtifactActivity,
      latestArtifactAt,
      pairingProtocolSkillLikelyLoaded: likely,
      evidence,
    });
  });

  // P1: scripted demo session that proves the hook (concept-aware rejection
  // block) in under a minute. Creates a fresh session, walks it through a
  // rejection, then fires the hero preflight_blocked broadcast — all without
  // requiring Claude Code to be connected. This is the PMF-thesis validator:
  // a fresh-install user must SEE the block fire, not just read about it.
  app.post("/api/demo/run", (c) => {
    // S5 — bound demo-session minting. This route is intentionally unauthenticated
    // (the cold-clone hero demo), so a loop could otherwise accumulate unbounded
    // in-memory sessions. Evict the oldest demo sessions to keep at most a handful.
    const MAX_DEMO_SESSIONS = 5;
    const demoIds = Array.from(sessions.keys()).filter((id) => id.startsWith("demo_")).sort();
    while (demoIds.length >= MAX_DEMO_SESSIONS) {
      const oldest = demoIds.shift()!;
      sessions.delete(oldest);
      sessionMeta.delete(oldest);
      activeSessions.delete(oldest);
      demoReplayEvents.delete(oldest); // #168 — don't leak the stashed hero event
    }
    const sessionId = `demo_${Date.now()}`;
    const store = createSession(sessionId);
    sessionMeta.set(sessionId, {
      title: "deepPairing demo",
      project: "demo",
      registeredAt: new Date().toISOString(),
    });
    runDemoScript({ sessionId, store, broadcast });
    // #168 — disarm any idle-shutdown timer already armed before this request:
    // the new demo session is inside its grace, so the daemon must not shut
    // down. checkAutoShutdown() sees demoGraceActive() and clears the timer
    // immediately rather than letting it fire and no-op (which also relies on
    // the callback's own !demoGraceActive() backstop above).
    checkAutoShutdown();
    return c.json({ sessionId, startedAt: new Date().toISOString() });
  });

  // S1 — the two root-app session reads + their X-Project-Hash gate, factored into
  // a testable builder (see daemon-routes.ts). Without the gate, a stale tab on a
  // daemon serving a DIFFERENT project could read this project's session list +
  // full state. Mounted on "/" like the other route groups.
  app.route("/", createActiveSessionRoutes(sessions, sessionMeta, daemonProjectHash, activeSessions));

  // --- Serve static web UI ---
  // Extracted to http/static-ui.ts so the bootstrap-injection contract (the
  // II2.2/II2.3 seam) is testable without booting this server. Registered after
  // the /api routes so they win the match.

  const __thisDir = path.dirname(fileURLToPath(import.meta.url));
  // F4 — this file lives one level deep (src/daemon/ resp. dist/daemon/), same
  // depth as the old daemon/index.ts home of this block, so the path math is
  // unchanged. The FLAT bundle candidate (web/ beside daemon.js in
  // claude-plugin/server) is unchanged too — esbuild emits a single ESM file at
  // the server root and import.meta.url resolves to THAT file for all inlined
  // modules.
  // E1 — two layouts: monorepo dist (../dist/web from src/, i.e. dist/web from
  // the compiled file) and the self-contained plugin bundle (web/ BESIDE the
  // bundled daemon.js). Mirrors daemon-lifecycle's daemon.js spawn fallback.
  const monorepoWebDist = path.join(__thisDir, "../../dist/web");
  const webDistCandidates = [monorepoWebDist, path.join(__thisDir, "web")];
  const webDistPath = webDistCandidates.find((p) => fs.existsSync(p)) ?? monorepoWebDist;

  mountStaticUi(app, {
    webDistPath,
    authToken: daemonAuthToken,
    projectHash: daemonProjectHash,
    log,
  });

  // --- daemon.json / cleanup ---

  function cleanup(): void {
    // Flush all sessions
    for (const store of sessions.values()) {
      store.forceFlush();
    }
    // Remove daemon info file
    try { if (fs.existsSync(daemonInfoFile)) fs.unlinkSync(daemonInfoFile); } catch {}
    // III9 — and the token sidecar, if we relocated the token off a non-POSIX
    // project dir (no-op when the token lived in daemon.json).
    try { unlinkTokenSidecar(projectRoot); } catch {}
  }

  /** III3 — write `obj` to `file`, opening at mode 0600 so the TOCTOU window
   *  a chmod-after-write would leave never opens, then chmod defensively. Does
   *  NOT verify/throw on leaked bits — the caller decides where the secret-
   *  bearing file goes based on a measured FS-capability probe (III9). */
  function writeFile0600(file: string, obj: unknown): void {
    // H2-3 (#146) — was O_TRUNC + writeFileSync: NON-atomic. It truncated the
    // live file to 0 bytes FIRST, then wrote. An ENOSPC mid-write (the exact
    // failure the heartbeat guard now TOLERATES instead of exiting) left
    // daemon.json truncated to 0 bytes — dropping pid/port AND, where the token
    // lives in-repo, the authToken; DaemonClient's recovery re-read then
    // JSON.parse("")-threw. writeJsonAtomic writes a sibling temp then renames,
    // so a failed write leaves the previous valid file intact (never truncated).
    //
    // SECURITY: daemon.json can carry the bearer token, so it must be 0600. The
    // temp is created at mode 0600 BEFORE any content is written (a default-umask
    // temp then renamed would leak the token world-readable for the pre-rename
    // window, and rename preserves the SOURCE mode → the file would stay 0644).
    // O_EXCL|O_NOFOLLOW in the writer also preserves S1's refusal to follow a
    // pre-planted symlink at the (now random) temp path.
    writeJsonAtomic(file, obj, 2, { mode: 0o600 });
  }

  // III9 — token placement is decided once (the project dir's FS capability
  // can't change mid-process) and reused by every heartbeat write, so the
  // chmod probe runs a single time rather than every 30s.
  let tokenPlacementCached: "in-repo" | "sidecar" | null = null;
  function resolveTokenPlacement(): "in-repo" | "sidecar" {
    if (tokenPlacementCached) return tokenPlacementCached;
    tokenPlacementCached = tokenPlacement({
      platform: process.platform,
      // Windows mode bits are advisory; skip the probe and treat as in-repo.
      dirHonorsMode: process.platform === "win32" ? true : fsHonorsPosixMode(dpDir),
    });
    return tokenPlacementCached;
  }

  function writeDaemonInfo(port: number): void {
    // II1 — the bearer token lets DaemonClient call /api/internal/*. It must
    // land in a file only the same uid can read. III9 — WHERE that file lives
    // depends on whether the project's .deeppairing/ filesystem honors 0600.
    // #136 — stamp the running daemon's version into daemon.json so a wrapper's
    // ensureDaemon can read it WITHOUT an HTTP round-trip and decide whether to
    // adopt (same/newer) or restart (older/absent) the running daemon. Absence
    // of this field on a discovered daemon ⇒ pre-#136 build ⇒ definitely stale.
    const discovery = { pid: process.pid, port, startedAt, projectRoot, version };
    try {
      fs.mkdirSync(dpDir, { recursive: true });

      if (resolveTokenPlacement() === "in-repo") {
        // ext4/APFS/Windows — original path: token lives in daemon.json @0600.
        writeFile0600(daemonInfoFile, { ...discovery, authToken: daemonAuthToken });
        return;
      }

      // III9 — the project dir is non-POSIX (WSL /mnt/c v9fs, NFS, SMB, FUSE):
      // chmod won't stick, so daemon.json can't safely hold the token. Split
      // discovery (non-sensitive — pid/port/projectRoot, no secret) from the
      // secret, and relocate the token to a guaranteed-POSIX per-user runtime
      // file. The daemon now STARTS here instead of dying, and the token still
      // lands somewhere only this uid can read.
      writeFile0600(daemonInfoFile, discovery); // token-less; world-readable is fine
      const sidecar = writeTokenSidecar(projectRoot, { authToken: daemonAuthToken, pid: process.pid, port });
      if (sidecar.refused) {
        // S1 — the sidecar dir/file was a symlink or owned by another uid; we
        // fail-closed (didn't write the token) rather than leak it. Loud, because
        // benign setups don't hit this — the per-user runtime dir is 0700.
        log(`[token] SECURITY: refused to write the bearer token to ${sidecar.path} — the sidecar path is a symlink or owned by another user (possible token-capture attempt). Sidecar auth is unavailable until this is cleared.`);
        process.stderr.write(`[deepPairing daemon] SECURITY: token sidecar path ${sidecar.path} is unsafe (symlink/foreign-owned); refused to write.\n`);
      } else if (sidecar.honored) {
        // Log once (placement is decided once; heartbeats re-enter here but the
        // path doesn't change). Cheap and useful for `doctor` post-mortems.
        log(`[token] .deeppairing is non-POSIX (chmod 0600 ignored) — bearer token relocated to ${sidecar.path} (mode 0600). Discovery (pid/port) stays in .deeppairing/daemon.json.`);
      } else {
        // Even the runtime dir couldn't enforce 0600 (very unusual). Degrade,
        // don't die: same-uid is the whole trust boundary on a single-dev box.
        log(`[token] WARN: no filesystem here honors 0600 (token file ${sidecar.path} = mode ${sidecar.mode.toString(8)}). Continuing — the bearer token is readable by same-uid processes on this machine.`);
      }
    } catch (err: any) {
      // A genuine write failure (unwritable dir, full disk) — surface to stderr
      // too so the wrapper's process-supervision sees it on cold start.
      const msg = err?.message ?? String(err);
      log(`FATAL: writeDaemonInfo failed: ${msg}`);
      process.stderr.write(`[deepPairing daemon] FATAL: ${msg}\n`);
      throw err;
    }
  }

  // --- WebSocket server + authed upgrade path ---

  // WebSocket server (noServer: true — it rides index.ts's accept socket via
  // attachUpgradeHandler; it owns no LISTEN socket of its own, see I5).
  const wss = new WebSocketServer({ noServer: true });

  // GG2 — auth the WebSocket upgrade. Pre-GG2 the upgrade handler did
  // ZERO checks: no Origin, no X-Project-Hash, accepted any sessionId
  // from the URL. Combined with the (pre-GG1) 0.0.0.0 bind that meant
  // anyone on the LAN who guessed a sessionId got a real-time stream
  // of every artifact + comment + trace for that session. Even with
  // GG1's bind to 127.0.0.1, this is still defense-in-depth: a
  // malicious site the user visits could (with the right Origin) try
  // to upgrade against the daemon. Two checks:
  //   1. Origin must be missing (curl/test path) OR localhost.
  //      Browsers always send Origin on upgrade; cross-origin pages
  //      can't lie about it.
  //   2. X-Project-Hash query param (or header) must match the
  //      daemon's projectHash when the daemon was constructed with
  //      a projectRoot. Test fixtures without projectRoot get the
  //      back-compat path (no hash check).
  function attachUpgradeHandler(server: UpgradeCapableServer): void {
    server.on?.("upgrade", (request: any, socket: any, head: any) => {
      if (!request.url?.startsWith("/ws")) {
        socket.destroy();
        return;
      }
      // Origin guard. D5 — same-origin or vscode-webview ONLY: WebSocket
      // ignores CORS, so this check is the ONLY thing between a hostile page
      // on another loopback port and a live artifact stream. The old
      // any-loopback policy let exactly that page in.
      const origin = request.headers?.origin as string | undefined;
      if (!isAllowedWsOrigin(origin, request.headers?.host as string | undefined)) {
        log(`[ws-upgrade] reject: disallowed Origin "${origin ?? "<none>"}" (host=${request.headers?.host ?? "<none>"})`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      // Project-hash guard. Skip when the daemon wasn't constructed
      // with a projectRoot (test fixtures, plugin install with bad
      // cwd) — there's nothing to compare against.
      if (daemonProjectHash) {
        const url = new URL(request.url, "http://localhost");
        const sentHash =
          url.searchParams.get("projectHash") ||
          (request.headers?.["x-project-hash"] as string | undefined);
        // II2 — was back-compat-permissive: clients with no projectHash
        // fell through. Every shipped browser + the VSCode extension
        // now send it (HH1/HH4/HH5), so absence is now a signal of a
        // stale or hostile caller. Fail-closed.
        if (!sentHash || sentHash !== daemonProjectHash) {
          log(`[ws-upgrade] reject: project-hash ${sentHash ? "mismatch" : "missing"} (sent=${sentHash ?? "<none>"} daemon=${daemonProjectHash})`);
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
  }

  wss.on("connection", (ws, request) => {
    // Parse sessionId from query: /ws?sessionId=xxx
    const url = new URL(request.url ?? "/ws", "http://localhost");
    const sessionId = url.searchParams.get("sessionId");

    if (sessionId) {
      // Subscribe to a specific session
      let clients = wsClients.get(sessionId);
      if (!clients) { clients = new Set(); wsClients.set(sessionId, clients); }
      clients.add(ws);

      // Send session state on connect. U4 — include `daemonStartedAt` so
      // the client can detect a daemon-restart on reconnect (a different
      // daemon process means stale in-memory state, force re-hydrate).
      const store = sessions.get(sessionId);
      if (store) {
        // AA4 — include projectHash so the browser can echo it in
        // X-Project-Hash and the per-session routes can verify.
        ws.send(JSON.stringify({ type: "connected", state: store.getFullState(), projectRoot, projectHash: daemonProjectHash, daemonStartedAt: startedAt }));
      }

      // #168 — replay the demo's hero `preflight_blocked` to a late joiner. A
      // client that connected BEFORE t+5s never has a replay stashed yet (it
      // gets the live broadcast instead), so this can't double-fire the toast;
      // one connecting AFTER gets it here and the demo's point survives. The
      // `replayed` flag is informational — the UI keys on `type`.
      if (sessionId.startsWith("demo_")) {
        const replay = demoReplayEvents.get(sessionId);
        if (replay) {
          ws.send(JSON.stringify({ ...replay, sessionId, replayed: true }));
        }
      }

      // II5 — handle 'error' before 'close'. An RSV1 framing error, an
      // EPIPE on a half-open client, or a slow consumer all emit 'error'
      // first; with no listener the EventEmitter throws and crashes the
      // daemon process. The wrapper has no auto-respawn for that mode.
      // Always pair: error → log + force-close so the 'close' handler
      // runs the standard cleanup path.
      ws.on("error", (err: any) => {
        log(`[ws] session client error (session=${sessionId}): ${err?.code ?? err?.message ?? err}`);
        try { ws.terminate(); } catch {}
      });
      ws.on("close", () => {
        clients!.delete(ws);
        if (clients!.size === 0) wsClients.delete(sessionId);
        checkAutoShutdown();
      });
    } else {
      // Global client — sees all sessions
      globalClients.add(ws);

      // Send list of active sessions
      const sessionList = Array.from(sessions.entries()).map(([id, store]) => ({
        sessionId: id,
        artifactCount: store.getArtifacts().length,
      }));
      // U4 — include `daemonStartedAt` so global clients also detect a
      // daemon restart and re-hydrate session listings on reconnect.
      ws.send(JSON.stringify({ type: "connected", sessions: sessionList, projectRoot, projectHash: daemonProjectHash, daemonStartedAt: startedAt }));

      // II5 — see session-client comment above. Same crash mode applies.
      ws.on("error", (err: any) => {
        log(`[ws] global client error: ${err?.code ?? err?.message ?? err}`);
        try { ws.terminate(); } catch {}
      });
      ws.on("close", () => {
        globalClients.delete(ws);
        checkAutoShutdown();
      });
    }

    log(`WebSocket client connected (session: ${sessionId ?? "global"}, total: ${getClientCount()})`);
  });

  // II5 — listen at the wss level too. The 'wss.on("error")' fires for
  // listening-side errors (EADDRINUSE in test fixtures, malformed upgrade
  // frames the per-client handler never sees). Without this, the same
  // unhandled-emit crash mode applies one level up.
  wss.on("error", (err: any) => {
    log(`[wss] server error: ${err?.code ?? err?.message ?? err}`);
  });

  // --- Heartbeat / hooks watcher / auto-open / ping ---
  // Each is a start-method (not run at construction) so index.ts preserves
  // the exact startup ordering: writeDaemonInfo → heartbeat → watcher →
  // "Daemon running" log → auto-open → ping.

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function startHeartbeat(port: number): ReturnType<typeof setInterval> {
    // A2: daemon.json is written on startup (index.ts calls writeDaemonInfo
    // directly — FATAL there) AND on this recurring heartbeat so a
    // missing/stale info file self-heals without user intervention.
    // PP4 note: the 30s rewrite looks like idle churn, but the periodic write is
    // load-bearing on two paths a stat-and-skip would silently break — (1) on
    // non-POSIX FS (WSL /mnt/c) the bearer token lives in an EPHEMERAL runtime/
    // tmp sidecar that the rewrite refreshes so it doesn't age out (else
    // DaemonClient auth dies after days); (2) the VS Code extension picks the
    // daemon.json with the freshest mtime as the "active" project. Left as-is.
    //
    // H1-3 — the periodic tick is wrapped (safeHeartbeatTick logs + continues)
    // so a transient ENOSPC/EACCES/EBUSY at a 30s tick can't uncaughtException
    // → exit(1) a healthy daemon. The STARTUP writeDaemonInfo(port) stays
    // UNWRAPPED on purpose in index.ts: a boot-time failure is fatal/loud
    // (main().catch).
    // H2-3 — thread a consecutive-failure counter so a PERSISTENT write failure
    // (a full disk / permanent EACCES leaves daemon.json stale-or-truncated and
    // nothing notices) escalates LOUDLY to stderr after N ticks. Still
    // non-fatal — the startup/periodic fatal asymmetry above is preserved.
    const heartbeatState: HeartbeatState = { consecutiveFailures: 0 };
    const heartbeat = setInterval(
      () =>
        safeHeartbeatTick(
          () => writeDaemonInfo(port),
          log,
          heartbeatState,
          (msg) => process.stderr.write(msg + "\n"),
        ),
      heartbeatIntervalMs,
    );
    heartbeat.unref?.();
    heartbeatTimer = heartbeat;
    return heartbeat;
  }

  let hooksWatcher: ErrorEmittingWatcher | null = null;

  function startHooksWatcher(): void {
    // X7 — watch .deeppairing/hooks-state.json for new hook fires; broadcast
    // each fire to every connected client so the HookStatus pill updates
    // live. The hook scripts append to that file on every fire (pass or
    // nag); we read the latest entry on each change.
    let lastFireSeen = 0;
    const hooksStatePath = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    const broadcastNewFires = () => {
      try {
        if (!fs.existsSync(hooksStatePath)) return;
        const raw = JSON.parse(fs.readFileSync(hooksStatePath, "utf-8"));
        const fires = Array.isArray(raw?.fires) ? raw.fires : [];
        for (const f of fires) {
          const t = new Date(f.at).getTime();
          if (!Number.isFinite(t) || t <= lastFireSeen) continue;
          lastFireSeen = t;
          // Hook fires are global (not session-scoped). broadcastAll sends to
          // every session client + every global client exactly once (the old
          // per-session broadcast() loop handed global tabs N_sessions + 1
          // copies and multi-counted the metric).
          broadcastAll({ type: "hook_fired", fire: f });
        }
      } catch { /* swallow — observability isn't load-bearing */ }
    };
    // Seed lastFireSeen from current state so we don't replay every old fire.
    try {
      if (fs.existsSync(hooksStatePath)) {
        const raw = JSON.parse(fs.readFileSync(hooksStatePath, "utf-8"));
        const fires = Array.isArray(raw?.fires) ? raw.fires : [];
        for (const f of fires) {
          const t = new Date(f.at).getTime();
          if (Number.isFinite(t) && t > lastFireSeen) lastFireSeen = t;
        }
      }
    } catch {}
    try {
      // Watch the directory rather than the file directly — file may not
      // exist yet, and atomic-rename writes recreate the inode.
      const hooksDir = path.dirname(hooksStatePath);
      fs.mkdirSync(hooksDir, { recursive: true });
      const watcher = watch(hooksDir, (_event, filename) => {
        if (filename === "hooks-state.json" || filename === path.basename(hooksStatePath)) {
          broadcastNewFires();
        }
      });
      // H1-2 — the change callback above is try/caught, but the watcher's own
      // 'error' channel was NOT: an emitted 'error' with no listener THROWS →
      // uncaughtException → exit(1). Routine triggers on Linux/WSL2: inotify
      // watch-limit exhaustion, or hooksDir being removed. guardWatcher logs
      // once and degrades (closes the watcher, daemon lives on).
      guardWatcher(watcher, log);
      hooksWatcher = watcher;
    } catch (err) {
      log(`Hook-state watcher failed to start: ${err}`);
    }
  }

  function maybeAutoOpenBrowser(port: number): void {
    // H4: auto-open the companion UI on first daemon start. Skip if the user
    // set DEEPPAIRING_NO_OPEN=1 (#152 — scripted/CI/agent-driven starts) or
    // DEEPPAIRING_OPEN_BROWSER=0/false (legacy opt-out; CI, VS Code extension
    // mode, etc.) — see auto-open.ts for why this is an env var and not TTY
    // sniffing. Skip if we're adopting an already-running daemon (only this
    // fresh process hits this code path).
    if (shouldAutoOpenBrowser(env)) {
      openBrowser(`http://localhost:${port}`).catch((err) => {
        log(`Failed to auto-open browser: ${err}`);
      });
    }
  }

  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let evictTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleInstallHealthPing(): void {
    // R4: opt-in install-health ping. 60s after bind so skill status has
    // had a chance to stabilize (either CLAUDE.md marker is visible or an
    // artifact has landed, or nothing ever will). Aggregate-only payload:
    // no projectRoot, no content, no identifiers. Gated on explicit env.
    const pingDecision = decidePing(env);
    if (pingDecision.shouldSend) {
      pingTimer = setTimeout(() => {
        // Compute skill-loaded signal the same way /api/skill-status does,
        // so the aggregate matches what the UI surfaces.
        const claudeMdPath = path.join(projectRoot, "CLAUDE.md");
        let claudeMdHasMarker = false;
        try {
          if (fs.existsSync(claudeMdPath)) {
            claudeMdHasMarker = fs.readFileSync(claudeMdPath, "utf-8").includes("<!-- deepPairing -->");
          }
        } catch {}
        const now = Date.now();
        const RECENT_WINDOW_MS = 10 * 60 * 1000;
        let recentArtifactActivity = false;
        for (const store of sessions.values()) {
          for (const a of store.getArtifacts()) {
            const t = new Date(a.createdAt).getTime();
            if (Number.isFinite(t) && now - t < RECENT_WINDOW_MS) {
              recentArtifactActivity = true;
              break;
            }
          }
          if (recentArtifactActivity) break;
        }
        const payload = buildPingPayload({
          // V-fix — was a stale hardcoded "0.1.0" (never bumped); the
          // install-health ping now reports the real running app version
          // from the single SERVER_VERSION constant.
          version,
          skillLikelyLoaded: claudeMdHasMarker || recentArtifactActivity,
          recentArtifactActivity,
        });
        void sendPing(pingDecision.url!, payload).then((r) => {
          log(`Install-health ping: ${r.ok ? "ok" : `failed (${r.error ?? r.status})`}`);
        });
      }, 60_000);
      pingTimer.unref?.();
    } else {
      log(`Install-health ping: skipped (${pingDecision.reason})`);
    }
  }

  function dispose(): void {
    if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    if (evictTimer) { clearTimeout(evictTimer); evictTimer = null; }
    try { hooksWatcher?.close?.(); } catch {}
    hooksWatcher = null;
    try { wss.close(); } catch {}
  }

  return {
    app,
    wss,
    attachUpgradeHandler,
    setBoundPort: (port: number) => { boundPort = port; },
    createSession,
    sessions,
    sessionMeta,
    activeSessions,
    broadcast,
    broadcastAll,
    getClientCount,
    checkAutoShutdown,
    writeDaemonInfo,
    startHeartbeat,
    startHooksWatcher,
    maybeAutoOpenBrowser,
    scheduleInstallHealthPing,
    cleanup,
    dispose,
  };
}
