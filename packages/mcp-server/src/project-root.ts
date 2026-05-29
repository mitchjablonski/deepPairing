/**
 * Z2 — resolve the user's workspace directory, not the wrapper's cwd.
 *
 * Failure mode this closes: when Claude Code spawns the deepPairing MCP
 * server via the plugin install path (claude-plugin/server.mjs), the
 * spawned process inherits Claude Code's spawn cwd — often
 * `~/.claude/plugins/...`, NOT the user's workspace. Pre-Z2 standalone.ts
 * unconditionally used `process.cwd()` for the projectRoot, so:
 *   - The deterministic projectHash collapsed to one value across every
 *     project the user opened (`~/.claude/plugins/...` is constant).
 *   - All projects shared one daemon session → all artifacts merged into
 *     the same `.deeppairing/` under the plugin install dir.
 *   - The Y3' expectedProjectRoot binding "succeeded" because daemon's
 *     own cwd was also the plugin dir — security-theater pass.
 *
 * Detection priority (first match wins):
 *   1. `CLAUDE_PROJECT_DIR` — Claude Code sets this for hooks; MCP
 *      servers spawned in the same env see it. This is the canonical
 *      signal for "the workspace the user is working in."
 *   2. `DEEPPAIRING_PROJECT_ROOT` — escape hatch for users running the
 *      wrapper outside Claude Code (CI, scripts, IDE extensions).
 *   3. `process.cwd()` — fallback for direct `npx deeppairing` invocation
 *      from the user's terminal, where cwd IS the workspace.
 *
 * The resolver also returns WHICH signal won so the wrapper can log it,
 * and surface it in the doctor command (Z5 follow-up). This makes
 * cross-project leakage debuggable instead of silent.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

/**
 * AA4 — short, deterministic identity for a projectRoot. Same shape as
 * the projectHash baked into deterministic sessionIds (standalone.ts:58),
 * lifted here so the daemon, the wrapper, and the browser can all derive
 * the same value from the same input.
 *
 * The browser sends this in `X-Project-Hash` alongside `X-Session-Id`;
 * the daemon refuses with 403 project_mismatch if its own hash differs.
 * Defends against a stale-tab-after-port-recycling write: when daemon-A
 * idle-shuts and daemon-B claims the same port, a tab that still has
 * daemon-A's sessionId would otherwise route mutations into B's first
 * arbitrary session via the silent default-store fallback.
 */
export function projectHashOf(projectRoot: string): string {
  return crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
}

// Deterministic per-project port. Pre-this, daemons bound the first free port
// from 3847 (first-to-bind-wins), so a bookmarked URL mapped to whichever
// project started first and a stale tab could cross-bind to another project's
// daemon on a recycled port. Map projectHash → a stable PREFERRED port so a
// project always lands on the same port. It's a preferred *start*, not a
// guarantee: the bind loop probes onward and records the ACTUAL bound port in
// daemon.json, so a collision (two projects hashing to the same slot) or a
// squatter degrades gracefully and discovery still works. The AA4
// X-Project-Hash gate remains the safety net against cross-project writes.
export const BASE_PORT = 3847;
export const PORT_SPAN = 128; // deterministic slots: 3847..3974
export function preferredPortFor(projectRoot: string): number {
  // projectHashOf is 8 hex chars = a 32-bit value; mod it into the span.
  return BASE_PORT + (parseInt(projectHashOf(projectRoot), 16) % PORT_SPAN);
}

export type ProjectRootSource = "CLAUDE_PROJECT_DIR" | "DEEPPAIRING_PROJECT_ROOT" | "cwd";

export interface ResolvedProjectRoot {
  projectRoot: string;
  source: ProjectRootSource;
}

export interface ResolveProjectRootOptions {
  /** Defaults to process.env. Override for tests. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.cwd(). Override for tests. */
  cwd?: () => string;
}

export function resolveProjectRoot(opts: ResolveProjectRootOptions = {}): ResolvedProjectRoot {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? (() => process.cwd());

  const candidates: Array<{ value: string | undefined; source: ProjectRootSource }> = [
    { value: env.CLAUDE_PROJECT_DIR, source: "CLAUDE_PROJECT_DIR" },
    { value: env.DEEPPAIRING_PROJECT_ROOT, source: "DEEPPAIRING_PROJECT_ROOT" },
  ];

  for (const c of candidates) {
    const v = c.value?.trim();
    if (!v) continue;
    // Reject env values that don't look like an absolute, existing dir.
    // A bad env shouldn't poison the resolver — fall through to cwd.
    if (!path.isAbsolute(v)) continue;
    try {
      if (!fs.statSync(v).isDirectory()) continue;
    } catch {
      continue;
    }
    return { projectRoot: path.resolve(v), source: c.source };
  }

  return { projectRoot: path.resolve(cwd()), source: "cwd" };
}
