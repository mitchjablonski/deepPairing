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
