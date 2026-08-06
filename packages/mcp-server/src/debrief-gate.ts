/**
 * J2a (#210) — the single source of truth for "does this session still owe a
 * closing present_debrief?"
 *
 * Round-5 interaction-model lens: the protocol's ceremony must AUTO-SCALE with
 * task size while the load-bearing floor stays invariant. The debrief is the
 * feature-sized comprehension surface — but a TRIVIAL task should not have to
 * "file a change-request through an enterprise review board". So:
 *
 *   TRIVIAL (owes NO separate debrief): the session's only code artifact is a
 *   SINGLE `code_change` (single-file surgical fix) AND there was NO decision
 *   moment. The what-changed-and-why rides in that one code_change's reasoning;
 *   presenting it closes the task.
 *
 *   ESCALATED (owes the full arc, ending in one present_debrief): ANY of —
 *     • a `changeset` exists (multi-file work), OR
 *     • 2+ `code_change`s exist, OR
 *     • a `decision` artifact exists (a real choice was made).
 *
 * The floor is untouched: code is ALWAYS presented for review before it lands,
 * at every size — this predicate governs only the SEPARATE closing debrief.
 *
 * Shared by check-feedback.ts (the poll-time nag), stop-hook-entry.ts (the
 * plugin-bundled Stop hook — esbuild inlines this import), and
 * present-code-change.ts (the success-text trivial-close note). The
 * init-generated Stop script (setup-tasks.ts STOP_HOOK_SCRIPT) is a
 * self-contained .mjs and CANNOT import — it carries a hand-maintained inline
 * TWIN of this exact logic, kept in lock-step by the fixture-matrix parity test
 * (stop-hook-debrief-parity.test.ts) that runs BOTH scripts over a shared case
 * matrix.
 */

/** Code artifact types that (absent a debrief) put a run in debrief-owed territory. */
export const DEBRIEF_CODE_TYPES = ["code_change", "changeset"] as const;

export interface DebriefGateArtifact {
  type?: string;
  createdAt?: string;
  status?: string;
}

/**
 * Returns true when the session owes a closing `present_debrief`.
 *
 * @param artifacts — every artifact in the session (any status). The presence
 *   of a `debrief`, `changeset`, or `decision` is what matters — not their
 *   review state.
 * @param isRecent — age guard the caller supplies for CODE artifacts. The stop
 *   hook treats code older than 30 min as abandoned (drops it); check_feedback
 *   and present_code_change have no age concept and pass the default (always
 *   recent).
 */
export function sessionOwesDebrief(
  artifacts: DebriefGateArtifact[],
  isRecent: (a: DebriefGateArtifact) => boolean = () => true,
): boolean {
  // A debrief already exists → nothing owed.
  if (artifacts.some((a) => a?.type === "debrief")) return false;

  const recentCode = artifacts.filter(
    (a) => (a?.type === "code_change" || a?.type === "changeset") && isRecent(a),
  );
  // No (recent) code work → no debrief owed.
  if (recentCode.length === 0) return false;

  const changesets = recentCode.filter((a) => a?.type === "changeset").length;
  const codeChanges = recentCode.filter((a) => a?.type === "code_change").length;
  // Any decision moment escalates to the full arc — even a single-file fix.
  const hasDecision = artifacts.some((a) => a?.type === "decision");

  // TRIVIAL close: exactly one single-file code_change, no changeset, no
  // decision. That one self-summarizing code_change closes the task.
  const trivial = changesets === 0 && codeChanges === 1 && !hasDecision;
  return !trivial;
}
