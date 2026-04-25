#!/usr/bin/env node
/**
 * deepPairing MCP Server — thin stdio wrapper.
 *
 * Each Claude Code session spawns this process. It:
 * 1. Ensures the shared daemon is running (spawns it if needed)
 * 2. Registers its session with the daemon
 * 3. Runs the MCP server on stdio, proxying all store operations to the daemon via HTTP
 *
 * The daemon manages the companion web UI, WebSocket broadcast, and all state.
 */

import { createMcpServer } from "./mcp/server.js";
import { ensureDaemon } from "./daemon-lifecycle.js";
import { DaemonClient } from "./daemon-client.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const dpDir = path.join(projectRoot, ".deeppairing");
const logFile = path.join(dpDir, "server.log");

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [mcp] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {}
}

async function main() {
  log("MCP wrapper starting");
  log(`Project root: ${projectRoot}`);

  // Ensure the shared daemon is running
  const port = await ensureDaemon(projectRoot);
  log(`Daemon ready on port ${port}`);

  // U0.6 — deterministic sessionId per projectRoot. Previously every wrapper
  // spawn minted a fresh `session_<timestamp>_<random>`, which meant a
  // restart of Claude Code or a second `npx deeppairing init` produced a
  // duplicate session for the same project. The companion UI bound to one;
  // the agent's current wrapper polled another; approvals never landed
  // where the agent was looking. Hashing projectRoot collapses all wrappers
  // for a project into one shared session — which is the right semantic
  // model for pairing (the "session" is the workspace, not the process).
  // Project name kept in the id as a human-readable hint for `ls`.
  const projectName = path.basename(projectRoot);
  const safeProjectName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const projectHash = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
  const sessionId = `session_${safeProjectName}_${projectHash}`;
  const client = new DaemonClient(port, sessionId);
  await client.register({ title: projectName, project: projectName });
  log(`Session registered: ${sessionId} (${projectName})`);

  // Notify user
  process.stderr.write(`\n  deepPairing is running.\n  Companion UI: http://localhost:${port}\n  Session: ${sessionId}\n\n`);

  // Create MCP server with the daemon client as the store
  // broadcast is a no-op — the daemon broadcasts when mutations happen via daemon-routes
  const noop = () => {};
  const mcp = createMcpServer(client, noop, port);

  // Graceful shutdown
  process.on("exit", () => {
    client.unregister().catch(() => {});
    client.forceFlush().catch(() => {});
  });
  process.on("SIGINT", () => {
    log("Shutting down (SIGINT)");
    client.unregister().catch(() => {});
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("Shutting down (SIGTERM)");
    client.unregister().catch(() => {});
    process.exit(0);
  });

  // Start MCP server on stdio
  await mcp.start();
  log("MCP server connected via stdio");
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
