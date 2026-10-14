import fs from "node:fs";
import path from "node:path";
import { findLinkedWorktree } from "./git-worktree.js";
import { countDpEntries, HOOK_MARKERS } from "./cli/setup-tasks.js";

/**
 * #538 — npm/`init` installs keep their hook rows in the gitignored
 * `.claude/settings.local.json` (+ `.deeppairing/hooks/`), so a fresh git
 * worktree of an initialised checkout has NO deepPairing hooks: no rejection
 * gate, no state guardrail, no checkpoint. #536 shares the ledger across
 * worktrees but cannot add the missing rows. This is DETECTION only: nothing is
 * ever written.
 */

function hasInitHookRows(dir: string): boolean {
  for (const file of ["settings.local.json", "settings.json"]) {
    let settings: unknown;
    try {
      settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", file), "utf-8"));
    } catch {
      continue;
    }
    if (
      countDpEntries(settings, "Stop", HOOK_MARKERS.Stop) > 0 ||
      countDpEntries(settings, "PostToolUse", HOOK_MARKERS.PostToolUse) > 0 ||
      countDpEntries(settings, "PreToolUse", HOOK_MARKERS.PreToolUse) > 0
    ) return true;
  }
  return false;
}

export interface WorktreeMissingHooks {
  mainTop: string;
  worktreeTop: string;
}

/**
 * Non-null when `workspaceDir` is inside a VALIDATED linked worktree (the
 * #536 back-pointer check in git-worktree.ts), the main checkout has
 * deepPairing init hook rows, and the worktree has none of its own.
 * Plugin handling is the caller's: pass nothing for plugin-provided hooks.
 */
export function detectWorktreeMissingHooks(workspaceDir: string): WorktreeMissingHooks | null {
  try {
    const wt = findLinkedWorktree(workspaceDir);
    if (!wt) return null;
    if (!hasInitHookRows(wt.mainTop) || hasInitHookRows(wt.worktreeTop)) return null;
    return { mainTop: wt.mainTop, worktreeTop: wt.worktreeTop };
  } catch {
    return null;
  }
}

/** The warning text. `conditional` = plugin declared but activation unverified. */
export function worktreeMissingHooksMessage(d: WorktreeMissingHooks, conditional = false): string {
  const base = `This is a git worktree of ${d.mainTop}. deepPairing's hooks are installed in the main checkout but not here, so the rejection gate and guardrails won't run in this worktree.`;
  return conditional
    ? `${base} If the deepPairing plugin is enabled for this project its hooks apply here; if not, run \`deeppairing init\` here, or use the plugin install.`
    : `${base} Run \`deeppairing init\` here, or use the plugin install.`;
}
