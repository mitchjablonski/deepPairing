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

import { FileStore } from "./store/file-store.js";
import { createHttpRoutes } from "./http/routes.js";
import { createDaemonRoutes } from "./daemon-routes.js";
import { formatSessionMarkdown } from "./export/format-markdown.js";

const DEFAULT_PORT = 3847;
const projectRoot = process.env.DEEPPAIRING_PROJECT_ROOT ?? process.cwd();
const dpDir = path.join(projectRoot, ".deeppairing");
const logFile = path.join(dpDir, "daemon.log");
const daemonInfoFile = path.join(dpDir, "daemon.json");

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

function createSession(sessionId: string): FileStore {
  log(`Creating session: ${sessionId}`);
  const store = new FileStore(projectRoot, sessionId);
  sessions.set(sessionId, store);
  return store;
}

// Default session store for the public web UI routes (uses first active session or creates one)
function getDefaultStore(): FileStore {
  const first = sessions.values().next().value;
  if (first) return first;
  return createSession(`session_${Date.now()}`);
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
const daemonRoutes = createDaemonRoutes(sessions, createSession, broadcast);
app.route("/", daemonRoutes);

// Mount public web UI routes (for browser)
// Use a Proxy that delegates to the default (first active) store dynamically
const storeProxy = new Proxy({} as any, {
  get(_target, prop) {
    const store = getDefaultStore();
    const val = (store as any)[prop];
    return typeof val === "function" ? val.bind(store) : val;
  },
});
const publicRoutes = createHttpRoutes(storeProxy, projectRoot);
app.route("/", publicRoutes);

// Active sessions endpoint for the web UI
app.get("/api/active-sessions", (c) => {
  const list = Array.from(sessions.entries()).map(([id, store]) => ({
    sessionId: id,
    artifactCount: store.getArtifacts().length,
  }));
  return c.json({ sessions: list });
});

// --- Serve static web UI ---

const __thisDir = path.dirname(fileURLToPath(import.meta.url));
const webDistPath = path.join(__thisDir, "../../dist/web");

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

async function main() {
  log(`Daemon starting (PID ${process.pid})`);
  log(`Project root: ${projectRoot}`);

  // Ensure .deeppairing directory exists
  fs.mkdirSync(dpDir, { recursive: true });

  const port = DEFAULT_PORT;
  try {
    const server = serve({ fetch: app.fetch, port });

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

        // Send session state on connect
        const store = sessions.get(sessionId);
        if (store) {
          ws.send(JSON.stringify({ type: "connected", state: store.getFullState() }));
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
        ws.send(JSON.stringify({ type: "connected", sessions: sessionList }));

        ws.on("close", () => {
          globalClients.delete(ws as any);
          checkAutoShutdown();
        });
      }

      log(`WebSocket client connected (session: ${sessionId ?? "global"}, total: ${getClientCount()})`);
    });

    // Write daemon info file
    const info = { pid: process.pid, port, startedAt: new Date().toISOString() };
    fs.writeFileSync(daemonInfoFile, JSON.stringify(info, null, 2));

    log(`Daemon running on http://localhost:${port}`);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      log(`Port ${port} already in use — another daemon may be running`);
      process.exit(1);
    }
    throw err;
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
