#!/usr/bin/env node
/**
 * deepPairing MCP Server — standalone entry point.
 * Starts MCP server on stdio + HTTP/WebSocket on port 3847.
 *
 * Usage:
 *   npx @deeppairing/mcp-server
 *   node dist/standalone.js
 *
 * Claude Code connects via stdio. Companion web UI at localhost:3847.
 */

import { createMcpServer } from "./mcp/server.js";
import { startHttpServer } from "./http/server.js";
import { broadcast } from "./http/websocket.js";
import { FileStore } from "./store/file-store.js";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const logFile = path.join(projectRoot, ".deeppairing", "server.log");

// Logging — must not write to stdout/stderr (corrupts MCP protocol)
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {
    // Can't log — silently continue
  }
}

async function main() {
  log("deepPairing MCP server starting");
  log(`Project root: ${projectRoot}`);

  // Initialize file store
  const store = new FileStore(projectRoot);
  log(`Session: ${store.getSessionId()}`);

  // Start HTTP + WebSocket server (companion web UI)
  const port = await startHttpServer(store, log, projectRoot);
  log(`Companion UI available at http://localhost:${port}`);

  // Notify user via stderr (Claude Code shows MCP stderr to the user)
  process.stderr.write(`deepPairing companion UI: http://localhost:${port}\n`);

  // Start MCP server (stdio — Claude Code connects here)
  const mcp = createMcpServer(store, broadcast);
  await mcp.start();
  log("MCP server connected via stdio");
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
