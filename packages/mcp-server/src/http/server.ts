import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createHttpRoutes } from "./routes.js";
import { addClient, removeClient } from "./websocket.js";
import type { FileStore } from "../store/file-store.js";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_PORT = 3847;
const MAX_PORT_ATTEMPTS = 10;

export async function startHttpServer(
  store: FileStore,
  log: (msg: string) => void,
): Promise<number> {
  const app = createHttpRoutes(store);

  // Try to serve built web UI if it exists
  const __thisDir = path.dirname(fileURLToPath(import.meta.url));
  const webDistPath = path.join(__thisDir, "../../dist/web");
  if (fs.existsSync(webDistPath)) {
    // Serve static files for the companion web UI
    app.get("/*", async (c) => {
      const filePath = c.req.path === "/" ? "/index.html" : c.req.path;
      const fullPath = path.join(webDistPath, filePath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath);
        const ext = path.extname(filePath).slice(1);
        const mimeTypes: Record<string, string> = {
          html: "text/html",
          js: "application/javascript",
          css: "text/css",
          json: "application/json",
          svg: "image/svg+xml",
          woff2: "font/woff2",
          png: "image/png",
        };
        return new Response(content, {
          headers: { "Content-Type": mimeTypes[ext] ?? "application/octet-stream" },
        });
      }
      // SPA fallback — serve index.html for client-side routing
      const indexPath = path.join(webDistPath, "index.html");
      if (fs.existsSync(indexPath)) {
        return new Response(fs.readFileSync(indexPath), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return c.notFound();
    });
  } else {
    app.get("/", (c) => {
      return c.html(`<!DOCTYPE html>
<html>
<head><title>deepPairing</title></head>
<body style="background:#0f1117;color:#e4e5ea;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h1>deepPairing</h1>
<p style="color:#9ca0b0">Companion web UI not built yet. Run the build to enable it.</p>
<p style="color:#5c6178;font-size:0.875rem">MCP server is running. Claude Code can use the deepPairing tools.</p>
</div>
</body>
</html>`);
    });
  }

  // Find an available port
  let port = DEFAULT_PORT;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      const server = serve({ fetch: app.fetch, port });

      // WebSocket server on the same HTTP server
      const wss = new WebSocketServer({ noServer: true });

      // Handle WebSocket upgrades
      (server as any).on?.("upgrade", (request: any, socket: any, head: any) => {
        if (request.url === "/ws") {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
          });
        } else {
          socket.destroy();
        }
      });

      wss.on("connection", (ws) => {
        addClient(ws as any);
        log(`WebSocket client connected (${wss.clients.size} total)`);

        // Send current state on connect
        ws.send(JSON.stringify({
          type: "connected",
          state: store.getFullState(),
        }));

        ws.on("close", () => {
          removeClient(ws as any);
          log(`WebSocket client disconnected (${wss.clients.size} total)`);
        });
      });

      log(`HTTP + WebSocket server on http://localhost:${port}`);
      return port;
    } catch (err: any) {
      if (err?.code === "EADDRINUSE") {
        port++;
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not find available port (tried ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_PORT_ATTEMPTS})`);
}
