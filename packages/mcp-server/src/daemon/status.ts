/**
 * #163 — shared daemon status/port resolver.
 *
 * ONE function both surfaces reuse (never two drifting copies):
 *   - the CLI (`deeppairing port` / `deeppairing status`), and
 *   - the MCP `get_companion_url` tool (so the agent can hand the human the
 *     live review-surface URL).
 *
 * The user's field need: "an easy way to tell what port a daemon is on for a
 * particular Claude Code session" — reachable via the `!` shell escape
 * (`!deeppairing port`) OR by asking Claude (it calls the tool).
 *
 * Design:
 *   - Walk UP from the given dir to the nearest `.deeppairing/daemon.json`
 *     (like git finds `.git`), so a `!`-run from a subdirectory still resolves
 *     the right daemon.
 *   - PROBE `/api/daemon-info` for real liveness — daemon.json can be stale
 *     (a prior release near-miss shipped a daemon.json whose port no longer
 *     responded). `alive` is the truth; `running` only reflects "daemon.json
 *     claims a bound port (or this is an active session)".
 *   - FALLBACK: no daemon.json ⇒ compute the DETERMINISTIC per-project port
 *     from the resolved projectRoot (reuse `preferredPortFor` — never reimplement
 *     the hash) and report `running: false`.
 *   - `/api/daemon-info` is the unauthenticated discovery endpoint (exempt from
 *     the AA4 X-Project-Hash gate), so status never needs the bearer token.
 */
import fs from "node:fs";
import path from "node:path";
import { projectHashOf, preferredPortFor, resolveProjectRoot } from "../project-root.js";

export interface DaemonStatus {
  /** The actionable port: the live bound port when reachable, else the
   *  deterministic port the daemon WOULD bind next time (for scripting +
   *  "open this" affordances). For an active MCP session, always the session's
   *  own daemon port. */
  port: number;
  /** `http://localhost:<port>` — the companion UI URL. */
  companionUrl: string;
  /** Daemon PID (from the live probe when alive, else daemon.json). */
  pid?: number;
  /** Daemon SERVER_VERSION (live probe preferred, else daemon.json). */
  version?: string;
  /** Resolved project root (live probe authoritative, else the walk-up dir). */
  projectRoot: string;
  /** 8-char deterministic identity for projectRoot. */
  projectHash: string;
  /** A daemon.json bound port exists (or this is an active session). NOT the
   *  same as reachable — a stale daemon.json reads `running: true, alive: false`. */
  running: boolean;
  /** `/api/daemon-info` actually responded — the daemon is genuinely up. */
  alive: boolean;
}

/** The subset of daemon.json this resolver reads. */
interface DaemonJson {
  pid?: number;
  port?: number;
  version?: string;
  projectRoot?: string;
  projectHash?: string;
}

/**
 * Walk UP from `startDir` to the nearest directory containing
 * `.deeppairing/daemon.json`. Returns that directory + the parsed file (or a
 * `{}` info when the file exists but is corrupt — it's still THIS project's
 * marker, so we stop walking rather than latch onto a parent project's daemon).
 * Returns null when no `.deeppairing/daemon.json` exists on the path to root.
 */
export function findDaemonJson(startDir: string): { dir: string; info: DaemonJson } | null {
  let dir = path.resolve(startDir);
  // Bounded by the filesystem root: path.dirname("/") === "/".
  for (;;) {
    const candidate = path.join(dir, ".deeppairing", "daemon.json");
    if (fs.existsSync(candidate)) {
      try {
        return { dir, info: JSON.parse(fs.readFileSync(candidate, "utf-8")) as DaemonJson };
      } catch {
        // Present-but-corrupt is still this project's marker.
        return { dir, info: {} };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ResolveDaemonStatusOptions {
  /** Where to begin the walk-up. Defaults to process.cwd(). */
  startDir?: string;
  /** Defaults to process.env (used to honor CLAUDE_PROJECT_DIR / DEEPPAIRING_PROJECT_ROOT). */
  env?: NodeJS.ProcessEnv;
  /**
   * When set (the MCP tool passes this session's actual daemon port), report it
   * as authoritative — the tool must describe THIS session's daemon regardless
   * of what a walk-up finds. Liveness is still probed against it.
   */
  knownPort?: number;
  /** Liveness probe timeout. Default 800ms (short — status must feel instant). */
  probeTimeoutMs?: number;
  /** Injectable fetch for tests (fakes not mocks). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve daemon status for a project. See the module header for the full
 * contract. Never throws — an unreachable/absent daemon degrades to the
 * deterministic-port fallback.
 */
export async function resolveDaemonStatus(
  opts: ResolveDaemonStatusOptions = {},
): Promise<DaemonStatus> {
  const env = opts.env ?? process.env;
  const startDir = opts.startDir ?? process.cwd();
  const probeTimeoutMs = opts.probeTimeoutMs ?? 800;
  const doFetch = opts.fetchImpl ?? fetch;

  // Respect CLAUDE_PROJECT_DIR / DEEPPAIRING_PROJECT_ROOT (reuse the one
  // resolver), else fall back to startDir as cwd.
  const baseRoot = resolveProjectRoot({ env, cwd: () => startDir }).projectRoot;

  // Walk UP to the nearest daemon.json (robust to `!`-run-from-a-subdir).
  const found = findDaemonJson(baseRoot);
  const effectiveRoot = found?.info.projectRoot ?? found?.dir ?? baseRoot;
  const deterministicPort = preferredPortFor(effectiveRoot);

  // The bound port we KNOW about: an active session's port (authoritative) or a
  // daemon.json record. `running` reflects only this — not reachability.
  const boundPort =
    opts.knownPort ?? (typeof found?.info.port === "number" ? found.info.port : undefined);
  const running = boundPort !== undefined;

  // Probe the candidate for real liveness. daemon.json can be stale.
  const candidate = boundPort ?? deterministicPort;
  let alive = false;
  let pid = found?.info.pid;
  let version = found?.info.version;
  let liveRoot: string | undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    const res = await doFetch(`http://localhost:${candidate}/api/daemon-info`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json()) as {
        pid?: unknown;
        version?: unknown;
        projectRoot?: unknown;
      };
      if (typeof data?.pid === "number") {
        alive = true;
        pid = data.pid;
      }
      if (typeof data?.version === "string") version = data.version;
      if (typeof data?.projectRoot === "string") liveRoot = data.projectRoot;
    }
  } catch {
    // Unreachable — alive stays false.
  }

  // The actionable port: an active session's own port wins; otherwise the live
  // bound port when reachable, else the deterministic "would bind here" port.
  const port = opts.knownPort ?? (alive ? candidate : deterministicPort);
  const finalRoot = liveRoot ?? effectiveRoot;

  return {
    port,
    companionUrl: `http://localhost:${port}`,
    pid,
    version,
    projectRoot: finalRoot,
    projectHash: projectHashOf(finalRoot),
    running,
    alive,
  };
}
