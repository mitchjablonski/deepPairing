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
import { appendHookFire, hookErrorMessage, hookStatePath, mutateHookState, resolveHookProjectRoot } from "./hook-state.js";
import { exteriorDriftParts, isSkeletonDriftBaseline, isSkeletonApprovedVisualId } from "../mcp/skeleton-drift.js";
import { checkSkeletonExteriorDrift } from "../mcp/skeleton-read.js";
import { SKELETON_SCOPE_MAX_AGE_MS, readSkeletonScopeFile } from "../skeleton-scope.js";
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
  title?: string;
  status?: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  parentId?: string | null;
  statusHistory?: Array<{ status?: string; at?: string }>;
  content?: unknown;
};

/** Drift claims have their own file so best-effort telemetry can't overwrite them. */
const DRIFT_NUDGED_FILE = "skeleton-drift-nudges.json";
const DRIFT_NUDGED_KEY = "skeletonDriftNudged";
const DRIFT_NUDGED_CAP = 50;
/** The nudge line's bounds: plans named, files per plan, and the drift phrase's length. */
const MAX_NUDGE_PLANS = 3;
const MAX_NUDGE_FILES = 3;
const MAX_NUDGE_WHAT_CHARS = 280;

/** #686 P2c — an approval older than this (and no plan activity since) is
 *  not nudged: the same 8 h window after which a skeleton scope stops
 *  fencing edits (SKELETON_SCOPE_MAX_AGE_MS). The 30-min draft guard is too
 *  short for a skeleton fill, which routinely spans hours. */
const DRIFT_MAX_AGE_MS = SKELETON_SCOPE_MAX_AGE_MS;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** When the plan was last approved ("" when unknown). */
function approvedAtOf(a: StopArtifact): string {
  const history = Array.isArray(a.statusHistory) ? a.statusHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (isObj(h) && h.status === "approved" && typeof h.at === "string") return h.at;
  }
  return "";
}

/** One nudge per approval: artifact id + version + when it was approved. */
function driftNudgeKey(a: StopArtifact): string {
  return `${a.id}@v${typeof a.version === "number" ? a.version : 0}@${approvedAtOf(a)}`;
}

/** Every approved skeleton drift baseline in a session that is recent enough:
 *  approved, or touched by progress, within DRIFT_MAX_AGE_MS. */
function driftBaselines(raw: unknown[], now: number): StopArtifact[] {
  const artifacts = raw.filter(isObj) as StopArtifact[];
  return artifacts.filter((a) => {
    if (typeof a.id !== "string" || a.type !== "plan" || typeof a.status !== "string") return false;
    const visuals = isObj(a.content) && Array.isArray(a.content.visuals) ? (a.content.visuals as unknown[]) : [];
    if (!visuals.some((v) => isObj(v) && isSkeletonApprovedVisualId(v.id))) return false;
    const stamps = [approvedAtOf(a), typeof a.updatedAt === "string" ? a.updatedAt : ""]
      .map((t) => (t ? new Date(t).getTime() : NaN))
      .filter((t) => Number.isFinite(t));
    if (stamps.length === 0 || now - Math.max(...stamps) > DRIFT_MAX_AGE_MS) return false;
    return isSkeletonDriftBaseline(a as { id: string; type: string; status: string }, artifacts as Array<{ id: string; type: string; status: string }>);
  });
}

function nudgeKeys(state: Record<string, unknown>): string[] {
  const keys = state[DRIFT_NUDGED_KEY];
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
}

/** The nudge keys already sent, read without writing a salvage copy. */
function peekNudged(statePath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return isObj(parsed) ? nudgeKeys(parsed) : [];
  } catch {
    return [];
  }
}

function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

function describeDrift(candidates: Array<{ title: string; parts: string[] }>): string {
  const filesOf = (parts: string[]) =>
    parts.slice(0, MAX_NUDGE_FILES).map(oneLine).join("; ") +
    (parts.length > MAX_NUDGE_FILES ? `; +${parts.length - MAX_NUDGE_FILES} more files` : "");
  const what = candidates.length === 1
    ? filesOf(candidates[0]!.parts)
    : candidates.slice(0, MAX_NUDGE_PLANS).map((plan) => `"${plan.title || "untitled plan"}": ${filesOf(plan.parts)}`).join(" | ") +
      (candidates.length > MAX_NUDGE_PLANS ? ` | +${candidates.length - MAX_NUDGE_PLANS} more plans` : "");
  return what.length <= MAX_NUDGE_WHAT_CHARS ? what : `${what.slice(0, MAX_NUDGE_WHAT_CHARS - 1)}…`;
}

/** Runs the hook and exits the process. Never returns, never throws. */
export function runStopHook(stdin: string = "", now: number = Date.now()): never {
  const projectRoot = resolveHookProjectRoot();
  function exit(code: number, reason: string): never {
    appendHookFire(hookStatePath(projectRoot), {
      at: new Date().toISOString(),
      hook: HOOK_NAME,
      exitCode: code,
      reason,
    });
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
    // #686 P2c — every approved skeleton baseline in the scanned sessions.
    const driftCandidates: StopArtifact[] = [];
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
      try {
        driftCandidates.push(...driftBaselines(arr, now));
      } catch {
        /* a malformed plan never silences the other checks */
      }
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
    try {
      const legacyPath = hookStatePath(projectRoot);
      const claimPath = path.join(path.dirname(legacyPath), DRIFT_NUDGED_FILE);
      const nudged = new Set([...peekNudged(legacyPath), ...peekNudged(claimPath)]);
      const candidates: Array<{ key: string; title: string; parts: string[] }> = [];
      const seenKeys = new Set<string>();
      for (const plan of driftCandidates) {
        const key = driftNudgeKey(plan);
        if (nudged.has(key) || seenKeys.has(key)) continue;
        seenKeys.add(key);
        const scope = readSkeletonScopeFile(projectRoot, String(plan.id));
        const root = scope?.workspaceRoot || resolveHookRoots().workspaceRoot;
        const parts = exteriorDriftParts(checkSkeletonExteriorDrift(plan.content, { root }));
        if (parts.length > 0) {
          const title = typeof plan.title === "string" ? oneLine(plan.title.slice(0, 60)).slice(0, 60) : "";
          candidates.push({ key, title, parts });
        }
      }
      if (candidates.length > 0) {
        // The unlocked peek only avoids rereads. Recheck the claim under the
        // dedicated lock and persist it before writing the warning.
        let claimed: typeof candidates = [];
        const saved = mutateHookState(claimPath, (state) => {
          const keys = nudgeKeys(state);
          const seen = new Set([...peekNudged(legacyPath), ...keys]);
          claimed = candidates.filter((candidate) => !seen.has(candidate.key));
          if (claimed.length === 0) return false;
          state[DRIFT_NUDGED_KEY] = [...keys, ...claimed.map(({ key }) => key)].slice(-DRIFT_NUDGED_CAP);
        }, { requireLock: true });
        if (saved) {
          process.stderr.write(
            `deepPairing: skeleton exterior drift since approval: ${describeDrift(claimed)} — changes outside the fences are skeleton changes; propose them and revise_artifact the plan\n`,
          );
          exit(0, "skeleton drift " + claimed.map(({ key }) => key).join(", "));
        }
      }
    } catch {
      /* drift is best effort: fall through to the debrief nag */
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
