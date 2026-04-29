#!/usr/bin/env node
/**
 * deepPairing Daemon — shared HTTP/WebSocket server.
 *
 * Spawned by the first MCP wrapper process as a detached background process.
 * Manages multiple sessions, serves the companion web UI, and broadcasts
 * events to connected browsers via WebSocket.
 *
 * Auto-shuts down after 60s of zero sessions + zero WebSocket clients.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import { spawn } from "node:child_process";
import { FileStore } from "./store/file-store.js";
import { createHttpRoutes } from "./http/routes.js";
import { createDaemonRoutes, type SessionMeta } from "./daemon-routes.js";
import { formatSessionMarkdown } from "./export/format-markdown.js";
import { runDaemonStartupSetup } from "./cli/setup-tasks.js";
import { runDemoScript } from "./demo-script.js";
import { recordMetricEvent } from "./store/metrics-store.js";
import { buildPingPayload, decidePing, sendPing } from "./ping.js";

/**
 * Cross-platform "open URL in default browser" without pulling in an npm
 * dep. macOS = open, Linux = xdg-open, Windows = start. Best-effort: failure
 * is logged but non-fatal.
 */
async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {}); // swallow spawn errors (e.g. xdg-open missing on headless Linux)
  child.unref();
}

const DEFAULT_PORT = 3847;
const MAX_PORT_ATTEMPTS = 10;
const projectRoot = process.env.DEEPPAIRING_PROJECT_ROOT ?? process.cwd();
const dpDir = path.join(projectRoot, ".deeppairing");
const logFile = path.join(dpDir, "daemon.log");
const daemonInfoFile = path.join(dpDir, "daemon.json");
const startedAt = new Date().toISOString();

// --- Logging ---

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [daemon] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {}
}

// --- Session management ---

const sessions = new Map<string, FileStore>();
const sessionMeta = new Map<string, SessionMeta>();

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

function broadcast(sessionId: string, event: any): void {
  const data = JSON.stringify({ ...event, sessionId });

  // Send to session-specific clients
  const sessionClients = wsClients.get(sessionId);
  if (sessionClients) {
    for (const ws of sessionClients) {
      try { (ws as any).send(data); } catch { sessionClients.delete(ws); }
    }
  }

  // Send to global (all-sessions) clients
  for (const ws of globalClients) {
    try { (ws as any).send(data); } catch { globalClients.delete(ws); }
  }

  // R1: local telemetry. Broadcast is the canonical point where every
  // metric-worthy event passes through, so we tap it once here instead of
  // scattering recordMetricEvent calls across routes / MCP handlers.
  try {
    recordEventForMetrics(event);
  } catch {
    // Telemetry must never break a broadcast.
  }
}

function recordEventForMetrics(event: any): void {
  switch (event?.type) {
    case "preflight_blocked":
      recordMetricEvent(projectRoot, {
        kind: "preflight_block",
        source: event.source === "team" ? "team" : "session",
      });
      break;
    case "ledger_write":
      recordMetricEvent(projectRoot, {
        kind: "ledger_write",
        verdict: event.kind === "approved" ? "approved" : "rejected",
      });
      break;
    case "retrospective_recorded":
      if (event.verdict === "right" || event.verdict === "wrong" || event.verdict === "mixed") {
        recordMetricEvent(projectRoot, { kind: "retrospective", verdict: event.verdict });
      }
      break;
    case "question_answered":
      recordMetricEvent(projectRoot, { kind: "question_answered" });
      break;
    case "feedback_received":
      if (event.intent === "question") {
        recordMetricEvent(projectRoot, { kind: "question_asked" });
      }
      // Horizon-check requests come through as comments with a specific
      // sectionId. The feedback_received broadcast carries only intent,
      // not the full target, so routes.ts records this one inline.
      break;
  }
}

function getClientCount(): number {
  let count = globalClients.size;
  for (const clients of wsClients.values()) count += clients.size;
  return count;
}

// --- Auto-shutdown ---

let shutdownTimer: ReturnType<typeof setInterval> | null = null;

function checkAutoShutdown(): void {
  if (sessions.size === 0 && getClientCount() === 0) {
    if (!shutdownTimer) {
      log("No sessions or clients — will shut down in 60s if still idle");
      shutdownTimer = setTimeout(() => {
        if (sessions.size === 0 && getClientCount() === 0) {
          log("Auto-shutting down (idle)");
          cleanup();
          process.exit(0);
        }
        shutdownTimer = null;
      }, 60000);
    }
  } else if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

// Check every 30s
setInterval(checkAutoShutdown, 30000);

// --- Build the HTTP app ---

const app = new Hono();

// CORS for localhost
app.use("/*", cors({
  origin: (origin) => {
    if (!origin) return origin as string;
    try {
      const url = new URL(origin);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
        return origin;
      }
    } catch {}
    return undefined as unknown as string;
  },
}));

// Mount internal daemon routes (for MCP wrappers)
const daemonRoutes = createDaemonRoutes(sessions, sessionMeta, createSession, broadcast, log);
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
      if (store) return store;
    }
    return getDefaultStoreOrNull();
  },
  projectRoot,
  (event, sessionId) => {
    // Session-scoped broadcast for public routes
    if (sessionId) {
      broadcast(sessionId, event);
    } else {
      // Broadcast to all sessions as fallback
      for (const sid of sessions.keys()) {
        broadcast(sid, event);
      }
    }
  },
  log,
);
app.route("/", publicRoutes);

// N2.1: daemon identity endpoint so multi-project clients can verify they're
// adopting the right daemon before trusting a port (avoids cross-project
// adoption when daemon.json has been deleted). Includes projectRoot + port.
app.get("/api/daemon-info", (c) => {
  return c.json({ pid: process.pid, projectRoot, startedAt });
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
  const sessionId = `demo_${Date.now()}`;
  const store = createSession(sessionId);
  sessionMeta.set(sessionId, {
    title: "deepPairing demo",
    project: "demo",
    registeredAt: new Date().toISOString(),
  });
  runDemoScript({ sessionId, store, broadcast });
  return c.json({ sessionId, startedAt: new Date().toISOString() });
});

// Active sessions endpoint for the web UI
app.get("/api/active-sessions", (c) => {
  const list = Array.from(sessions.entries()).map(([id, store]) => {
    const meta = sessionMeta.get(id);
    return {
      sessionId: id,
      title: meta?.title ?? id,
      project: meta?.project ?? "",
      artifactCount: store.getArtifacts().length,
    };
  });
  return c.json({ sessions: list });
});

// A6a: serve a single live session's state directly from the in-memory store
// so the companion UI's MultiAgentSync can merge artifacts across sessions.
app.get("/api/live-session/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const store = sessions.get(sessionId);
  if (!store) return c.json({ error: "unknown_session" }, 404);
  return c.json(store.getFullState());
});

// --- Serve static web UI ---

const __thisDir = path.dirname(fileURLToPath(import.meta.url));
const webDistPath = path.join(__thisDir, "../dist/web");

if (fs.existsSync(webDistPath)) {
  app.get("/*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    const filePath = c.req.path === "/" ? "/index.html" : c.req.path;
    const fullPath = path.join(webDistPath, filePath);
    const resolvedPath = path.resolve(fullPath);
    const resolvedBase = path.resolve(webDistPath);
    if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
      return c.notFound();
    }
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath);
      const ext = path.extname(filePath).slice(1);
      const mimeTypes: Record<string, string> = {
        html: "text/html", js: "application/javascript", css: "text/css",
        json: "application/json", svg: "image/svg+xml", woff2: "font/woff2", png: "image/png",
      };
      return new Response(content, {
        headers: { "Content-Type": mimeTypes[ext] ?? "application/octet-stream" },
      });
    }
    const indexPath = path.join(webDistPath, "index.html");
    if (fs.existsSync(indexPath)) {
      return new Response(fs.readFileSync(indexPath), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return c.notFound();
  });
}

// --- Start server ---

function cleanup(): void {
  // Flush all sessions
  for (const store of sessions.values()) {
    store.forceFlush();
  }
  // Remove daemon info file
  try { if (fs.existsSync(daemonInfoFile)) fs.unlinkSync(daemonInfoFile); } catch {}
}

function writeDaemonInfo(port: number): void {
  const info = { pid: process.pid, port, startedAt, projectRoot };
  try {
    fs.mkdirSync(path.dirname(daemonInfoFile), { recursive: true });
    fs.writeFileSync(daemonInfoFile, JSON.stringify(info, null, 2));
  } catch (err) {
    log(`Failed to write daemon.json: ${err}`);
  }
}

async function main() {
  log(`Daemon starting (PID ${process.pid})`);
  log(`Project root: ${projectRoot}`);

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
    let port = DEFAULT_PORT;
    let server: ReturnType<typeof serve> | null = null;
    let lastBindErr: any = null;
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const candidate = DEFAULT_PORT + attempt;
      const candidateServer = serve({ fetch: app.fetch, port: candidate });
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
        port = candidate;
        if (attempt > 0) log(`Port ${DEFAULT_PORT} through ${candidate - 1} busy — bound to ${candidate} instead.`);
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
      const msg = `No free port in range ${DEFAULT_PORT}–${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1}. Last error: ${lastBindErr?.message ?? lastBindErr}. Run \`npx deeppairing doctor --fix\` to diagnose and heal.`;
      log(`FATAL: ${msg}`);
      process.stderr.write(`deepPairing daemon: ${msg}\n`);
      process.exit(2);
    }

    // WebSocket server
    const wss = new WebSocketServer({ noServer: true });

    (server as any).on?.("upgrade", (request: any, socket: any, head: any) => {
      if (request.url?.startsWith("/ws")) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws, request) => {
      // Parse sessionId from query: /ws?sessionId=xxx
      const url = new URL(request.url ?? "/ws", "http://localhost");
      const sessionId = url.searchParams.get("sessionId");

      if (sessionId) {
        // Subscribe to a specific session
        let clients = wsClients.get(sessionId);
        if (!clients) { clients = new Set(); wsClients.set(sessionId, clients); }
        clients.add(ws as any);

        // Send session state on connect. U4 — include `daemonStartedAt` so
        // the client can detect a daemon-restart on reconnect (a different
        // daemon process means stale in-memory state, force re-hydrate).
        const store = sessions.get(sessionId);
        if (store) {
          ws.send(JSON.stringify({ type: "connected", state: store.getFullState(), projectRoot, daemonStartedAt: startedAt }));
        }

        ws.on("close", () => {
          clients!.delete(ws as any);
          if (clients!.size === 0) wsClients.delete(sessionId);
          checkAutoShutdown();
        });
      } else {
        // Global client — sees all sessions
        globalClients.add(ws as any);

        // Send list of active sessions
        const sessionList = Array.from(sessions.entries()).map(([id, store]) => ({
          sessionId: id,
          artifactCount: store.getArtifacts().length,
        }));
        // U4 — include `daemonStartedAt` so global clients also detect a
        // daemon restart and re-hydrate session listings on reconnect.
        ws.send(JSON.stringify({ type: "connected", sessions: sessionList, daemonStartedAt: startedAt }));

        ws.on("close", () => {
          globalClients.delete(ws as any);
          checkAutoShutdown();
        });
      }

      log(`WebSocket client connected (session: ${sessionId ?? "global"}, total: ${getClientCount()})`);
    });

    // A2: write daemon.json on startup AND on a recurring heartbeat so a
    // missing/stale info file self-heals without user intervention.
    writeDaemonInfo(port);
    const heartbeat = setInterval(() => writeDaemonInfo(port), 30000);
    heartbeat.unref?.();

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
          // Hook fires are global (not session-scoped); broadcast to every
          // session so any open UI sees them.
          for (const sid of sessions.keys()) {
            broadcast(sid, { type: "hook_fired", fire: f });
          }
          // Also fan out to global clients (no session selected).
          for (const ws of globalClients) {
            try { (ws as any).send(JSON.stringify({ type: "hook_fired", fire: f })); } catch {}
          }
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
      fs.watch(hooksDir, (_event, filename) => {
        if (filename === "hooks-state.json" || filename === path.basename(hooksStatePath)) {
          broadcastNewFires();
        }
      });
    } catch (err) {
      log(`Hook-state watcher failed to start: ${err}`);
    }

    log(`Daemon running on http://localhost:${port}`);

    // H4: auto-open the companion UI on first daemon start. Skip if the user
    // set DEEPPAIRING_OPEN_BROWSER=0/false (CI, VS Code extension mode, etc.).
    // Skip if we're adopting an already-running daemon (only this fresh
    // process hits this code path).
    const openFlag = process.env.DEEPPAIRING_OPEN_BROWSER;
    const shouldOpen = openFlag !== "0" && openFlag !== "false" && openFlag !== "no";
    if (shouldOpen) {
      openBrowser(`http://localhost:${port}`).catch((err) => {
        log(`Failed to auto-open browser: ${err}`);
      });
    }

    // R4: opt-in install-health ping. 60s after bind so skill status has
    // had a chance to stabilize (either CLAUDE.md marker is visible or an
    // artifact has landed, or nothing ever will). Aggregate-only payload:
    // no projectRoot, no content, no identifiers. Gated on explicit env.
    const pingDecision = decidePing(process.env);
    if (pingDecision.shouldSend) {
      const pingTimer = setTimeout(() => {
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
          version: "0.1.0",
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

  // Graceful shutdown
  process.on("exit", cleanup);
  process.on("SIGINT", () => { log("Shutting down (SIGINT)"); cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { log("Shutting down (SIGTERM)"); cleanup(); process.exit(0); });
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
