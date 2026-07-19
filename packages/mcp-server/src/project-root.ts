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
 *   3. `process.cwd()` — fallback for direct `node packages/mcp-server/dist/cli/init.js` invocation
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
//
// Env override (a real, supported feature — not test-only): the whole window
// can be relocated with
//   DEEPPAIRING_PORT_BASE — first port of the window (integer, 1024..65000;
//                           default 3847)
//   DEEPPAIRING_PORT_SPAN — number of deterministic slots (integer, 1..4096;
//                           default 128)
// Everything downstream (daemon bind loop, doctor sweep, wrapper discovery)
// derives from BASE_PORT/PORT_SPAN, so a valid override moves the entire
// product coherently — useful when 3847-3974 clashes with something else on
// the machine, and used by the vitest setup to keep test-spawned daemons out
// of the canonical window. Invalid values fall back to the defaults with a
// stderr note (never a crash). NOTE: the override must be visible to every
// deepPairing process (wrapper AND daemon) — a daemon spawned without it
// binds the default window and discovery would sweep the wrong range.
export const DEFAULT_BASE_PORT = 3847;
export const DEFAULT_PORT_SPAN = 128; // default deterministic slots: 3847..3974

export interface PortWindow {
  base: number;
  span: number;
}

/**
 * Resolve the port window from an env, validating honestly: integers only,
 * base in 1024..65000, span in 1..4096, and the window may not run past
 * 65535 (span is clamped to fit, with a note). Invalid values fall back to
 * the defaults silently-except-for-a-stderr-note so a typo'd env can never
 * take the daemon down. Pure (env + warn injectable) so tests can drive it
 * with fake envs — the module-level BASE_PORT/PORT_SPAN below are resolved
 * once from process.env at load.
 */
export function resolvePortWindow(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (msg) => {
    try { process.stderr.write(`${msg}\n`); } catch { /* stderr closed */ }
  },
): PortWindow {
  const readInt = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      warn(`[deepPairing] ignoring ${name}="${raw}" — expected an integer in ${min}..${max}; using default ${fallback}.`);
      return fallback;
    }
    return n;
  };
  const base = readInt("DEEPPAIRING_PORT_BASE", DEFAULT_BASE_PORT, 1024, 65000);
  let span = readInt("DEEPPAIRING_PORT_SPAN", DEFAULT_PORT_SPAN, 1, 4096);
  if (base + span - 1 > 65535) {
    const clamped = 65535 - base + 1; // ≥ 536 given base ≤ 65000, so never < 1
    warn(`[deepPairing] DEEPPAIRING_PORT_BASE=${base} + DEEPPAIRING_PORT_SPAN=${span} runs past port 65535 — clamping span to ${clamped}.`);
    span = clamped;
  }
  return { base, span };
}

const portWindow = resolvePortWindow();
export const BASE_PORT = portWindow.base;
export const PORT_SPAN = portWindow.span;
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
