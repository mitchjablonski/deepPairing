import type { Artifact, Comment } from "@deeppairing/shared";
import { coerceDecisionContent } from "@deeppairing/shared";
import { commentPriorVersion } from "../../stores/artifact";

/**
 * #177 SLICE 2a — the version-aware thread carryover read-model, SHARED.
 *
 * Extracted VERBATIM from DecisionWorkbench (#180, fast-follow to #177 slice
 * 2a) so the workbench and the default decision surfaces (DecisionCard's inline
 * option cards + the ArtifactPanel decision-comment thread) compute the SAME
 * CARRIED / STALE / ORPHAN signal from one place — no logic fork. The workbench
 * imports from here; its rendered behavior is byte-unchanged.
 *
 * Everything here is a pure, READ-side derivation from the version chain + the
 * live options — NO persisted field, NO schema change. Kept in its own module
 * (not the entry) so the Zod coercion it needs (`coerceDecisionContent`) stays
 * out of the entry chunk — the D6 lazy-Zod split (CommentThread imports only the
 * presentational `CarryoverBadge`, never this file).
 */

/**
 * A GRAIN comment is one anchored to a part of the decision the workbench
 * renders — a whole option (optionId, no region), or an option/decision
 * SECTION (a `decision:*` sectionId, or an option-scoped section like
 * "pro:0"). Diagram REGION comments (target.region set) belong to the nested
 * #173 diagram view, not the rail — excluded here so they aren't double-shown.
 * Internal decision sectionIds (revision-request / horizon-check) aren't grain.
 */
export function isGrainComment(c: Comment): boolean {
  const t = c.target;
  if (t.region) return false; // diagram region comment — lives in the zoom view
  if (t.sectionId && t.sectionId.startsWith("decision:")) return true;
  if (t.optionId) {
    // option-scoped: whole option (no section) or a grain section (pro/con/summary)
    if (!t.sectionId) return true;
    return /^(pro|con|summary)/.test(t.sectionId);
  }
  return false;
}

/**
 * #177 SLICE 2a — the read-side carryover state of a grain thread across a tune.
 *   - `none`   — no cross-version comment; a thread native to the current
 *                version. No marker.
 *   - `carried`— a cross-version thread whose part still lives in v2 and whose
 *                anchored text is UNCHANGED. Confident green.
 *   - `stale`  — cross-version, part still live, but the anchored text CHANGED
 *                (`procon: true` marks the honest handling of a positional
 *                pro/con grain — uncertain, never confidently carried).
 *   - `orphan` — cross-version, but the option id no longer matches any live
 *                v2 part (removed / id changed).
 */
export type CarryoverState =
  | { kind: "none" }
  | { kind: "carried"; from: number; to: number }
  | { kind: "stale"; from: number; to: number; procon: boolean }
  | { kind: "orphan"; from: number };

/** The text a grain's carryover diff compares across a tune (read-side, no
 *  persisted field). Summary → the option description; whole-option → the
 *  option's title (its human-facing identity). Undefined when the option is
 *  missing so the caller degrades to "uncertain" rather than false-confident. */
function anchoredText(
  opt: { title?: string; description?: string } | undefined,
  sectionId: string | undefined,
): string | undefined {
  if (!opt) return undefined;
  if (sectionId === "summary") return opt.description ?? "";
  if (!sectionId) return opt.title ?? ""; // whole option — identity is the title
  return opt.title ?? "";
}

/**
 * Compute a grain thread's carryover state from the version chain — a pure,
 * READ-side derivation (no schema change, no persisted field). `thread` is the
 * bucket of comments anchored to `anchor`; comments carry `target.artifactId`,
 * so an ancestor comment is one posted on an earlier version (commentPriorVersion).
 */
export function computeCarryover(params: {
  artifacts: Artifact[];
  thread: Comment[];
  currentArtifactId: string;
  anchor: { optionId?: string; sectionId?: string };
  liveOptions: ReadonlyArray<{ id: string; title?: string; description?: string }>;
}): CarryoverState {
  const { artifacts, thread, currentArtifactId, anchor, liveOptions } = params;

  // Earliest ANCESTOR version any comment in the thread was posted on. No
  // ancestor comment → a thread native to the current version → no marker.
  let from: number | undefined;
  let sourceArtifactId: string | undefined;
  for (const c of thread) {
    const v = commentPriorVersion(artifacts, c, currentArtifactId);
    if (v !== undefined && (from === undefined || v < from)) {
      from = v;
      sourceArtifactId = c.target.artifactId;
    }
  }
  if (from === undefined) return { kind: "none" };
  const to = artifacts.find((a) => a.id === currentArtifactId)?.version ?? from;

  const { optionId, sectionId } = anchor;

  // The decision question is a permanent part of the decision — it always
  // survives a tune, so a cross-version question thread is always CARRIED.
  if (sectionId === "decision:question") return { kind: "carried", from, to };

  if (optionId) {
    const liveOpt = liveOptions.find((o) => o.id === optionId);
    // The option id no longer matches any live part → orphaned by the tune.
    if (!liveOpt) return { kind: "orphan", from };
    // Pro/con anchor POSITIONALLY (optionId|pro:N); position is not stable
    // identity across a tune, so a cross-version pro/con can NEVER be confidently
    // CARRIED — flag it uncertain (slice 2b gates reliable re-anchor on a schema
    // change). Honest handling of the deferred grain: visible, not false-green.
    if (sectionId && /^(pro|con)/.test(sectionId)) {
      return { kind: "stale", from, to, procon: true };
    }
    // Summary / whole-option carry reliably on the stable id — CARRIED only when
    // the anchored text is UNCHANGED across the tune; otherwise STALE.
    const sourceOpt = sourceArtifactId
      ? coerceDecisionContent(
          artifacts.find((a) => a.id === sourceArtifactId)?.content ?? {},
        ).options.find((o) => o.id === optionId)
      : undefined;
    // Trim before comparing: a tune REGENERATES content, so a summary re-emitted
    // with only leading/trailing whitespace difference (or a coerce nudge) is
    // effectively unchanged — trimming avoids a false STALE alarm. Kept minimal
    // (edge trim only, NOT interior normalization) so a real edit still shows.
    const sourceText = anchoredText(sourceOpt, sectionId);
    const currentText = anchoredText(liveOpt, sectionId);
    if (sourceText !== undefined && sourceText.trim() === currentText?.trim()) {
      return { kind: "carried", from, to };
    }
    return { kind: "stale", from, to, procon: false };
  }
  return { kind: "none" };
}

/** A generic grain label for an ORPHAN thread — WITHOUT the raw option id (the
 *  option is gone, so `optionTitleFor` would leak the bare id). Names only the
 *  grain type so the human still knows what the thread was about. */
export function orphanGrainLabel(sectionId: string | undefined): string {
  if (!sectionId) return "an option";
  if (sectionId === "summary") return "an option summary";
  if (sectionId.startsWith("pro")) return "an option's pro";
  if (sectionId.startsWith("con")) return "an option's con";
  return "an option part";
}

/** Stable bucket key for a grain anchor (Record, never Map — store rule). */
function anchorKeyOf(t: { optionId?: string; sectionId?: string }): string {
  return `${t.optionId ?? ""}|${t.sectionId ?? ""}`;
}

/**
 * #180 — the AGGREGATE carryover state for ONE option, summarized across all of
 * its grain threads (whole-option + summary + pros/cons). The inline surfaces
 * that show ONE badge per option (DecisionCard's OptionCard) need a single
 * signal, where the workbench rail shows one marker per thread. Reuses
 * `computeCarryover` per anchor — single-source, no fork of the diff — and picks
 * the LOUDEST signal (stale outranks carried) so a real "does this still apply?"
 * is never hidden behind a green ✓. `none` when the option has no cross-version
 * grain thread.
 */
export function optionCarryover(params: {
  artifacts: Artifact[];
  /** The version-chain-aggregated comments for the artifact (useChainComments). */
  comments: Comment[];
  currentArtifactId: string;
  option: { id: string; title?: string; description?: string };
}): CarryoverState {
  const { artifacts, comments, currentArtifactId, option } = params;
  const liveOptions = [option];
  const buckets: Record<string, Comment[]> = {};
  for (const c of comments) {
    if (!isGrainComment(c)) continue;
    if (c.target.optionId !== option.id) continue; // only THIS option's grains
    (buckets[anchorKeyOf(c.target)] ??= []).push(c);
  }
  const rank = (s: CarryoverState): number =>
    s.kind === "orphan" ? 3 : s.kind === "stale" ? 2 : s.kind === "carried" ? 1 : 0;
  let best: CarryoverState = { kind: "none" };
  for (const bucket of Object.values(buckets)) {
    const state = computeCarryover({
      artifacts,
      thread: bucket,
      currentArtifactId,
      anchor: { optionId: bucket[0]!.target.optionId, sectionId: bucket[0]!.target.sectionId },
      liveOptions,
    });
    if (rank(state) > rank(best)) best = state;
  }
  return best;
}

/**
 * #180 — a per-comment carryover resolver for a FLAT decision thread (the
 * ArtifactPanel decision-comment view). Buckets the thread's comments by anchor
 * once, then returns a function that maps any comment to its anchor's carryover
 * state — so a cross-version grain comment shows the workbench's CARRIED / STALE
 * / ORPHAN marker instead of the bare "from vN" chip, consistently, on the flat
 * thread too. A comment with no grain anchor (a plain decision-level comment)
 * resolves to `none` → keeps its normal treatment.
 */
export function makeThreadCarryover(params: {
  artifacts: Artifact[];
  comments: Comment[];
  currentArtifactId: string;
  liveOptions: ReadonlyArray<{ id: string; title?: string; description?: string }>;
}): (c: Comment) => CarryoverState {
  const { artifacts, comments, currentArtifactId, liveOptions } = params;
  const buckets: Record<string, Comment[]> = {};
  for (const c of comments) (buckets[anchorKeyOf(c.target)] ??= []).push(c);
  return (c: Comment): CarryoverState => {
    const anchor = { optionId: c.target.optionId, sectionId: c.target.sectionId };
    // Only anchors the read-model actually carries get a marker; anything else
    // (a general decision comment) short-circuits to `none` so nothing changes.
    if (anchor.sectionId !== "decision:question" && !anchor.optionId) return { kind: "none" };
    return computeCarryover({
      artifacts,
      thread: buckets[anchorKeyOf(c.target)] ?? [c],
      currentArtifactId,
      anchor,
      liveOptions,
    });
  };
}
