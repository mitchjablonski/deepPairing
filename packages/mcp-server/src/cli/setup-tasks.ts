/**
 * Shared idempotent project-setup tasks. Used by both:
 *   - `npx deeppairing init` (full setup, includes CLAUDE.md mutation)
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

/** Map a hookKey ("Stop" | "PostToolUse") to a substring marker that
 *  identifies a deepPairing entry without depending on the exact command. */
type HookKey = "Stop" | "PostToolUse";

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

/** Count DP entries under hookKey in a single settings object (any shape). */
function countDpEntries(settings: any, hookKey: HookKey, marker: (cmd: string) => boolean): number {
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
  } catch (err: any) {
    return { ok: false, removed: 0, message: `Could not write ${scopePath}: ${err?.message ?? err}` };
  }
}

/** Marker functions used both by the installer (own-the-row in .local) and
 *  by the cross-scope detector. Centralized so a future installer
 *  command-string change updates both paths together. */
const STOP_HOOK_MARKER = (cmd: string) => cmd.includes("deepPairing");
const CHECKPOINT_HOOK_MARKER = (cmd: string) => cmd.includes("checkpoint.mjs");
export const HOOK_MARKERS = { Stop: STOP_HOOK_MARKER, PostToolUse: CHECKPOINT_HOOK_MARKER } as const;

export function ensureDeepPairingDir(projectRoot: string): SetupResult {
  const dpDir = path.join(projectRoot, ".deeppairing");
  try {
    if (fs.existsSync(dpDir)) {
      return { ok: true, changed: false, message: ".deeppairing/ already exists" };
    }
    fs.mkdirSync(dpDir, { recursive: true });
    return { ok: true, changed: true, message: "Created .deeppairing/" };
  } catch (err: any) {
    return { ok: false, message: `Could not create .deeppairing/: ${err?.message ?? err}` };
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
  } catch (err: any) {
    return { ok: false, message: `Could not update .gitignore: ${err?.message ?? err}` };
  }
}

/**
 * Stop hook keeps the agent from declaring "done" while artifacts still need
 * human review. Without it, the agent can fire-and-forget present_findings
 * and exit before the user has a chance to triage in the companion UI.
 *
 * U0.4 / U0.6 — age guard: drafts older than DRAFT_MAX_AGE_MS are treated as
 * abandoned (user moved on, agent shouldn't stay stuck forever). The default
 * is 30 minutes — long enough that an actively-reviewing user won't trigger
 * abandonment, short enough that a stale draft can't trap the agent in a poll
 * loop indefinitely. The hook uses createdAt because that's the only
 * universal timestamp on Artifact today (updatedAt arrived later and may be
 * missing on older sessions).
 */
const STOP_HOOK_COMMAND = `node -e "const fs=require('fs'),p=require('path');try{const d=p.join(process.cwd(),'.deeppairing','sessions');if(!fs.existsSync(d))process.exit(0);const MAX=30*60*1000;const now=Date.now();const s=fs.readdirSync(d);for(const id of s){const f=p.join(d,id,'artifacts.json');if(!fs.existsSync(f))continue;const a=JSON.parse(fs.readFileSync(f,'utf-8'));if(a.some(x=>{if(x.status!=='draft')return false;if(!['research','spec','plan','decision','code_change'].includes(x.type))return false;const t=x.createdAt?new Date(x.createdAt).getTime():0;if(t&&now-t>MAX)return false;return true})){console.log('deepPairing: pending artifacts need review — call check_feedback');process.exit(2)}}}catch{process.exit(0)}"`;

export function ensureStopHook(projectRoot: string): SetupResult {
  const claudeDir = path.join(projectRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  try {
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
    const isDpStopEntry = (entry: any) => {
      if (typeof entry?.command === "string" && entry.command.includes("deepPairing")) return true; // legacy flat
      if (Array.isArray(entry?.hooks)) {
        return entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("deepPairing"));
      }
      return false;
    };
    const isLegacyFlatDp = (entry: any) =>
      typeof entry?.command === "string" && entry.command.includes("deepPairing") && !Array.isArray(entry?.hooks);
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
    const otherScopes = detectCrossScopeDpEntries(projectRoot, "Stop", STOP_HOOK_MARKER)
      .filter((s) => s.scope !== "project-local" && s.count > 0);
    if (otherScopes.length > 0) {
      const summary = otherScopes.map((s) => `${s.scope} (${s.count})`).join(", ");
      msg += ` — but ${otherScopes.reduce((a, b) => a + b.count, 0)} cross-scope deepPairing entr${otherScopes[0].count === 1 && otherScopes.length === 1 ? "y" : "ies"} also detected in ${summary}; run \`npx deeppairing doctor --fix\` to clean them.`;
    }
    return { ok: true, changed: true, message: msg };
  } catch (err: any) {
    return { ok: false, message: `Could not configure Stop hook: ${err?.message ?? err}` };
  }
}

/**
 * V2 — PostToolUse "checkpoint" hook. Fires after every Write/Edit/MultiEdit
 * and exits 2 to nag the agent into calling present_code_change BEFORE the
 * next edit. The threshold is 1 (deliberately strict): the protocol says
 * "before each Write/Edit", so the FIRST Write without a preceding
 * code_change is already a violation.
 *
 * Why a real script file (not an inline `node -e "..."`):
 * shell+JSON+JS triple-escaping made the inline version unmaintainable and
 * silently broke. Writing to disk gives us:
 *   - debuggable (the script is in .deeppairing/hooks/, run it directly)
 *   - editable (a team can soften the rule by tweaking the file)
 *   - tested via execSync without escape gymnastics
 *
 * Implementation:
 *   - Read .deeppairing/sessions/&#x2A;/artifacts.json to find the most-recent
 *     code_change artifact's createdAt as the "last checkpoint" timestamp.
 *   - Read PostToolUse event payload from stdin (Claude Code's hook protocol).
 *   - If the tool isn't Write/Edit/MultiEdit, exit 0 (the matcher should
 *     have filtered, but we're belt-and-suspenders here).
 *   - If no code_change artifact exists OR the most recent one predates
 *     this PostToolUse event, exit 2 with a nag.
 */
const CHECKPOINT_HOOK_SCRIPT = `#!/usr/bin/env node
// deepPairing checkpoint hook (V2) — installed by ensureCheckpointHook.
// ESM (.mjs): use import, not require.
import fs from "node:fs";
import path from "node:path";

// V2.1 — skip-list for files that are unambiguously NOT worth a per-edit
// checkpoint. Scope is deliberately narrow: only generated/vendored paths
// and auto-generated lockfiles. Config / policy files (.gitignore,
// package.json, .npmrc, .prettierrc) DO get nagged — those represent real
// decisions a paired human should react to.
//
// Categories:
//   - Lockfiles: regenerated from a manifest, reviewing them is busy-work
//     (the manifest change is the real decision; deps are mechanical).
//   - Generated / vendored paths: outputs of a build, not human-authored.
//   - IDE-only dirs: editor settings; not the project's code.
//
// If a team wants stricter checkpointing they can edit this file directly
// (.deeppairing/hooks/checkpoint.mjs). To LOOSEN it (e.g. also auto-skip
// .gitignore), add the basename / prefix here.
const SKIP_BASENAMES = new Set([
  // Lockfiles only — manifest files (package.json, Cargo.toml, etc.) are
  // policy and should still nag.
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "uv.lock", "poetry.lock", "Cargo.lock", "Gemfile.lock", "go.sum",
  "composer.lock",
]);
const SKIP_PATH_PREFIXES = [
  // Generated / vendored output — not human-authored source.
  "dist/", "build/", "node_modules/", ".deeppairing/", ".next/",
  ".turbo/", ".cache/", "coverage/", ".nyc_output/",
  // IDE-local config — workspace settings, not project decisions.
  ".vscode/", ".idea/",
];

function isTrivialFile(filePath) {
  if (!filePath || filePath === "(unknown)") return false;
  const norm = filePath.replace(/\\\\/g, "/");
  const base = norm.split("/").pop() || "";
  if (SKIP_BASENAMES.has(base)) return true;
  // Match prefixes either at the start of the path or after the project root.
  for (const prefix of SKIP_PATH_PREFIXES) {
    if (norm.includes("/" + prefix) || norm.startsWith(prefix)) return true;
  }
  return false;
}

let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  try {
    const ev = stdin ? JSON.parse(stdin) : {};
    const tool = ev.tool_name || ev.toolName || "";
    if (!["Write", "Edit", "MultiEdit"].includes(tool)) process.exit(0);
    const filePath =
      (ev.tool_input && (ev.tool_input.file_path || ev.tool_input.filePath)) ||
      (ev.input && ev.input.file_path) ||
      "(unknown)";

    // V2.1 — trivial files (gitignore, lockfiles, generated paths) auto-pass.
    if (isTrivialFile(filePath)) process.exit(0);

    const sessionsDir = path.join(process.cwd(), ".deeppairing", "sessions");
    if (!fs.existsSync(sessionsDir)) process.exit(0);

    let mostRecentCheckpoint = 0;
    for (const id of fs.readdirSync(sessionsDir)) {
      const af = path.join(sessionsDir, id, "artifacts.json");
      if (!fs.existsSync(af)) continue;
      try {
        const arr = JSON.parse(fs.readFileSync(af, "utf-8"));
        for (const a of arr) {
          if (a.type !== "code_change") continue;
          const t = new Date(a.createdAt).getTime();
          if (t > mostRecentCheckpoint) mostRecentCheckpoint = t;
        }
      } catch { /* skip malformed session */ }
    }

    // Threshold rule: every Write needs a code_change artifact created in
    // the last FRESH_MS window. Phase 1 is intentionally simple — file-
    // identity tracking ("did the user already approve THIS file?") is
    // future work; right now we nag whenever the latest code_change is
    // stale or absent.
    const FRESH_MS = 60 * 1000;
    const ageMs = Date.now() - mostRecentCheckpoint;
    if (mostRecentCheckpoint === 0 || ageMs > FRESH_MS) {
      process.stdout.write(
        "deepPairing: " + tool + " on " + filePath +
        " without an intervening present_code_change. " +
        "Call present_code_change BEFORE the next edit so the human can react. " +
        "(Per-Edit Checkpoint rule — see the CLAUDE.md 'Per-Edit Checkpoint' section. " +
        "Config / generated files like .gitignore are auto-skipped.)\\n"
      );
      process.exit(2);
    }
    process.exit(0);
  } catch {
    // Never block the agent on a hook bug. Exit 0 on any unexpected error.
    process.exit(0);
  }
});
`;

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
    const CANONICAL_CMD = `node ${CHECKPOINT_SCRIPT_REL_PATH}`;
    const isDpCheckpointEntry = (entry: any) => {
      if (typeof entry?.command === "string" && entry.command.includes("checkpoint.mjs")) return true;
      if (Array.isArray(entry?.hooks)) {
        return entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("checkpoint.mjs"));
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
    const otherScopes = detectCrossScopeDpEntries(projectRoot, "PostToolUse", CHECKPOINT_HOOK_MARKER)
      .filter((s) => s.scope !== "project-local" && s.count > 0);
    if (otherScopes.length > 0) {
      const summary = otherScopes.map((s) => `${s.scope} (${s.count})`).join(", ");
      msg += ` — but ${otherScopes.reduce((a, b) => a + b.count, 0)} cross-scope checkpoint entr${otherScopes[0].count === 1 && otherScopes.length === 1 ? "y" : "ies"} also detected in ${summary}; run \`npx deeppairing doctor --fix\` to clean them.`;
    }
    return { ok: true, changed: true, message: msg };
  } catch (err: any) {
    return { ok: false, message: `Could not configure checkpoint hook: ${err?.message ?? err}` };
  }
}

/**
 * Run the subset of setup tasks the daemon should perform on first spawn.
 * NOTE: CLAUDE.md mutation is intentionally NOT here — silently rewriting
 * a user's CLAUDE.md from a background daemon spawned by an MCP install
 * would surprise people. That stays opt-in via `npx deeppairing init`.
 */
export function runDaemonStartupSetup(projectRoot: string): SetupResult[] {
  return [
    ensureDeepPairingDir(projectRoot),
    ensureGitignoreEntry(projectRoot),
    ensureStopHook(projectRoot),
    ensureCheckpointHook(projectRoot),
  ];
}
