/**
 * #342 — THE Stop hook. One implementation, two emission lanes.
 *
 * esbuild bundles `src/cli/stop-hook-entry.ts` (which is this function and
 * nothing else) into BOTH:
 *   - `claude-plugin/server/stop.mjs`, run by the plugin's hooks/hooks.json;
 *   - the string `ensureStopHook` writes to `.deeppairing/hooks/stop.mjs`.
 *
 * Before #342 those were two hand-maintained ports, and the debrief gate was a
 * third copy: `debrief-gate.ts::sessionOwesDebrief` for the bundled lane and an
 * INLINE TWIN inside setup-tasks.ts's template literal for the generated one,
 * held together by stop-hook-debrief-parity.test.ts. There is now one of each.
 *
 * Behaviour (unchanged by #342):
 *   - surfaces unreviewed blocking drafts on stderr, exit 0 (non-blocking nag);
 *   - age-guards drafts older than 30 min as abandoned;
 *   - #686 P2c: when nothing is blocking, nudges ONCE per approved skeleton
 *     version about exterior drift since approval (paths and line numbers
 *     only, never content), then the debrief-owed nag;
 *   - falls back to the debrief-owed nag when nothing else fires;
 *   - records every fire (pass OR nag) to .deeppairing/hooks-state.json.
 *
 * A stdout message + exit 2 was tried and showed Claude only an empty-stderr
 * "Stop hook error". stderr + exit 0 is deliberate and load-bearing.
 */
import fs from "node:fs";
import path from "node:path";
import { sessionOwesDebrief } from "../debrief-gate.js";
import { deriveSessionId } from "../session-id.js";
import { appendHookFire, hookErrorMessage, hookStatePath, readHookState, resolveHookProjectRoot } from "./hook-state.js";
import { exteriorDriftParts, isSkeletonDriftBaseline, isSkeletonApprovedVisualId } from "../mcp/skeleton-drift.js";
import { checkSkeletonExteriorDrift } from "../mcp/skeleton-read.js";
import { readSkeletonScopeFile } from "../skeleton-scope.js";
import { resolveHookRoots } from "../git-worktree.js";

const HOOK_NAME = "stop";
const MAX_AGE_MS = 30 * 60 * 1000;
// #195 F1 — `changeset` joins the blocking set: a drafted multi-file changeset
// awaiting review is exactly the "don't declare done" case the hook guards.
// #680 — a draft `page` awaiting review blocks "done" the same way. Pinned
// equal to PENDING_DRAFT_TYPES by stop-hook-blocking-types.test.ts.
const BLOCKING_TYPES = ["research", "spec", "plan", "decision", "code_change", "changeset", "page"];

type StopArtifact = {
  id?: string;
  status?: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  parentId?: string | null;
  statusHistory?: Array<{ status?: string; at?: string }>;
  content?: unknown;
};

/** #686 P2c — hooks-state field: drift nudges already sent (dedupe keys). */
const DRIFT_NUDGED_KEY = "skeletonDriftNudged";
const DRIFT_NUDGED_CAP = 50;

/** One nudge per approval: artifact id + version + when it was approved. */
function driftNudgeKey(a: StopArtifact): string {
  const approvedAt = [...(a.statusHistory ?? [])].reverse().find((h) => h?.status === "approved")?.at ?? "";
  return `${a.id}@v${a.version ?? 0}@${approvedAt}`;
}

/** The session's approved skeleton drift baseline (most recently updated), if any. */
function driftBaseline(artifacts: StopArtifact[]): StopArtifact | null {
  const plans = artifacts.filter((a) =>
    a && typeof a.id === "string" && a.type === "plan" && typeof a.status === "string" &&
    isSkeletonDriftBaseline(a as { id: string; type: string; status: string }, artifacts as Array<{ id: string; type: string; status: string }>) &&
    Array.isArray((a.content as { visuals?: unknown } | null)?.visuals) &&
    ((a.content as { visuals: Array<{ id?: unknown }> }).visuals).some((v) => isSkeletonApprovedVisualId(v?.id)));
  plans.sort((x, y) => String(y.updatedAt ?? "").localeCompare(String(x.updatedAt ?? "")));
  return plans[0] ?? null;
}

/** Runs the hook and exits the process. Never returns, never throws. */
export function runStopHook(stdin: string = "", now: number = Date.now()): never {
  const projectRoot = resolveHookProjectRoot();
  function exit(code: number, reason: string, mutate?: (state: Record<string, unknown>) => void): never {
    appendHookFire(hookStatePath(projectRoot), {
      at: new Date().toISOString(),
      hook: HOOK_NAME,
      exitCode: code,
      reason,
    }, mutate);
    process.exit(code);
  }

  try {
    let event: unknown;
    try {
      event = JSON.parse(stdin || "{}");
    } catch {
      // Parser diagnostics can contain rejected input. Keep telemetry generic.
      exit(0, "skip: invalid stop input");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      exit(0, "skip: invalid stop input");
    }
    let scopedSessionId: string | undefined;
    if (Object.prototype.hasOwnProperty.call(event, "session_id")) {
      const raw = (event as Record<string, unknown>).session_id;
      // Validate before derivation: its legacy sanitization must never turn a
      // rejected identity into another session's namespace.
      if (typeof raw !== "string" || raw.length < 1 || raw.length > 64 || /[^a-zA-Z0-9-]/.test(raw)) {
        exit(0, "skip: invalid stop session identity");
      }
      scopedSessionId = deriveSessionId(projectRoot, raw).sessionId;
    }
    const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
    if (!fs.existsSync(sessionsDir)) exit(0, "no sessions dir");

    // #195 F1 — remember the first session that owes a debrief (recent code
    // work, no debrief). Only surfaced if NO blocking draft fired: blocking
    // takes priority, it's a harder obligation.
    let owesDebriefSession: string | null = null;
    // #686 P2c — the first session with an approved skeleton baseline.
    let driftCandidate: StopArtifact | null = null;
    for (const id of scopedSessionId === undefined ? fs.readdirSync(sessionsDir) : [scopedSessionId]) {
      const af = path.join(sessionsDir, id, "artifacts.json");
      if (!fs.existsSync(af)) continue;
      let arr: unknown;
      try {
        arr = JSON.parse(fs.readFileSync(af, "utf-8"));
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      const artifacts = arr as StopArtifact[];
      const blocking = artifacts.some((x) => {
        if (x?.status !== "draft") return false;
        if (!x?.type || !BLOCKING_TYPES.includes(x.type)) return false;
        const t = x?.createdAt ? new Date(x.createdAt).getTime() : 0;
        if (t && now - t > MAX_AGE_MS) return false; // abandoned, no longer blocks
        return true;
      });
      if (blocking) {
        process.stderr.write("deepPairing: pending artifacts need review — call check_feedback\n");
        exit(0, "pending artifacts in " + id);
      }
      // #195 F1 + J2a (#210) — ceremony scales with task size; the shared
      // predicate owns the rules. Age-guard the code artifacts like the
      // blocking check so an ancient session isn't nagged forever.
      if (driftCandidate === null) driftCandidate = driftBaseline(artifacts);
      if (owesDebriefSession === null) {
        const owes = sessionOwesDebrief(artifacts, (x) => {
          const t = x?.createdAt ? new Date(x.createdAt).getTime() : 0;
          return !t || now - t <= MAX_AGE_MS;
        });
        if (owes) owesDebriefSession = id;
      }
    }
    // #686 P2c — skeleton exterior drift since approval: once per approved
    // version, warn-only. It sits ABOVE the debrief nag: drift means the code
    // no longer matches what the pair approved, which the agent should fix
    // (or propose) before wrapping up — and since it fires at most once per
    // approval, the debrief nag simply returns on the next Stop.
    if (driftCandidate) {
      const key = driftNudgeKey(driftCandidate);
      const statePath = hookStatePath(projectRoot);
      const nudged = readHookState(statePath)[DRIFT_NUDGED_KEY];
      const seen = Array.isArray(nudged) && nudged.includes(key);
      if (!seen) {
        const scope = readSkeletonScopeFile(projectRoot, String(driftCandidate.id));
        const root = scope?.workspaceRoot || resolveHookRoots().workspaceRoot;
        const drift = checkSkeletonExteriorDrift(driftCandidate.content, { root });
        const parts = exteriorDriftParts(drift);
        if (parts.length > 0) {
          process.stderr.write(
            `deepPairing: skeleton exterior drift since approval: ${parts.join("; ")} — changes outside the fences are skeleton changes; propose them and revise_artifact the plan\n`,
          );
          exit(0, "skeleton drift " + key, (state) => {
            const list = Array.isArray(state[DRIFT_NUDGED_KEY]) ? (state[DRIFT_NUDGED_KEY] as unknown[]) : [];
            if (!list.includes(key)) list.push(key);
            state[DRIFT_NUDGED_KEY] = list.slice(-DRIFT_NUDGED_CAP);
          });
        }
      }
    }
    if (owesDebriefSession !== null) {
      process.stderr.write(
        "deepPairing: code was presented but no present_debrief yet — end the run with one so your pair gets the walk-through\n",
      );
      exit(0, "owes debrief in " + owesDebriefSession);
    }
    exit(0, "pass: no blocking drafts");
  } catch (err) {
    exit(0, "error: " + hookErrorMessage(err));
  }
}
