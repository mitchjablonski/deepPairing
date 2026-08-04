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
// #195 F1 — `changeset` joins the blocking set: a drafted multi-file changeset
// awaiting review is exactly the "don't declare done" case the hook guards.
const BLOCKING_TYPES = ["research", "spec", "plan", "decision", "code_change", "changeset"];
// #195 F1 — the code types whose presence WITHOUT a debrief means the run owes
// one (the "end every run with exactly ONE present_debrief" rule).
const CODE_TYPES = ["code_change", "changeset"];

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
  // #195 F1 — remember the first session that owes a debrief (recent code work,
  // no debrief). Only surfaced if NO blocking draft fired (blocking takes
  // priority — it's a harder obligation).
  let owesDebriefSession: string | null = null;
  for (const id of fs.readdirSync(sessionsDir)) {
    const af = path.join(sessionsDir, id, "artifacts.json");
    if (!fs.existsSync(af)) continue;
    let arr: unknown;
    try {
      arr = JSON.parse(fs.readFileSync(af, "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const blocking = arr.some((x: { status?: string; type?: string; createdAt?: string }) => {
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
    // #195 F1 — debrief-owed: RECENT code work presented, no debrief yet. Age-
    // guarded like the blocking check so an ancient session isn't nagged forever.
    if (owesDebriefSession === null) {
      const hasRecentCode = arr.some((x: { type?: string; createdAt?: string }) => {
        if (!x?.type || !CODE_TYPES.includes(x.type)) return false;
        const t = x?.createdAt ? new Date(x.createdAt).getTime() : 0;
        return !t || now - t <= MAX_AGE_MS;
      });
      const hasDebrief = arr.some((x: { type?: string }) => x?.type === "debrief");
      if (hasRecentCode && !hasDebrief) owesDebriefSession = id;
    }
  }
  if (owesDebriefSession !== null) {
    // Distinct debrief-owed nag — fail-open on stderr, exit 0, same as above.
    process.stderr.write(
      "deepPairing: code was presented but no present_debrief yet — end the run with one so your pair gets the walk-through\n",
    );
    exit(0, "owes debrief in " + owesDebriefSession);
  }
  exit(0, "pass: no blocking drafts");
} catch (err) {
  exit(0, "error: " + (err instanceof Error ? err.message : String(err)));
}
