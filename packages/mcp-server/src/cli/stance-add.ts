import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IStore } from "../store/store-interface.js";
import { formatRecordStanceOutcome, parseStanceArguments, recordStance, STANCE_USAGE } from "../store/stance-add.js";

/**
 * #620 — `deeppairing stance add <what> -- <why>` for source installs. Same
 * parser, validation and add-only write as the `/deeppairing:reject` MCP door
 * (store/stance-add.ts). It writes through a FileStore on the project, the way
 * `philosophy publish` does, so it works whether or not the daemon is running;
 * the daemon and the hook read preferences.json fresh on every check.
 *
 * #625 review — WHICH project. Run from a subdirectory, the resolved cwd is not
 * the root the hook and daemon use (Claude Code hands them CLAUDE_PROJECT_DIR).
 * Like `deeppairing status` / `port` (daemon/status.ts findDaemonJson), this
 * walks UP to the nearest directory whose `.deeppairing/` is a project's
 * (it holds sessions/, preferences.json or daemon.json), and prints the path it
 * chose. The home directory is never a project here: `~/.deeppairing` is the
 * cross-project store. No project found → refuse, printing where it looked.
 * When CLAUDE_PROJECT_DIR (or DEEPPAIRING_PROJECT_ROOT) names a directory, the
 * hook uses that root, so this does too, with no walk-up: the caller's
 * resolved root (init.ts resolveProjectRoot) already came from it, and a stray
 * nested `.deeppairing/` below it must not win.
 *
 * `requestedBy` is "user" only from an interactive terminal outside Claude
 * Code; otherwise "unknown". Self-reported, like every door label here.
 */
export interface StanceAddIo {
  /** The resolved start dir (init.ts: resolveProjectRoot()). */
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  write: (text: string) => void;
  writeErr: (text: string) => void;
  openStore: (projectRoot: string) => Promise<Pick<IStore, "recordRejectedApproach" | "getSessionMemory"> & { dispose?: () => void }>;
  /** Defaults to os.homedir(); injectable for tests. */
  homeDir?: string;
}

const PROJECT_MARKERS = ["sessions", "preferences.json", "daemon.json"];

/** The nearest directory at or above `start` holding a PROJECT's
 *  `.deeppairing/`, never `homeDir` itself. Null when there is none. */
export function findStanceProjectRoot(start: string, homeDir: string): string | null {
  let dir = path.resolve(start);
  const home = path.resolve(homeDir);
  for (;;) {
    if (dir !== home) {
      const dp = path.join(dir, ".deeppairing");
      if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dp, m)))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when an env var the hook honours names an existing absolute dir
 *  (the same acceptance test resolveProjectRoot applies). */
function envNamesRoot(env: NodeJS.ProcessEnv): boolean {
  for (const v of [env.CLAUDE_PROJECT_DIR, env.DEEPPAIRING_PROJECT_ROOT]) {
    const t = v?.trim();
    if (!t || !path.isAbsolute(t)) continue;
    try { if (fs.statSync(t).isDirectory()) return true; } catch { /* not a dir */ }
  }
  return false;
}

export async function runStanceAddCommand(args: string[], io: StanceAddIo): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.writeErr(`  Usage: stance add ${STANCE_USAGE}\n  Example: stance add "global mutable state for config" -- "keep configuration explicit"\n`);
    return args.length === 0 ? 1 : 0;
  }
  const root = envNamesRoot(io.env) ? io.projectRoot : findStanceProjectRoot(io.projectRoot, io.homeDir ?? os.homedir());
  if (!root) {
    io.writeErr(
      `  ✗ Nothing was recorded. No deepPairing project at or above ${io.projectRoot} (no .deeppairing/ with sessions, preferences.json or daemon.json).\n` +
      "    Run this from your project once deepPairing has started there (or after `deeppairing init`).\n",
    );
    return 1;
  }
  const { what, why } = parseStanceArguments(args);
  const requestedBy = io.stdinIsTTY && io.env.CLAUDECODE !== "1" ? "user" : "unknown";
  const store = await io.openStore(root);
  try {
    const outcome = await recordStance(store, { what, why, addedVia: "cli", requestedBy });
    const { ok, text } = formatRecordStanceOutcome(outcome, `Project ${path.basename(root)} (${root})`);
    if (ok) io.write(`${text.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
    else io.writeErr(`  ✗ ${text}\n`);
    return ok ? 0 : 1;
  } finally {
    store.dispose?.();
  }
}
