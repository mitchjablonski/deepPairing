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
  ];
}
