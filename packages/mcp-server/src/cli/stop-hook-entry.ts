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
import { sessionOwesDebrief } from "../debrief-gate.js";

const HOOK_NAME = "stop";
const STATE_CAP = 50;
const MAX_AGE_MS = 30 * 60 * 1000;
// #195 F1 — `changeset` joins the blocking set: a drafted multi-file changeset
// awaiting review is exactly the "don't declare done" case the hook guards.
const BLOCKING_TYPES = ["research", "spec", "plan", "decision", "code_change", "changeset"];

function projectRoot(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// Q1 — durable hooks-state writes. The preflight lane's readHookState /
// writeHookStateAtomic are the reference implementation; this copy stays inline
// because this entry is deliberately import-free apart from the debrief gate
// (esbuild emits it as a standalone .mjs beside daemon.js), and its init-path
// twin in setup-tasks.ts carries the same pair verbatim.
function readState(statePath: string): { version?: number; fires?: unknown[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch {
    return {}; // absent — nothing to salvage
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* corrupt — copy aside below rather than discarding the fire log */
  }
  try {
    fs.writeFileSync(`${statePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`, raw);
  } catch {
    /* best-effort */
  }
  return {};
}

function writeStateAtomic(statePath: string, state: unknown): void {
  const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never mask the real error */ }
    throw err;
  }
}

function recordFire(exitCode: number, reason: string): void {
  try {
    const statePath = path.join(projectRoot(), ".deeppairing", "hooks-state.json");
    const state = readState(statePath);
    state.version = 1;
    const fires = Array.isArray(state.fires) ? state.fires : [];
    fires.push({ at: new Date().toISOString(), hook: HOOK_NAME, exitCode, reason });
    state.fires = fires.slice(-STATE_CAP);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    writeStateAtomic(statePath, state);
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
    // #195 F1 + J2a (#210) — debrief-owed: RECENT code work presented, no
    // debrief yet — BUT ceremony scales with task size. A trivial single-file
    // surgical fix (exactly one code_change, no changeset, no decision) closes
    // with its own self-summarizing code_change and owes NO separate debrief;
    // any escalation (a changeset, 2+ code_changes, or a decision) does. Age-
    // guard the code artifacts like the blocking check so an ancient session
    // isn't nagged forever. Shared predicate (debrief-gate.ts) — the
    // init-script twin in setup-tasks.ts STOP_HOOK_SCRIPT inlines this same
    // logic (kept in lock-step by stop-hook-debrief-parity.test.ts).
    if (owesDebriefSession === null) {
      const owes = sessionOwesDebrief(arr as { type?: string; createdAt?: string; status?: string }[], (x) => {
        const t = x?.createdAt ? new Date(x.createdAt).getTime() : 0;
        return !t || now - t <= MAX_AGE_MS;
      });
      if (owes) owesDebriefSession = id;
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
