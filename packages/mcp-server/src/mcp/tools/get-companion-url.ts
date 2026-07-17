import type { ToolContext, ToolResult } from "./types.js";
import { resolveDaemonStatus } from "../../daemon/status.js";

/**
 * #163 — `get_companion_url` handler.
 *
 * Read-only. Reports the deepPairing companion UI port + URL for THIS session
 * so the agent can hand the human the exact review-surface URL (never a guessed
 * default). Uses the shared resolver for consistency with the CLI, but passes
 * `knownPort: ctx.port` so it always describes this session's ACTUAL daemon —
 * the port the wrapper is already talking to — not whatever a walk-up finds.
 */
export async function handleGetCompanionUrl(ctx: ToolContext, _args: unknown): Promise<ToolResult> {
  const status = await resolveDaemonStatus({ knownPort: ctx.port });

  const structuredContent = {
    port: status.port,
    companionUrl: status.companionUrl,
    version: status.version,
    running: status.running,
    alive: status.alive,
    projectRoot: status.projectRoot,
  };

  const liveness = status.alive
    ? "running"
    : "not currently reachable (open a session or restart Claude Code)";
  const text =
    `Companion UI for this project: ${status.companionUrl}\n` +
    `Port: ${status.port} · ${liveness}` +
    (status.version ? ` · daemon v${status.version}` : "") +
    `\nGive the human THIS exact URL to open the review surface.`;

  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}
