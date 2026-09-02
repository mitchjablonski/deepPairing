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
import { ensureDaemon } from "./daemon/lifecycle.js";
import { DaemonClient } from "./daemon/client.js";
import { resolveProjectRoot } from "./project-root.js";
import { upsertProject } from "./store/project-registry.js";
import { cliInvocation } from "./cli-invocation.js";
import { deriveSessionId } from "./session-id.js";
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

  // Context bank — record this project in ~/.deeppairing/projects.json.
  // daemon/index.ts does the same on ITS startup, but that only fires when this
  // wrapper actually spawns a daemon: attach to an already-running daemon (the
  // common case, and always the case for one started by a pre-bank build) and
  // the breadcrumb is never written, so the project is invisible to every
  // bank — including the one this very process is about to serve. Upserting
  // from the wrapper too makes the registry track "a project I opened", which
  // is the thing the bank is actually about. Idempotent; best-effort by
  // construction, and never worth failing a wrapper start over.
  try {
    upsertProject(projectRoot);
  } catch (err) {
    log(`Project registry warning (non-fatal): ${err}`);
  }

  // Ensure the shared daemon is running.
  // II1 — ensureDaemon now returns the full DaemonInfo (port + authToken)
  // so we can stamp Authorization on every internal call. A daemon without
  // an authToken is either pre-II1 or mid-startup (heartbeat hasn't landed
  // daemon.json yet); we still proceed but every internal call will 401.
  // Surface this loudly so the user reaches for doctor instead of a quiet
  // "nothing works" experience.
  const daemonInfo = await ensureDaemon(projectRoot);
  const port = daemonInfo.port;
  if (!daemonInfo.authToken) {
    log(`WARN: daemon at port ${port} did not advertise authToken — internal calls will 401. Run \`${cliInvocation("doctor")}\` to refresh daemon.json.`);
  }
  log(`Daemon ready on port ${port}`);

  // U0.6 — deterministic sessionId per projectRoot. Previously every wrapper
  // spawn minted a fresh `session_<timestamp>_<random>`, which meant a
  // restart of Claude Code or a second `node packages/mcp-server/dist/cli/init.js init` produced a
  // duplicate session for the same project. The companion UI bound to one;
  // the agent's current wrapper polled another; approvals never landed
  // where the agent was looking. Hashing projectRoot collapses all wrappers
  // for a project into one shared session. Project name kept in the id as a
  // human-readable hint for `ls`.
  //
  // PER-CLAUDE-SESSION SPLIT — when Claude Code (>= v2.1.154) spawns us it sets
  // CLAUDE_CODE_SESSION_ID in the env (== the session UUID). We append a
  // sanitized copy so each CONCURRENT Claude session gets its OWN
  // artifacts/comments/decisions bucket under sessions/<id>/ instead of two
  // conversations trampling one shared bucket. The moat (rejected approaches /
  // guardrails) lives at projectRoot/.deeppairing keyed by projectRoot,
  // independent of sessionId, so the split can never fragment it. When the env
  // var is ABSENT/empty (old clients, `pnpm start`, non-Claude MCP clients) the
  // derivation returns the EXACT pre-split per-project id, byte-identical — so
  // those callers are unchanged. See deriveSessionId + session-id tests.
  const projectName = path.basename(projectRoot);
  const claudeSessionIdEnv = process.env.CLAUDE_CODE_SESSION_ID;
  const derived = deriveSessionId(projectRoot, claudeSessionIdEnv);
  const sessionId = derived.sessionId;
  // Startup self-probe — the spike verified the env var indirectly (daemon +
  // issue #41836); this in-situ log is the direct confirmation that Claude
  // Code actually put CLAUDE_CODE_SESSION_ID in THIS wrapper's process.env.
  // The sessionId is not a secret (it's the transcript basename), so logging
  // it is fine and lets a real session grep the mode + resolved id.
  if (derived.mode === "split") {
    log(
      `session-split: MODE=split — CLAUDE_CODE_SESSION_ID present (sanitized="${derived.claudeSessionId}"), ` +
      `per-session bucket. Resolved sessionId=${sessionId}`,
    );
  } else {
    const raw = claudeSessionIdEnv;
    const why = raw == null ? "unset" : raw.length === 0 ? "empty" : "sanitized-to-empty";
    log(
      `session-split: MODE=fallback — CLAUDE_CODE_SESSION_ID ${why}; ` +
      `using byte-identical per-project sessionId=${sessionId}`,
    );
  }
  // CC6 — pass projectRoot so DaemonClient stamps X-Project-Hash on every
  // request. Defends against the (currently latent) case where a public
  // route moves under a hashed mount; today the AA4 middleware already
  // gates everything but the header now travels with the wrapper either way.
  // II1 — also pass the authToken so internal calls authenticate. Without
  // it the wrapper would 401 on every call after register().
  const client = new DaemonClient(port, sessionId, projectRoot, daemonInfo.authToken);
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
    `Run \`${cliInvocation("doctor --fix")}\` to diagnose and heal common causes.\n`,
  );
  process.exit(1);
});
