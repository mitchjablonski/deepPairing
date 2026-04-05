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

// WebSocket broadcast stub — Phase 2 will replace with real WebSocket
const connectedClients: Set<any> = new Set();
function broadcast(event: any): void {
  const data = JSON.stringify(event);
  for (const client of connectedClients) {
    try {
      client.send(data);
    } catch {
      connectedClients.delete(client);
    }
  }
  log(`broadcast: ${event.type}`);
}

async function main() {
  log("deepPairing MCP server starting");
  log(`Project root: ${projectRoot}`);

  // Initialize store
  const store = new FileStore(projectRoot);
  log(`Session: ${store.getSessionId()}`);

  // Start MCP server (stdio)
  const mcp = createMcpServer(store, broadcast);
  await mcp.start();
  log("MCP server connected via stdio");

  // TODO Phase 2: Start HTTP + WebSocket server on port 3847
  // For now, just the MCP server runs
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
