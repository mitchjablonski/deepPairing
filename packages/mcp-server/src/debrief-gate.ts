/**
 * J2a (#210) — the single source of truth for "does this session still owe a
 * closing present_debrief?"
 *
 * Round-5 interaction-model lens: the protocol's ceremony must AUTO-SCALE with
 * task size while the load-bearing floor stays invariant. The debrief is the
 * feature-sized comprehension surface — but a TRIVIAL task should not have to
 * "file a change-request through an enterprise review board". So:
 *
 *   TRIVIAL (owes NO separate debrief): the session's only LIVE code artifact is
 *   a SINGLE `code_change` (single-file surgical fix) AND there was NO
 *   feature-shaping ceremony (no decision, spec, or plan; no dead-but-attempted
 *   debrief). The what-changed-and-why rides in that one code_change's
 *   reasoning; presenting it closes the task.
 *
 *   ESCALATED (owes the full arc, ending in one present_debrief): ANY of —
 *     • a LIVE `changeset` exists (multi-file work), OR
 *     • 2+ LIVE `code_change`s exist, OR
 *     • a `decision`, `spec`, or `plan` artifact exists — the work was
 *       feature-shaped, not a surgical fix (F1). `research`/findings is
 *       deliberately NOT in this set: a findings artifact alone is
 *       investigation, not feature-shaped work, OR
 *     • a debrief was ATTEMPTED but none is live (all superseded/retracted/
 *       obsolete/rejected) — the close was started and isn't standing, so it's
 *       still owed (F2 / the retracted-debrief hole).
 *
 * The floor is untouched: code is ALWAYS presented for review before it lands,
 * at every size — this predicate governs only the SEPARATE closing debrief.
 *
 * O1 (#229) — the GUIDANCE taxonomy is {trivial | low-risk-feature | escalated},
 * keying ceremony on RISK not size. This PREDICATE deliberately does NOT gain a
 * low-risk-feature branch: a low-risk feature is multi-file work (a changeset, or
 * 2+ code_changes), which already lands in ESCALATED here — it still owes exactly
 * ONE debrief. What the low-risk-feature class changes is the PRE-WORK ceremony
 * the agent runs (it MAY skip present_findings + the spec/plan gate — see the
 * SKILL.md cadence section and the first-call hint), never the debrief obligation
 * or the changeset review floor. So this gate is unchanged: a changeset still owes
 * a debrief. Only TRIVIAL (single live single-file code_change, no ceremony) is
 * carved out below.
 *
 * LIVE vs closed (F2): the count is over LIVE artifacts, not raw types.
 *   - CODE (code_change/changeset): a superseded/retracted/obsolete artifact is
 *     off the table, so a trivial fix that got ONE tweak (v1 superseded by v2)
 *     is still ONE live change, not two. A REJECTED code_change is KEPT counted
 *     — it still represents work that was presented for review.
 *   - DEBRIEF liveness: a debrief satisfies the obligation only while LIVE —
 *     superseded/retracted/obsolete AND rejected all fail (a rejected debrief
 *     means the human refused the account, so the obligation RE-OPENS).
 *   - CEREMONY (decision/spec/plan): escalates on PRESENCE regardless of status
 *     — a retracted decision/spec/plan still means the ceremony happened
 *     (a deliberate, harmless conservatism).
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

/** Code artifact types that (absent a live debrief) put a run in debrief-owed territory. */
export const DEBRIEF_CODE_TYPES = ["code_change", "changeset"] as const;
/** Statuses that take a CODE artifact off the table (rejected is KEPT — see header). */
const CODE_CLOSED_STATUSES = ["superseded", "retracted", "obsolete"];
/** Statuses under which a debrief no longer satisfies the closing obligation. */
const DEBRIEF_DEAD_STATUSES = ["superseded", "retracted", "obsolete", "rejected"];
/** Feature-shaping ceremony — presence escalates regardless of status. */
const CEREMONY_TYPES = ["decision", "spec", "plan"];

export interface DebriefGateArtifact {
  type?: string;
  createdAt?: string;
  status?: string;
}

/**
 * Returns true when the session owes a closing `present_debrief`.
 *
 * @param artifacts — every artifact in the session (any status).
 * @param isRecent — age guard the caller supplies for CODE artifacts. The stop
 *   hook treats code older than 30 min as abandoned (drops it); check_feedback
 *   and present_code_change have no age concept and pass the default (always
 *   recent).
 */
export function sessionOwesDebrief(
  artifacts: DebriefGateArtifact[],
  isRecent: (a: DebriefGateArtifact) => boolean = () => true,
): boolean {
  // A LIVE debrief closes the loop → nothing owed.
  const hasLiveDebrief = artifacts.some(
    (a) => a?.type === "debrief" && !DEBRIEF_DEAD_STATUSES.includes(a?.status ?? ""),
  );
  if (hasLiveDebrief) return false;

  // Code work counts only LIVE artifacts (superseded/retracted/obsolete off the
  // table; rejected kept).
  const recentCode = artifacts.filter(
    (a) =>
      (a?.type === "code_change" || a?.type === "changeset") &&
      !CODE_CLOSED_STATUSES.includes(a?.status ?? "") &&
      isRecent(a),
  );
  // No (recent) live code work → no debrief owed (even if a dead debrief lingers
  // — a retracted debrief with nothing to debrief owes nothing, and avoids a
  // misleading "code was presented" nag).
  if (recentCode.length === 0) return false;

  const changesets = recentCode.filter((a) => a?.type === "changeset").length;
  const codeChanges = recentCode.filter((a) => a?.type === "code_change").length;

  // Feature-shaping ceremony escalates even a single-file change: a decision,
  // spec, or plan (any status), OR a debrief that was ATTEMPTED but is not live
  // (we already returned above if any debrief IS live) — the work warranted a
  // close, so one is still owed.
  const hasCeremony =
    artifacts.some((a) => CEREMONY_TYPES.includes(a?.type ?? "")) ||
    artifacts.some((a) => a?.type === "debrief");

  // TRIVIAL close: exactly one live single-file code_change, no changeset, no
  // ceremony. That one self-summarizing code_change closes the task.
  const trivial = changesets === 0 && codeChanges === 1 && !hasCeremony;
  return !trivial;
}

// ---------------------------------------------------------------------------
// P1 (round-11) — the PRE-WORK ceremony predicate: the other half of the same
// vocabulary.
//
// `sessionOwesDebrief` above governs the CLOSING obligation. This one governs
// the OPENING one: "is the escalated arc actually in flight right now?" It is
// consumed by the preflight PreToolUse hook's GUARDRAIL BACKSTOP
// (cli/preflight-hook-core.ts), which pauses a write to a guardrail path ONLY
// when the agent skipped the pre-work ceremony entirely. Living here keeps both
// gates' liveness rules in one file, and keeps this module import-free so the
// hook (which runs under plain `node` out of .deeppairing/hooks/) can pull it in
// without dragging @deeppairing/shared along.
//
// NOTE the deliberate divergence from CEREMONY_TYPES above: the debrief gate
// EXCLUDES `research` (findings alone is investigation, not feature-shaped work,
// so it must not escalate a trivial fix into owing a debrief). The PRE-WORK set
// INCLUDES it — present_findings IS the opening move of the escalated arc
// ("findings → options → spec/plan"), and an agent that presented
// evidence-anchored findings before touching a migration demonstrably did NOT
// skip the ceremony. Two sets, two questions; the divergence is intentional.
//
// `changeset`/`code_change` are deliberately NOT ceremony here: the changeset is
// the review FLOOR that comes AFTER the edit lands on disk, so it can never be
// in flight at PreToolUse time — counting it would make the backstop
// unfireable in exactly the sessions it exists for.
/** Pre-work ceremony artifact types — the escalated arc's opening moves. */
export const PRE_WORK_CEREMONY_TYPES = ["research", "decision", "spec", "plan"] as const;
/** Statuses under which a ceremony artifact no longer counts as "in flight".
 *  The same liveness rule the debrief gate applies to a debrief: a superseded
 *  one has a live v(N+1) counting in its place; retracted/obsolete were taken
 *  back; REJECTED means the human refused the proposal — which is precisely a
 *  case the backstop SHOULD still ask about. */
const CEREMONY_DEAD_STATUSES = ["superseded", "retracted", "obsolete", "rejected"];

/**
 * True when the session shows a LIVE pre-work ceremony artifact — i.e. the
 * escalated arc IS in flight, so a guardrail-path edit is a legitimate part of
 * it and the backstop must stay silent.
 *
 * @param artifacts — every artifact in the session (any status).
 * @param isRecent — recency guard the caller supplies. The hook uses one working
 *   arc (8h) so a long implementation run after an approved spec is never
 *   re-asked, while YESTERDAY's spec cannot license today's unceremonious
 *   migration.
 */
export function sessionHasLivePreWorkCeremony(
  artifacts: DebriefGateArtifact[],
  isRecent: (a: DebriefGateArtifact) => boolean = () => true,
): boolean {
  return artifacts.some(
    (a) =>
      (PRE_WORK_CEREMONY_TYPES as readonly string[]).includes(a?.type ?? "") &&
      !CEREMONY_DEAD_STATUSES.includes(a?.status ?? "") &&
      isRecent(a),
  );
}
