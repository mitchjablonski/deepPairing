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
import { resolveProjectRoot } from "./project-root.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Z2 — when Claude Code spawns us via the plugin install path, our cwd is
// the plugin install dir (`~/.claude/plugins/...`), not the user's
// workspace. resolveProjectRoot prefers CLAUDE_PROJECT_DIR (canonical
// Claude Code signal for "the workspace") then DEEPPAIRING_PROJECT_ROOT
// (escape hatch) before falling back to cwd. Pre-Z2 every plugin user's
// projects collapsed to one shared session under the plugin dir.
const { projectRoot, source: projectRootSource } = resolveProjectRoot();
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
  log(`Project root: ${projectRoot} (resolved via ${projectRootSource})`);

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
  // CC6 — pass projectRoot so DaemonClient stamps X-Project-Hash on every
  // request. Defends against the (currently latent) case where a public
  // route moves under a hashed mount; today the AA4 middleware already
  // gates everything but the header now travels with the wrapper either way.
  const client = new DaemonClient(port, sessionId, projectRoot);
  // Y3' — pass expectedProjectRoot so the daemon refuses (403) if we
  // accidentally adopted a daemon serving a different project (port
  // collision / failed spawn fallback).
  await client.register({
    title: projectName,
    project: projectName,
    expectedProjectRoot: projectRoot,
  });
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
  // U6 — surface the doctor command in the most-visible failure path: when
  // the wrapper itself can't start (couldn't reach/spawn the daemon, port
  // conflict, broken install). This is what the user sees in Claude Code's
  // MCP stderr panel before they ever open the companion UI.
  process.stderr.write(
    `deepPairing wrapper: ${err?.message ?? err}\n` +
    `Run \`npx deeppairing doctor --fix\` to diagnose and heal common causes.\n`,
  );
  process.exit(1);
});
