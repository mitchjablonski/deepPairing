/**
 * deepPairing Stop hook — plugin-bundled entry (I6).
 *
 * A faithful semantic port of setup-tasks.ts STOP_HOOK_SCRIPT so the
 * marketplace / `--plugin-dir` install ships the SAME "don't declare done
 * while artifacts await review" checkpoint the `init` path wires into
 * .claude/settings.local.json. Self-contained (Node builtins only) so esbuild
 * emits a zero-dependency file beside daemon.js that the plugin's
 * hooks/hooks.json invokes as `node "${CLAUDE_PLUGIN_ROOT}/server/stop.mjs"`.
 *
 * Behaviour must stay in lock-step with the init-path script:
 *   - surfaces unreviewed blocking drafts on stderr, exit 0 (non-blocking nag);
 *   - age-guards drafts older than 30 min as abandoned;
 *   - records every fire to .deeppairing/hooks-state.json for the UI.
 */
import fs from "node:fs";
import path from "node:path";

const HOOK_NAME = "stop";
const STATE_CAP = 50;
const MAX_AGE_MS = 30 * 60 * 1000;
const BLOCKING_TYPES = ["research", "spec", "plan", "decision", "code_change"];

function projectRoot(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function recordFire(exitCode: number, reason: string): void {
  try {
    const statePath = path.join(projectRoot(), ".deeppairing", "hooks-state.json");
    let state: { version?: number; fires?: unknown[] } = {};
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    } catch {
      /* fresh file */
    }
    state.version = 1;
    const fires = Array.isArray(state.fires) ? state.fires : [];
    fires.push({ at: new Date().toISOString(), hook: HOOK_NAME, exitCode, reason });
    state.fires = fires.slice(-STATE_CAP);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    /* recording must never fail the hook itself */
  }
}

function exit(code: number, reason: string): never {
  recordFire(code, reason);
  process.exit(code);
}

try {
  const sessionsDir = path.join(projectRoot(), ".deeppairing", "sessions");
  if (!fs.existsSync(sessionsDir)) exit(0, "no sessions dir");

  const now = Date.now();
  for (const id of fs.readdirSync(sessionsDir)) {
    const af = path.join(sessionsDir, id, "artifacts.json");
    if (!fs.existsSync(af)) continue;
    let arr: unknown;
    try {
      arr = JSON.parse(fs.readFileSync(af, "utf-8"));
    } catch {
      continue;
    }
    const blocking =
      Array.isArray(arr) &&
      arr.some((x: { status?: string; type?: string; createdAt?: string }) => {
        if (x?.status !== "draft") return false;
        if (!x?.type || !BLOCKING_TYPES.includes(x.type)) return false;
        const t = x?.createdAt ? new Date(x.createdAt).getTime() : 0;
        if (t && now - t > MAX_AGE_MS) return false; // abandoned, no longer blocks
        return true;
      });
    if (blocking) {
      // Non-blocking reminder: surface on stderr, exit 0. A stdout message +
      // exit 2 showed Claude only an empty-stderr "Stop hook error".
      process.stderr.write("deepPairing: pending artifacts need review — call check_feedback\n");
      exit(0, "pending artifacts in " + id);
    }
  }
  exit(0, "pass: no blocking drafts");
} catch (err) {
  exit(0, "error: " + (err instanceof Error ? err.message : String(err)));
}
