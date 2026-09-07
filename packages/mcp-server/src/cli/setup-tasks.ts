/**
 * Shared idempotent project-setup tasks. Used by both:
 *   - `node packages/mcp-server/dist/cli/init.js init` (full setup, includes CLAUDE.md mutation)
 *   - The daemon on first startup (non-CLAUDE.md subset; the plugin install
 *     path skips `init` entirely, so the daemon picks up the slack)
 *
 * Every task here is idempotent and non-fatal: failures are reported to the
 * caller as `{ ok: false, message }` instead of throwing, so the daemon can
 * log them without crashing on read-only / sandboxed projects.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cliInvocation } from "../cli-invocation.js";
import { errorMessage } from "@deeppairing/shared";
import { CHECKPOINT_HOOK_SCRIPT, STOP_HOOK_SCRIPT } from "./hook-scripts.generated.js";
// P1 — the guardrail backstop's zero-I/O prefilter. The generated hook script is
// self-contained and cannot import at runtime, so we INTERPOLATE this literal
// into its source at generation time: the init-path copy and the plugin-bundled
// copy share one definition by construction, not by hand-maintenance. F14 — it
// lives in its own ~20-line module so this file (loaded on every CLI start)
// doesn't pull the matcher core into the cold start.

export type SetupResult =
  | { ok: true; changed: boolean; message: string }
  | { ok: false; message: string };

/**
 * X2 — cross-scope hook detection / dedup.
 *
 * Field bug: even after the own-the-row policy cleaned `.claude/settings.local.json`,
 * the user still saw "Ran 2 stop hooks." Claude Code merges hooks from
 * THREE scope files (user → project-shared → project-local) and runs every
 * matching entry. A deepPairing entry in any non-local scope survives every
 * project-level heal because the installer never touches those files.
 *
 * Policy:
 *   - `.claude/settings.local.json` (project-local, gitignored) is the
 *     CANONICAL home for deepPairing hooks. The installer owns the row
 *     there.
 *   - `.claude/settings.json` (project-shared, committable) and
 *     `~/.claude/settings.json` (user-level) MAY contain deepPairing
 *     entries left over from earlier installs OR (rarely) deliberate
 *     team / user choices. The installer DETECTS but never auto-modifies
 *     those — a confirm-then-clean path runs through `doctor --fix`.
 */
export interface ScopeFileInfo {
  /** Logical name shown to the user. */
  scope: "user" | "project-shared" | "project-local";
  /** Absolute path to the settings file. */
  path: string;
  /** Number of deepPairing entries detected in this scope under the given hook key. */
  count: number;
}

/** Map a hookKey ("Stop" | "PostToolUse" | "PreToolUse") to a substring marker
 *  that identifies a deepPairing entry without depending on the exact command. */
type HookKey = "Stop" | "PostToolUse" | "PreToolUse";

function scopeFiles(projectRoot: string): Array<{ scope: ScopeFileInfo["scope"]; path: string }> {
  return [
    { scope: "user", path: path.join(os.homedir(), ".claude", "settings.json") },
    { scope: "project-shared", path: path.join(projectRoot, ".claude", "settings.json") },
    { scope: "project-local", path: path.join(projectRoot, ".claude", "settings.local.json") },
  ];
}

/** Read JSON, return null on missing/malformed. */
function readJsonOrNull(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Count DP entries under hookKey in a single settings object (any shape).
 *  Exported so #197's near-miss fixtures can assert the anchored markers
 *  count only our own rows, not a user's similarly-named hooks. */
export function countDpEntries(settings: any, hookKey: HookKey, marker: (cmd: string) => boolean): number {
  const entries = settings?.hooks?.[hookKey];
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const e of entries) {
    if (typeof e?.command === "string" && marker(e.command)) { n++; continue; }
    if (Array.isArray(e?.hooks) && e.hooks.some((h: any) => typeof h?.command === "string" && marker(h.command))) { n++; continue; }
  }
  return n;
}

/** Scan all three Claude Code scopes for deepPairing entries under the
 *  given hook key. Returns one ScopeFileInfo per scope file that exists,
 *  whether or not it contains DP entries (count may be 0). */
export function detectCrossScopeDpEntries(
  projectRoot: string,
  hookKey: HookKey,
  marker: (cmd: string) => boolean,
): ScopeFileInfo[] {
  const out: ScopeFileInfo[] = [];
  for (const { scope, path: p } of scopeFiles(projectRoot)) {
    const settings = readJsonOrNull(p);
    if (settings === null) continue;
    out.push({ scope, path: p, count: countDpEntries(settings, hookKey, marker) });
  }
  return out;
}

/** Filter out every DP entry from `hookKey` in this single scope file.
 *  Non-DP entries (the user's / team's other hooks) are left intact.
 *  Returns the count removed. The caller is responsible for confirming
 *  with the user before invoking — this writes to disk unconditionally. */
export function cleanDpEntriesFromScope(
  scopePath: string,
  hookKey: HookKey,
  marker: (cmd: string) => boolean,
): { ok: boolean; removed: number; message: string } {
  const settings = readJsonOrNull(scopePath);
  if (settings === null) return { ok: true, removed: 0, message: `Skipped ${scopePath} (missing or malformed)` };
  const entries = settings?.hooks?.[hookKey];
  if (!Array.isArray(entries)) return { ok: true, removed: 0, message: `No ${hookKey} entries in ${scopePath}` };
  const before = entries.length;
  const kept = entries.filter((e: any) => {
    if (typeof e?.command === "string" && marker(e.command)) return false;
    if (Array.isArray(e?.hooks) && e.hooks.some((h: any) => typeof h?.command === "string" && marker(h.command))) return false;
    return true;
  });
  const removed = before - kept.length;
  if (removed === 0) return { ok: true, removed: 0, message: `No deepPairing ${hookKey} entries to remove in ${scopePath}` };
  try {
    settings.hooks[hookKey] = kept;
    fs.writeFileSync(scopePath, JSON.stringify(settings, null, 2));
    return { ok: true, removed, message: `Removed ${removed} deepPairing ${hookKey} entr${removed === 1 ? "y" : "ies"} from ${scopePath}` };
  } catch (err) {
    return { ok: false, removed: 0, message: `Could not write ${scopePath}: ${errorMessage(err)}` };
  }
}

/**
 * Marker functions used both by the installer (own-the-row in .local) and by
 * the cross-scope detector / doctor. This is the SINGLE source of truth — every
 * own-the-row check and every detector routes through `HOOK_MARKERS.<Key>`, so a
 * future installer command-string change updates all paths together (there is no
 * divergent inline copy to keep in lock-step).
 *
 * #197 — the markers are ANCHORED to the canonical `.deeppairing/hooks/<name>.mjs`
 * path we actually install, NOT a loose basename substring. The bug: the old
 * `hooks/stop.mjs` / `checkpoint.mjs` / `preflight.mjs` substrings also matched a
 * user's OWN unrelated rows — `node ./my-own/hooks/stop.mjs`,
 * `node ./x/checkpoint.mjs`, `node ./ci/preflight.mjs --lint` — so `doctor --fix`
 * and every `ensure*` own-the-row installer would DELETE them (data loss). The
 * anchor `.deeppairing/hooks/<name>.mjs` is present in every command variant we
 * write — the bare-relative form and the `$CLAUDE_PROJECT_DIR/`-prefixed form both
 * contain it — so tightening loses no recognition of our own rows.
 *
 * The Stop marker DELIBERATELY keeps the bare `deepPairing` arm as well: it
 * recognizes the genuinely-legacy single-command installs (pre-file-based era,
 * e.g. `node -e '...deepPairing...'`). That arm is itself a weaker substring, but
 * tightening it would risk dropping recognition of those legacy rows, and unlike
 * the file-path arm it does not collide with a plausible user command — so it
 * stays.
 */
export const HOOK_MARKERS = {
  Stop: (cmd: string) =>
    cmd.includes("deepPairing") || cmd.includes(".deeppairing/hooks/stop.mjs"),
  PostToolUse: (cmd: string) => cmd.includes(".deeppairing/hooks/checkpoint.mjs"),
  PreToolUse: (cmd: string) => cmd.includes(".deeppairing/hooks/preflight.mjs"),
} as const;

export type LocalHookState = "ok" | "missing" | "legacy" | "redundant";
export interface LocalHookDiagnosis {
  hook: HookKey;
  state: LocalHookState;
}

/**
 * #196 — reconcile the THREE deepPairing hooks in a project's
 * `.claude/settings.local.json` against whether we're running plugin-managed.
 *
 * The plugin declares the Stop + PreToolUse (preflight) hooks NATIVELY in
 * `hooks/hooks.json`, and Claude Code does NOT dedupe across sources — so a
 * project-local copy of EITHER fires a SECOND time on every event
 * ("redundant"). The PostToolUse checkpoint has no plugin equivalent, so it
 * belongs in `settings.local.json` in every mode. Outside plugin mode all
 * three belong there, so a missing one is "missing" (and a legacy flat-shape
 * Stop entry — `{command}` with no nested `hooks[]` — is "legacy").
 *
 * Pure over the on-disk file + the plugin-managed flag, so `doctor` can turn
 * each verdict into a report line + a fix, and tests can assert both
 * directions without spawning anything.
 */
export function diagnoseLocalHooks(projectRoot: string, pluginManaged: boolean): LocalHookDiagnosis[] {
  const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
  const settings = readJsonOrNull(settingsPath);

  const stopPresent = countDpEntries(settings, "Stop", HOOK_MARKERS.Stop) > 0;
  const stopEntries = Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : [];
  const stopLegacy = stopEntries.some(
    (e: any) => typeof e?.command === "string" && HOOK_MARKERS.Stop(e.command) && !Array.isArray(e?.hooks),
  );
  const checkpointPresent = countDpEntries(settings, "PostToolUse", HOOK_MARKERS.PostToolUse) > 0;
  const preflightPresent = countDpEntries(settings, "PreToolUse", HOOK_MARKERS.PreToolUse) > 0;

  const stopState: LocalHookState = pluginManaged
    ? (stopPresent ? "redundant" : "ok")
    : (stopPresent ? (stopLegacy ? "legacy" : "ok") : "missing");
  const checkpointState: LocalHookState = checkpointPresent ? "ok" : "missing";
  const preflightState: LocalHookState = pluginManaged
    ? (preflightPresent ? "redundant" : "ok")
    : (preflightPresent ? "ok" : "missing");

  return [
    { hook: "Stop", state: stopState },
    { hook: "PostToolUse", state: checkpointState },
    { hook: "PreToolUse", state: preflightState },
  ];
}

export function ensureDeepPairingDir(projectRoot: string): SetupResult {
  const dpDir = path.join(projectRoot, ".deeppairing");
  try {
    if (fs.existsSync(dpDir)) {
      return { ok: true, changed: false, message: ".deeppairing/ already exists" };
    }
    fs.mkdirSync(dpDir, { recursive: true });
    return { ok: true, changed: true, message: "Created .deeppairing/" };
  } catch (err) {
    return { ok: false, message: `Could not create .deeppairing/: ${errorMessage(err)}` };
  }
}

export function ensureGitignoreEntry(projectRoot: string): SetupResult {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  try {
    if (!fs.existsSync(gitignorePath)) {
      // No .gitignore at all — likely not a git repo, or user manages
      // ignores elsewhere. Don't create one out of nowhere.
      return { ok: true, changed: false, message: "No .gitignore present (skipped)" };
    }
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (content.includes(".deeppairing/") || content.includes(".deeppairing")) {
      return { ok: true, changed: false, message: ".gitignore already lists .deeppairing/" };
    }
    const sep = content.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(gitignorePath, `${sep}.deeppairing/\n`);
    return { ok: true, changed: true, message: "Added .deeppairing/ to .gitignore" };
  } catch (err) {
    return { ok: false, message: `Could not update .gitignore: ${errorMessage(err)}` };
  }
}

/**
 * Stop hook keeps the agent from declaring "done" while artifacts still need
 * human review. Without it, the agent can fire-and-forget present_findings
 * and exit before the user has a chance to triage in the companion UI.
 *
 * X9 — a real .mjs file, not an inline `node -e "..."`: editable, debuggable,
 * no shell+JSON+JS triple-escaping.
 *
 * #342 — the script is no longer a template literal here. It is esbuild output
 * of `src/cli/stop-hook-entry.ts` (the SAME entry the plugin's
 * `server/stop.mjs` is built from), embedded by
 * `scripts/generate-hook-scripts.mjs`. The behaviour, the age guard and the
 * hooks-state fire log all live in `src/hooks/stop-hook.ts` and are
 * typechecked and unit-testable there.
 */
const STOP_SCRIPT_REL_PATH = ".deeppairing/hooks/stop.mjs";
// Anchor the command at $CLAUDE_PROJECT_DIR, NOT a bare relative path: Claude
// Code runs hooks with whatever cwd the session is in, which is not guaranteed
// to be the repo root (e.g. after a `cd` into a subdir for a build), so a
// relative `node .deeppairing/hooks/stop.mjs` resolves to <cwd>/.deeppairing/…
// and fails with MODULE_NOT_FOUND. $CLAUDE_PROJECT_DIR is cwd-independent.
const STOP_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${STOP_SCRIPT_REL_PATH}"`;

export function ensureStopHook(projectRoot: string): SetupResult {
  const claudeDir = path.join(projectRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const scriptPath = path.join(projectRoot, STOP_SCRIPT_REL_PATH);
  try {
    // X7 / X9 — write the real .mjs file (overwrite is safe; the script
    // is generated, not user-edited). Same pattern as checkpoint.mjs.
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, STOP_HOOK_SCRIPT);
    fs.chmodSync(scriptPath, 0o755);

    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {
        // Malformed settings — don't clobber the user's file. They have to
        // fix it themselves; we report and bail.
        return { ok: false, message: ".claude/settings.local.json is malformed; refusing to overwrite" };
      }
    }

    settings.hooks = settings.hooks ?? {};
    settings.hooks.Stop = settings.hooks.Stop ?? [];

    // Field bug history:
    //   1. Earlier installers wrote the legacy flat { command } shape,
    //      which produced "Invalid settings / hooks: Expected array"
    //      warnings.
    //   2. Successive command updates (e.g. adding the 30-min age guard)
    //      produced new nested entries while leaving the OLD nested
    //      entry in place — net: the user saw "Ran 2 stop hooks" with
    //      one running stale logic.
    //
    // Defense: own the deepPairing row completely. On every install,
    // drop ANY entry that looks like a deepPairing entry (flat or
    // nested, current command or stale command), then write exactly
    // ONE canonical entry. Non-DP entries (someone else's user hook)
    // are left strictly alone.
    //
    // X7 — the marker also catches the new file-based command (`node
    // "$CLAUDE_PROJECT_DIR/.deeppairing/hooks/stop.mjs"`). #197 — route the
    // own-the-row recognition through the SINGLE exported HOOK_MARKERS.Stop
    // (no inline copy) so the installer and doctor cannot disagree, and so the
    // anchored `.deeppairing/hooks/stop.mjs` match never sweeps a user's own
    // `node ./my-own/hooks/stop.mjs` row.
    const isDpStopEntry = (entry: any) => {
      if (typeof entry?.command === "string" && HOOK_MARKERS.Stop(entry.command)) return true; // legacy flat
      if (Array.isArray(entry?.hooks)) {
        return entry.hooks.some((h: any) => typeof h?.command === "string" && HOOK_MARKERS.Stop(h.command));
      }
      return false;
    };
    const isLegacyFlatDp = (entry: any) =>
      typeof entry?.command === "string" && HOOK_MARKERS.Stop(entry.command) && !Array.isArray(entry?.hooks);
    const isCurrentCanonicalDp = (entry: any) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.length === 1 &&
      entry.hooks[0]?.type === "command" &&
      entry.hooks[0]?.command === STOP_HOOK_COMMAND &&
      entry?.matcher === "";

    const beforeDpCount = settings.hooks.Stop.filter(isDpStopEntry).length;
    const hadLegacy = settings.hooks.Stop.some(isLegacyFlatDp);
    const hasExactlyOneCanonical =
      beforeDpCount === 1 && settings.hooks.Stop.some(isCurrentCanonicalDp);

    if (hasExactlyOneCanonical) {
      return { ok: true, changed: false, message: "Stop hook already configured" };
    }

    // Replace ALL deepPairing entries with the single canonical one. This
    // catches: legacy flat shape, stale nested entries from older code
    // versions, AND accidental duplicates from concurrent installs.
    settings.hooks.Stop = settings.hooks.Stop.filter((entry: any) => !isDpStopEntry(entry));
    settings.hooks.Stop.push({
      matcher: "",
      hooks: [{ type: "command", command: STOP_HOOK_COMMAND }],
    });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    let msg = hadLegacy
      ? "Added Stop hook (replaced legacy flat-shape entry that triggered /doctor warnings)"
      : beforeDpCount > 1
        ? `Added Stop hook (replaced ${beforeDpCount} stale deepPairing entries)`
        : beforeDpCount === 1
          ? "Replaced stale Stop hook entry with the current canonical version"
          : "Added Stop hook to .claude/settings.local.json";

    // X2 — surface cross-scope DP entries (user-level + project-shared)
    // so the user can heal them via `doctor --fix`. We never auto-modify
    // those scopes from this code path — the team / user might have
    // intentionally placed a hook there, and silently nuking files
    // outside .local would be hostile.
    const otherScopes = detectCrossScopeDpEntries(projectRoot, "Stop", HOOK_MARKERS.Stop)
      .filter((s) => s.scope !== "project-local" && s.count > 0);
    const [firstScope] = otherScopes;
    if (firstScope) {
      const summary = otherScopes.map((s) => `${s.scope} (${s.count})`).join(", ");
      msg += ` — but ${otherScopes.reduce((a, b) => a + b.count, 0)} cross-scope deepPairing entr${firstScope.count === 1 && otherScopes.length === 1 ? "y" : "ies"} also detected in ${summary}; run \`${cliInvocation("doctor --fix")}\` to clean them.`;
    }
    return { ok: true, changed: true, message: msg };
  } catch (err) {
    return { ok: false, message: `Could not configure Stop hook: ${errorMessage(err)}` };
  }
}

/**
 * V2 — PostToolUse "checkpoint" hook. Fires after every Write/Edit/MultiEdit
 * and nags the agent into calling present_code_change BEFORE the next edit.
 * The threshold is 1 (deliberately strict): the protocol says "before each
 * Write/Edit", so the FIRST Write without a preceding code_change is already
 * a violation.
 *
 * Why a real script file (not an inline `node -e "..."`):
 * shell+JSON+JS triple-escaping made the inline version unmaintainable and
 * silently broke. Writing to disk gives us a hook that is debuggable (run
 * .deeppairing/hooks/checkpoint.mjs directly), editable (a team can soften the
 * rule by tweaking the file), and testable via execSync without escape
 * gymnastics.
 *
 * #342 — the script is no longer a template literal here. It is esbuild output
 * of `src/cli/checkpoint-hook-entry.ts`, embedded by
 * `scripts/generate-hook-scripts.mjs`. The skip-list, the #335 one-shot
 * file/session receipt claim and the hooks-state fire log all live in
 * `src/hooks/checkpoint-hook.ts`, typechecked and unit-testable.
 */

const CHECKPOINT_SCRIPT_REL_PATH = ".deeppairing/hooks/checkpoint.mjs";

export function ensureCheckpointHook(projectRoot: string): SetupResult {
  const claudeDir = path.join(projectRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const scriptPath = path.join(projectRoot, CHECKPOINT_SCRIPT_REL_PATH);
  try {
    // 1. Always write the latest hook script — idempotent overwrite is fine
    //    because the script is generated, not user-edited.
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, CHECKPOINT_HOOK_SCRIPT);
    fs.chmodSync(scriptPath, 0o755);

    // 2. Wire the hook into .claude/settings.local.json (idempotent).
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {
        return { ok: false, message: ".claude/settings.local.json is malformed; refusing to overwrite" };
      }
    }
    settings.hooks = settings.hooks ?? {};
    settings.hooks.PostToolUse = settings.hooks.PostToolUse ?? [];

    // Same own-the-row policy as ensureStopHook: any entry that looks
    // like a deepPairing checkpoint hook (any shape, any command
    // version) gets dropped and replaced with the canonical current
    // entry. Prevents accumulation of stale duplicates as the hook
    // command evolves.
    // $CLAUDE_PROJECT_DIR-anchored (not relative) so the hook resolves
    // regardless of the session cwd — see STOP_HOOK_COMMAND for the rationale.
    const CANONICAL_CMD = `node "$CLAUDE_PROJECT_DIR/${CHECKPOINT_SCRIPT_REL_PATH}"`;
    // #197 — route own-the-row recognition through the SINGLE exported
    // HOOK_MARKERS.PostToolUse (anchored to `.deeppairing/hooks/checkpoint.mjs`),
    // not an inline `checkpoint.mjs` substring that would sweep a user's own
    // `node ./x/checkpoint.mjs` row.
    const isDpCheckpointEntry = (entry: any) => {
      if (typeof entry?.command === "string" && HOOK_MARKERS.PostToolUse(entry.command)) return true;
      if (Array.isArray(entry?.hooks)) {
        return entry.hooks.some((h: any) => typeof h?.command === "string" && HOOK_MARKERS.PostToolUse(h.command));
      }
      return false;
    };
    const isCurrentCanonicalDp = (entry: any) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.length === 1 &&
      entry.hooks[0]?.type === "command" &&
      entry.hooks[0]?.command === CANONICAL_CMD &&
      entry?.matcher === "Write|Edit|MultiEdit";

    const beforeDpCount = settings.hooks.PostToolUse.filter(isDpCheckpointEntry).length;
    const hasExactlyOneCanonical =
      beforeDpCount === 1 && settings.hooks.PostToolUse.some(isCurrentCanonicalDp);

    if (hasExactlyOneCanonical) {
      return { ok: true, changed: false, message: "Checkpoint hook already configured" };
    }

    settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((entry: any) => !isDpCheckpointEntry(entry));
    settings.hooks.PostToolUse.push({
      matcher: "Write|Edit|MultiEdit",
      hooks: [{ type: "command", command: CANONICAL_CMD }],
    });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    let msg = beforeDpCount > 1
      ? `Added PostToolUse checkpoint hook (replaced ${beforeDpCount} stale entries)`
      : beforeDpCount === 1
        ? "Replaced stale checkpoint hook entry with the current canonical version"
        : "Added PostToolUse checkpoint hook (.deeppairing/hooks/checkpoint.mjs)";

    // X2 — same cross-scope detection as Stop hook.
    const otherScopes = detectCrossScopeDpEntries(projectRoot, "PostToolUse", HOOK_MARKERS.PostToolUse)
      .filter((s) => s.scope !== "project-local" && s.count > 0);
    const [firstScope] = otherScopes;
    if (firstScope) {
      const summary = otherScopes.map((s) => `${s.scope} (${s.count})`).join(", ");
      msg += ` — but ${otherScopes.reduce((a, b) => a + b.count, 0)} cross-scope checkpoint entr${firstScope.count === 1 && otherScopes.length === 1 ? "y" : "ies"} also detected in ${summary}; run \`${cliInvocation("doctor --fix")}\` to clean them.`;
    }
    return { ok: true, changed: true, message: msg };
  } catch (err) {
    return { ok: false, message: `Could not configure checkpoint hook: ${errorMessage(err)}` };
  }
}

/**
 * Run the subset of setup tasks the daemon should perform on first spawn.
 * NOTE: CLAUDE.md mutation is intentionally NOT here — silently rewriting
 * a user's CLAUDE.md from a background daemon spawned by an MCP install
 * would surprise people. That stays opt-in via `node packages/mcp-server/dist/cli/init.js init`.
 */
// ---------------------------------------------------------------------------
// WP5 — PreToolUse preflight hook. The MCP-side preflight only fires when the
// agent voluntarily announces intent via a present_* tool; a model that calls
// Edit/Write directly sails past the gate. This hook runs the SAME matcher
// against the actual tool call at the platform level, so the rejected-approach
// block holds even when the protocol is skipped.
// ---------------------------------------------------------------------------
const PREFLIGHT_SCRIPT_REL_PATH = ".deeppairing/hooks/preflight.mjs";
const PREFLIGHT_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${PREFLIGHT_SCRIPT_REL_PATH}"`;
const PREFLIGHT_MATCHER = "Write|Edit|MultiEdit";

/** Absolute file URL of the built matcher core, so the generated hook (which
 *  runs via plain `node` from .deeppairing/hooks/) can import it regardless of
 *  install layout. Prefers the built dist/cli copy; falls back gracefully. If
 *  none exists (e.g. an unbuilt dev tree) the hook fails OPEN at import time. */
function resolvePreflightCoreUrl(): { url: string; exists: boolean } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distCandidate = path.join(here, "preflight-hook-core.js"); // dist/cli (built / prod)
  const candidates = [
    distCandidate,
    path.join(here, "../../dist/cli/preflight-hook-core.js"), // src/cli via tsx, after a build
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  // Stamp the best-guess path even when missing so a later build self-heals on
  // the next daemon startup (re-stamp); `exists` lets the installer report
  // honestly that the gate is inactive until then.
  return { url: pathToFileURL(found ?? distCandidate).href, exists: Boolean(found) };
}

/** Q1 — absolute file URL of the built guardrail RULE TABLE (the leaf module),
 *  so the generated hook's early exit can call the AUTHORITATIVE matcher
 *  instead of a hand-written prefilter regex. Same stamping discipline as
 *  resolvePreflightCoreUrl; the leaf sits one directory up from the core
 *  (dist/guardrail-rules.js vs dist/cli/preflight-hook-core.js). */
function resolveGuardrailRulesUrl(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Marketplace / --plugin-dir: bundle-plugin.mjs emits it BESIDE the entry,
  // same as preflight-hook-core.js. Checked first for the same reason.
  const besideEntry = path.join(here, "guardrail-rules.js");
  const distCandidate = path.join(here, "..", "guardrail-rules.js"); // dist/cli → dist
  const candidates = [
    besideEntry,
    distCandidate,
    path.join(here, "../../dist/guardrail-rules.js"), // src/cli via tsx, after a build
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  // Stamp the best guess even when missing so a later build self-heals on the
  // next re-stamp; the generated hook treats an import failure as "keep going"
  // rather than "skip the backstop" (see targetsGuardrailPath).
  return pathToFileURL(found ?? distCandidate).href;
}

function preflightHookScript(coreUrl: string, rulesUrl: string): string {
  return `#!/usr/bin/env node
// deepPairing PreToolUse preflight hook — installed by ensurePreflightHook.
// GENERATED, do not edit. ESM (.mjs): use import, not require.
// Runs the SAME rejected-approach matcher the MCP-side preflight uses, against
// the agent's actual Edit/Write/MultiEdit, so a direct edit that matches a
// previously-rejected approach can't silently bypass the gate. It surfaces the
// match to the HUMAN (permissionDecision: "ask") rather than hard-denying:
// matching raw file content is noisier than the agent's reasoning prose, and a
// change the human already approved in the UI must not be auto-blocked when
// applied. "ask" keeps the human in the loop (pairing) and is recoverable.
// P1 — it ALSO runs the guardrail backstop: a write to a guardrail path
// (migrations, .github/workflows, infra, .env) with no live pre-work ceremony in
// the session asks the human too. Same "ask", never "deny", still fail-open.
import fs from "node:fs";
import path from "node:path";

// Built matcher core, stamped at install time (see resolvePreflightCoreUrl).
const CORE_URL = ${JSON.stringify(coreUrl)};
// Q1 — the guardrail RULE TABLE's leaf module (node:path only), stamped the
// same way. See the guardrail note below the ledger pre-check.
const RULES_URL = ${JSON.stringify(rulesUrl)};

// F11 — the fire log + the guardrail dedup stamp are ONE read-modify-write, and
// they live in the matcher core (mod.recordHookFire) so this generated copy and
// the plugin-bundled copy cannot drift on the write shape. It's only ever
// called AFTER the dynamic import, so the fast path above pays nothing for it.

// PP1 — cheap pre-check so the common case (no rejections seeded, no team.json)
// skips the ~40ms dynamic import of the matcher core entirely. Reading the small
// preferences.json is ms; the import is the cost. If there's nothing to match
// against, exit before importing.
function ledgersPresent(projectRoot) {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(projectRoot, ".deeppairing", "preferences.json"), "utf-8"));
    if (Array.isArray(prefs && prefs.rejectedApproaches) && prefs.rejectedApproaches.length > 0) return true;
  } catch {}
  try {
    if (fs.existsSync(path.join(projectRoot, ".deeppairing", "team.json"))) return true;
  } catch {}
  return false;
}

// Q1 — the GUARDRAIL BACKSTOP's early-exit test. The backstop has no ledger to
// be seeded, so the ledger fast-path above would hide it entirely; a guardrail
// path is the second reason to keep going.
//
// This used to be a hand-written "loose superset" regex INTERPOLATED from
// preflight-hook-core, described as parity "by construction". It was not: its
// trailing group rejected -/_ continuations, so Dockerfile-prod,
// docker-compose-prod.yml, config/secrets_prod.yml and prod.tfvars.json failed
// the prefilter while the rules guarded them — silently disabling the backstop
// on those paths in every ledger-free project. It is DELETED. What runs now is
// matchGuardrailPath itself, out of the leaf rule-table module: node:path and
// nothing else.
//
// The honest end-to-end cost, since the deleted prefilter was zero-I/O and this
// is not: a NET +1.4 ms (native FS) / +21 ms (WSL 9P mount) per hook
// invocation, and ONLY on this path — the init-generated script in a project
// with no ledger seeded. It is zero on the marketplace path (esbuild inlines
// the matcher into preflight.mjs, so there is no import at all), and zero once
// any ledger exists (ledgersPresent short-circuits before this runs). Component
// numbers: leaf import 1.4 ms / 20 ms, match 0.0018 ms, versus the 7.8 ms /
// 51 ms matcher-core import this fast path exists to avoid.
//
// That is the price of the early exit being the SAME function as the gate it
// guards, so it cannot disagree with it — which is why the prefilter was
// deleted outright rather than derived: a second definition, however generated,
// is a second thing to get wrong.
async function targetsGuardrailPath(projectRoot, toolInput) {
  const fp = (toolInput && (toolInput.file_path || toolInput.filePath)) || "";
  if (typeof fp !== "string" || !fp) return false;
  try {
    const rules = await import(RULES_URL);
    return rules.matchGuardrailPath(projectRoot, [fp]) !== null;
  } catch {
    // FAIL SAFE, not fail-silent: if the rule module can't be loaded (an
    // unbuilt tree, a moved install), keep going and let the matcher core —
    // which carries the same table — decide. A load error must never be the
    // thing that quietly switches the backstop off; that is the exact failure
    // this rewrite exists to remove. The hook as a whole still fails OPEN.
    return true;
  }
}

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", async () => {
  try {
    const ev = JSON.parse(input || "{}");
    const toolName = ev.tool_name || "";
    const toolInput = ev.tool_input || ev.input || {};
    // R1 (#279) — one documented precedence in every hook lane:
    // CLAUDE_PROJECT_DIR > DEEPPAIRING_PROJECT_ROOT > the event's cwd > ours.
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.env.DEEPPAIRING_PROJECT_ROOT || ev.cwd || process.cwd();
    if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit") {
      process.exit(0);
    }
    if (!ledgersPresent(projectRoot) && !(await targetsGuardrailPath(projectRoot, toolInput))) {
      process.exit(0); // nothing to match against — skip the matcher import
    }
    const mod = await import(CORE_URL);
    const decision = mod.evaluatePreflightHook({ toolName, toolInput, projectRoot });
    if (decision && decision.fire) {
      mod.recordHookFire(projectRoot, decision);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: decision.reason || "This change matches a previously-rejected approach.",
        },
      }));
    }
    // no match = exit 0 with no decision JSON (tool proceeds)
    process.exit(0);
  } catch (err) {
    // FAIL OPEN — a broken hook must never block the user's edits.
    try { process.stderr.write("[deepPairing] preflight hook error: " + String((err && err.message) || err) + "\\n"); } catch {}
    process.exit(0);
  }
});
`;
}

/** Install the PreToolUse preflight hook (matcher Write|Edit|MultiEdit). Owns
 *  the deepPairing PreToolUse row: drops any prior DP entry and writes exactly
 *  one canonical entry (same own-the-row discipline as the Stop hook). */
export function ensurePreflightHook(projectRoot: string): SetupResult {
  const claudeDir = path.join(projectRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const scriptPath = path.join(projectRoot, PREFLIGHT_SCRIPT_REL_PATH);
  try {
    const core = resolvePreflightCoreUrl();
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, preflightHookScript(core.url, resolveGuardrailRulesUrl()));
    fs.chmodSync(scriptPath, 0o755);
    // Honest signal — if the matcher core isn't built, the hook installs but
    // fails open (gate inactive) until a build + re-stamp on next startup.
    const inactiveNote = core.exists ? "" : " (matcher core not built yet — gate inactive until next build)";

    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {
        return { ok: false, message: ".claude/settings.local.json is malformed; refusing to overwrite" };
      }
    }
    settings.hooks = settings.hooks ?? {};
    settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? [];

    const isDpEntry = (entry: any) => {
      if (typeof entry?.command === "string" && HOOK_MARKERS.PreToolUse(entry.command)) return true;
      if (Array.isArray(entry?.hooks)) {
        return entry.hooks.some((h: any) => typeof h?.command === "string" && HOOK_MARKERS.PreToolUse(h.command));
      }
      return false;
    };
    const isCanonical = (entry: any) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.length === 1 &&
      entry.hooks[0]?.type === "command" &&
      entry.hooks[0]?.command === PREFLIGHT_HOOK_COMMAND &&
      entry?.matcher === PREFLIGHT_MATCHER;

    const beforeCount = settings.hooks.PreToolUse.filter(isDpEntry).length;
    if (beforeCount === 1 && settings.hooks.PreToolUse.some(isCanonical)) {
      return { ok: true, changed: false, message: `PreToolUse preflight hook already configured${inactiveNote}` };
    }
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((e: any) => !isDpEntry(e));
    settings.hooks.PreToolUse.push({
      matcher: PREFLIGHT_MATCHER,
      hooks: [{ type: "command", command: PREFLIGHT_HOOK_COMMAND }],
    });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { ok: true, changed: true, message: `Installed PreToolUse preflight hook${inactiveNote}` };
  } catch (err) {
    return { ok: false, message: `Failed to install preflight hook: ${err}` };
  }
}

/**
 * I6 — double-fire guard. When deepPairing runs as the Claude Code plugin, the
 * plugin already declares the Stop + PreToolUse preflight hooks natively in
 * claude-plugin/hooks/hooks.json (invoking the self-contained bundles beside
 * daemon.js). Claude Code does NOT dedupe hooks across sources, so if the
 * daemon ALSO wrote those hooks into .claude/settings.local.json both copies
 * would fire on every event. Detected two ways (belt-and-suspenders):
 *
 *   1. CLAUDE_PLUGIN_ROOT — Claude Code sets this for plugin-spawned processes;
 *      the daemon inherits it through the spawn's `{ ...process.env }`.
 *   2. Filesystem — the bundled daemon lives at <pluginRoot>/server/daemon.js
 *      (setup-tasks is inlined into it), so a sibling ../.claude-plugin/plugin.json
 *      marks the plugin layout even if the env var didn't propagate.
 *
 * The PostToolUse checkpoint hook has NO plugin equivalent, so the daemon still
 * installs it in every mode.
 */
export function isPluginManaged(): boolean {
  if (process.env.CLAUDE_PLUGIN_ROOT) return true;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return fs.existsSync(path.join(here, "..", ".claude-plugin", "plugin.json"));
  } catch {
    return false;
  }
}

export function runDaemonStartupSetup(projectRoot: string): SetupResult[] {
  const results: SetupResult[] = [ensureDeepPairingDir(projectRoot), ensureGitignoreEntry(projectRoot)];
  if (isPluginManaged()) {
    // Plugin owns the Stop + preflight rows via hooks/hooks.json — writing them
    // here too would double-fire. Checkpoint has no plugin equivalent; keep it.
    results.push({
      ok: true,
      changed: false,
      message: "Stop + preflight hooks provided by the plugin (skipped settings.local.json install)",
    });
    results.push(ensureCheckpointHook(projectRoot));
  } else {
    results.push(ensureStopHook(projectRoot));
    results.push(ensureCheckpointHook(projectRoot));
    results.push(ensurePreflightHook(projectRoot));
  }
  return results;
}
