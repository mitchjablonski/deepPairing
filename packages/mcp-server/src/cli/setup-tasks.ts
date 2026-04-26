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
import path from "node:path";

export type SetupResult =
  | { ok: true; changed: boolean; message: string }
  | { ok: false; message: string };

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
    const alreadyHasDp = Array.isArray(settings.hooks.Stop) &&
      settings.hooks.Stop.some((h: any) => typeof h?.command === "string" && h.command.includes("deepPairing"));
    if (alreadyHasDp) {
      return { ok: true, changed: false, message: "Stop hook already configured" };
    }

    settings.hooks.Stop.push({ command: STOP_HOOK_COMMAND });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { ok: true, changed: true, message: "Added Stop hook to .claude/settings.local.json" };
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

    const isDpCheckpointEntry = (entry: any) => {
      if (typeof entry?.command === "string" && entry.command.includes("checkpoint.mjs")) return true;
      if (Array.isArray(entry?.hooks)) {
        return entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("checkpoint.mjs"));
      }
      return false;
    };

    const alreadyHasDp =
      Array.isArray(settings.hooks.PostToolUse) &&
      settings.hooks.PostToolUse.some(isDpCheckpointEntry);

    if (alreadyHasDp) {
      return { ok: true, changed: false, message: "Checkpoint hook already configured" };
    }

    // V2 — matcher scopes the hook to file-mutating tools so we don't fire
    // on every Read/Bash. The script also re-checks the tool name as a
    // belt-and-suspenders guard.
    settings.hooks.PostToolUse.push({
      matcher: "Write|Edit|MultiEdit",
      hooks: [{ type: "command", command: `node ${CHECKPOINT_SCRIPT_REL_PATH}` }],
    });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { ok: true, changed: true, message: "Added PostToolUse checkpoint hook (.deeppairing/hooks/checkpoint.mjs)" };
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
