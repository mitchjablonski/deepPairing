import type { Artifact, Comment, Request } from "@deeppairing/shared";
import { suggestionSummary } from "@deeppairing/shared";

/**
 * #188 (PAYDOWN) — the per-comment DELIVERY loop of check_feedback, extracted
 * from the ~820-line handler into one pure module. `handleCheckFeedback` used to
 * inline ~8 per-lane branches (suggestion state-machine, del-side removed line,
 * cross-file anchors, questionIndex, requirementId, optionId, sectionId/grain,
 * region, followUp), and spread the structured mirror TWICE (once for the
 * questions path, once for the comments path). This houses each lane ONCE:
 * `deliverComment(c, artsForTargets)` decides the bucket and returns the exact
 * prose line + structured object for both paths.
 *
 * BYTE-PARITY: this is a MOVE, not a rewrite — every prose string and structured
 * shape is verbatim from the pre-refactor handler (pinned by
 * check-feedback-golden-parity.test.ts). Do not reword here.
 */

/** #186 — resolve the text of a REMOVED line for delivery. A comment on a `del`
 *  line anchors to (filePath, oldLine, side:"old"); look the line up in the
 *  changeset's own hunks (already in the artifact) so the agent reads WHAT was
 *  removed, not just where — it knows the human is asking about a deletion, not
 *  the replacement. Returns undefined when the line can't be located. */
function removedLineContent(art: Artifact | undefined, filePath: string, oldLine: number): string | undefined {
  if (!art || art.type !== "changeset") return undefined;
  const files = (art.content as { files?: Array<{ path?: string; hunks?: Array<{ lines?: Array<{ kind?: string; oldLine?: number; content?: string }> }> }> } | null)?.files;
  if (!Array.isArray(files)) return undefined;
  const file = files.find((f) => f.path === filePath);
  if (!file || !Array.isArray(file.hunks)) return undefined;
  for (const h of file.hunks) {
    for (const l of h.lines ?? []) {
      if (l.kind === "del" && l.oldLine === oldLine) return l.content;
    }
  }
  return undefined;
}

/**
 * #160 — a comment the create-time scanner flagged carries a short TEXT-ONLY
 * marker on its rendered line, so the agent knows the human may have pasted a
 * credential (which is now in its context and on disk). Deliberately NOT a new
 * structuredContent key — the healthy-payload contract lock
 * (check-feedback-ledger-health.test.ts) must pass unchanged. Never includes
 * the matched value; the persisted warning itself is labels/pattern/line only.
 */
export function commentSecretNote(c: Comment): string {
  return c.secretWarnings?.length ? " ⚠ possible secret in this comment" : "";
}

/**
 * #204 (code lens F1) — the request analogue of `commentSecretNote`: a human
 * request whose free text tripped the create-time scanner carries a short
 * TEXT-ONLY marker on its delivered line (both the check_feedback request block
 * and the first-call obligations inventory), so the agent knows the human may
 * have pasted a credential into the composer (which is now in its context and on
 * disk). Never includes the matched value; the persisted warning itself is
 * labels/pattern/line only. Deliberately NOT a new structuredContent key — the
 * requests mirror spreads only-when-present, keeping the healthy-payload contract
 * lock (check-feedback-ledger-health.test.ts) unchanged.
 */
export function requestSecretNote(r: Pick<Request, "secretWarnings">): string {
  return r.secretWarnings?.length ? " ⚠ possible secret in this request" : "";
}

type CommentRegion =
  | { x?: number; y?: number; w?: number; h?: number; labels?: string[]; elementIds?: string[] }
  | undefined;

/**
 * #140 — a comment anchored to a region of a Mermaid diagram carries the node
 * LABELS it covers TEXTUALLY, never a screenshot. Render the referent as
 * `[AuthGate, Login]` so the agent can find the node in the Mermaid source it
 * authored. Deliberately NOT `elementIds`: those are render-unique
 * (`dp-mmd-7-8-flowchart-A-0`) and mean nothing to the model. Returns "" when
 * the region names no node (a blank-area drag) — nothing useful to append.
 */
function describeRegionRef(region: CommentRegion): string {
  if (!region) return "";
  const labels = (region.labels ?? []).filter((s) => typeof s === "string" && s.length > 0);
  if (labels.length > 0) return `[${labels.join(", ")}]`;
  return "";
}

/**
 * #174 — a decision GRAIN comment (from the "Discuss" workbench) anchors to a
 * PART of an option (optionId + a `pro:N`/`con:N`/`summary` sectionId) or to the
 * decision question itself (`decision:question`). Render the section so the
 * agent knows WHICH pro/con/part the human reacted to — not just the option.
 * Indices are 1-based in the prose to match how the human sees them.
 */
function describeDecisionSection(sectionId: string): string {
  if (sectionId === "decision:question") return "the decision question";
  const m = /^(pro|con)s?:(\d+)$/.exec(sectionId);
  if (m) return `${m[1]} #${Number(m[2]) + 1}`;
  if (sectionId === "summary") return "summary";
  return sectionId;
}

/** #193 E2 — resolve the title (`what`) of a per-ITEM debrief grain so delivery
 *  reads the human back the specific item, not just the lane. `lane` is the
 *  hyphenated grain key (`needs-your-eyes` / `decisions` / `deferred`); `i` is
 *  0-based. Returns undefined when the artifact/item can't be located (delivery
 *  then falls back to the lane + index alone). */
function debriefItemTitle(art: Artifact | undefined, lane: string, i: number): string | undefined {
  if (!art) return undefined;
  const c = art.content as {
    needsYourEyes?: Array<{ what?: string }>;
    decisionsMade?: Array<{ what?: string }>;
    deferred?: Array<{ what?: string }>;
  } | null;
  const arr =
    lane === "needs-your-eyes" ? c?.needsYourEyes :
    lane === "decisions" ? c?.decisionsMade :
    lane === "deferred" ? c?.deferred :
    undefined;
  const what = arr?.[i]?.what;
  return typeof what === "string" && what.trim().length > 0 ? what.trim() : undefined;
}

/**
 * #190 — a debrief GRAIN comment anchors to a PART of the debrief via a
 * `debrief:<section-key>` sectionId (a distinct namespace from decision grains).
 * Render the section so the agent knows WHICH part the human reacted to. Numeric
 * keys (`debrief:0` / `debrief:section:2`) name the ordered walk sections
 * 1-based; named keys (`debrief:summary`, `debrief:needs-your-eyes`) humanize.
 *
 * #193 E2 — a per-ITEM grain within an itemized lane
 * (`debrief:needs-your-eyes:2`, `debrief:decisions:0`, `debrief:deferred:1`)
 * reads the index back WITH the item's own title (`what`), so the agent knows
 * which flagged item — e.g. `needs-your-eyes item #3: The expiry check`. The
 * lane-level keys (`debrief:needs-your-eyes`) still deliver unchanged — old
 * comments carry them (backcompat).
 */
function describeDebriefSection(sectionId: string, art?: Artifact): string {
  const key = sectionId.slice("debrief:".length);
  // Ordered-walk sections: `0` / `section:2` → 1-based "section #n".
  const numeric = /^(?:section:)?(\d+)$/.exec(key);
  if (numeric) return `section #${Number(numeric[1]) + 1}`;
  // #193 E2 — per-item grain: `<lane>:<index>` (lane is hyphen-lowercase).
  const item = /^([a-z][a-z-]*):(\d+)$/.exec(key);
  if (item) {
    const lane = item[1]!;
    const i = Number(item[2]);
    const laneWords = lane.replace(/-/g, " ");
    const title = debriefItemTitle(art, lane, i);
    return title ? `${laneWords} item #${i + 1}: ${title}` : `${laneWords} item #${i + 1}`;
  }
  return key.replace(/-/g, " ");
}

/**
 * #190 A2 — an explainer GRAIN comment anchors to a PART of the walk-through via
 * an `explainer:<section-key>` sectionId (its OWN namespace, distinct from
 * decision/debrief grains). Render the section so the agent knows WHICH part of
 * the walk the human reacted to. Numeric keys (`explainer:0`) name the ordered
 * sections 1-based; a named key (`explainer:overview`) humanizes.
 */
function describeExplainerSection(sectionId: string): string {
  const key = sectionId.slice("explainer:".length);
  const m = /^(?:section:)?(\d+)$/.exec(key);
  if (m) return `section #${Number(m[1]) + 1}`;
  return key.replace(/-/g, " ");
}

/**
 * #173 — the structured delivery of a region comment, split by artifact kind.
 *
 * A DECISION region comment (target.optionId set — the focused-view region
 * layer threads it through) carries the OPTION + VISUAL + normalized RECT plus
 * label-matched `nearNodes` (the nodes the region covers, by LABEL). mermaid
 * node ids are render-unique (#163), so the labels are what lets the agent
 * re-locate the region in the option's diagram after a re-render — that's why
 * they ride as `nearNodes`, never the ids or the raw rect alone.
 *
 * A plan/spec region comment keeps its historical `region: { labels }` shape
 * (no optionId), byte-for-byte — the healthy-payload contract lock
 * (check-feedback-ledger-health.test.ts) depends on it.
 */
function structuredRegionFields(t: {
  optionId?: string;
  visualId?: string;
  region?: CommentRegion;
}): Record<string, unknown> {
  const region = t.region;
  if (!region) return {};
  if (t.optionId) {
    const nearNodes = (region.labels ?? []).filter((s) => typeof s === "string" && s.length > 0);
    return {
      optionId: t.optionId,
      ...(t.visualId ? { visualId: t.visualId } : {}),
      region: {
        x: region.x,
        y: region.y,
        w: region.w,
        h: region.h,
        ...(nearNodes.length ? { nearNodes } : {}),
      },
    };
  }
  return region.labels?.length ? { region: { labels: region.labels } } : {};
}

/**
 * The structured fields shared by BOTH the question and comment mirrors (their
 * pre-refactor bodies spread this identical tail twice). Key order matches the
 * historical shape exactly. `removedLine` is threaded in from the loc build so
 * the del-side lookup runs once.
 */
function commonTargetFields(c: Comment, removedLine: string | undefined): Record<string, unknown> {
  return {
    lineStart: c.target.lineStart,
    findingIndex: c.target.findingIndex,
    questionIndex: c.target.questionIndex,
    requirementId: c.target.requirementId,
    // #171 — file dimension for a changeset line comment, and the full anchor
    // list for a cross-file thread. Spread only when present so the healthy/
    // no-file payload is byte-for-byte unchanged.
    ...(c.target.filePath ? { filePath: c.target.filePath } : {}),
    // #186 — old-side (removed-line) marking + content. Spread ONLY for a
    // del-side comment so new-side delivery is byte-for-byte unchanged.
    ...(c.target.side === "old" ? { side: "old" as const, ...(removedLine != null ? { removedLine } : {}) } : {}),
    ...(Array.isArray(c.target.anchors) && c.target.anchors.length >= 2 ? { anchors: c.target.anchors } : {}),
    // #140/#173 — a plan/spec region comment carries ONLY the human-meaningful
    // labels (byte-for-byte as before); a DECISION region comment (optionId set)
    // carries optionId + visualId + rect + nearNodes so the anchor survives a
    // re-render (#163). See structuredRegionFields.
    ...structuredRegionFields(c.target),
  };
}

/** Which bucket a delivered comment lands in (drives the caller's prose block +
 *  structured array). */
export type DeliveryBucket = "suggestion" | "question" | "comment";

export interface CommentDelivery {
  bucket: DeliveryBucket;
  /** The exact prose line to push into the bucket's block. */
  prose: string;
  /** The structured mirror to push into the bucket's array. */
  structured: Record<string, unknown>;
  /** #187 — true ONLY when a delivered QUESTION or COMMENT (never a suggestion)
   *  is a late follow-up — drives the one guidance paragraph the caller appends. */
  isFollowUp: boolean;
}

/**
 * Deliver ONE unacknowledged artifact comment: decide its bucket and produce the
 * exact prose line + structured object. Houses every per-lane branch once; the
 * caller dispatches on `bucket` into questionLines/suggestionLines/otherLines and
 * their structured arrays. `artsForTargets` is the current artifact snapshot,
 * used to resolve titles/options/removed-line content.
 */
export function deliverComment(c: Comment, artsForTargets: Artifact[]): CommentDelivery {
  // #172 — a first-class suggested edit. The agent MUST respond via
  // answer_question. Deliver it prominently with the full original/
  // replacement so the response needs no re-derivation from the diff.
  if (c.suggestion) {
    const s = c.suggestion;
    const range = s.lineEnd > s.lineStart ? `${s.lineStart}–${s.lineEnd}` : `${s.lineStart}`;
    const loc = `${c.target.filePath ?? "code"}:${range}`;
    const summary = suggestionSummary(c.target.filePath, s.lineStart, s.lineEnd);
    const why = c.content.trim();
    const note = why.length > 0 && why !== summary ? why : undefined;
    const respond = `answer_question commentId="${c.id}"`;
    const tookCounter = s.state === "applied" && !!s.counter && s.appliedInVersion == null;
    let prose: string;
    if (s.state === "insisted" && s.appliedInVersion == null) {
      prose =
        `- 🔧 INSISTED EDIT [${loc}]${commentSecretNote(c)} The human INSISTED on their exact version after your counter — apply it VERBATIM, do not re-argue:\n${s.replacementText}\n    → ${respond} suggestionState:"applied" appliedInVersion:<the version you just shipped it in>.`;
    } else if (tookCounter) {
      // A counter can be reason-only (no replacement code). Tell the agent
      // to revise per the reason rather than "apply your counter-proposal"
      // when there's no concrete code to apply.
      const counterBody = s.counter?.replacementText
        ? `apply your counter-proposal:\n${s.counter.replacementText}`
        : `revise the code per your counter's reasoning${s.counter?.reason ? ` ("${s.counter.reason}")` : ""}`;
      prose =
        `- 🔧 COUNTER ACCEPTED [${loc}]${commentSecretNote(c)} The human TOOK YOUR COUNTER — ${counterBody} and stamp the version.\n    → ${respond} suggestionState:"applied" appliedInVersion:<the version you just shipped it in>.`;
    } else {
      // pending (the common case)
      prose =
        `- 🔧 SUGGESTED EDIT [${loc}]${commentSecretNote(c)} The human proposes replacing:\n${s.originalText}\n  with:\n${s.replacementText}${note ? `\n  Why: ${note}` : ""}\n    → Respond via ${respond}: suggestionState:"applied" (+ appliedInVersion) to ship it verbatim or with an extension you name in \`answer\`, OR suggestionState:"countered" (+ your reason in \`answer\`) to propose a different edit.`;
    }
    return {
      bucket: "suggestion",
      prose,
      structured: {
        commentId: c.id,
        artifactId: c.target.artifactId,
        state: s.state,
        file: c.target.filePath,
        lineStart: s.lineStart,
        lineEnd: s.lineEnd,
        originalText: s.originalText,
        replacementText: s.replacementText,
        ...(note ? { note } : {}),
        ...(s.counter ? { counter: s.counter } : {}),
        // #187 — a suggested edit posted to an approved artifact is a follow-up;
        // spread only when stamped so normal delivery stays byte-unchanged.
        ...(c.followUp ? { followUp: true as const } : {}),
      },
      isFollowUp: false,
    };
  }

  let loc = c.target.artifactId;
  // #171 — a changeset line comment carries a file dimension (path + line),
  // so deliver it as `art_x path/to/file.ts:12` rather than a bare
  // `art_x:12` the agent can't place across a multi-file change.
  if (c.target.filePath) loc += ` ${c.target.filePath}`;
  if (c.target.lineStart) loc += `:${c.target.lineStart}`;
  // #186 — an OLD-side comment is about a REMOVED line. Mark it so the agent
  // reads this as "why did you delete this?", not a note on the replacement,
  // and inline the removed line's content (pulled from the changeset hunks)
  // so the ask is self-contained: `path:26 (removed line: "const s = …")`.
  let removedLine: string | undefined;
  if (c.target.side === "old" && c.target.filePath && c.target.lineStart != null) {
    removedLine = removedLineContent(
      artsForTargets.find((a) => a.id === c.target.artifactId),
      c.target.filePath,
      c.target.lineStart,
    );
    loc += removedLine != null ? ` (removed line: "${removedLine}")` : ` (removed line)`;
  }
  // #171 — a CROSS-FILE thread (2+ anchors) names every location it binds
  // so the agent sees the invariant spans files (e.g. session.ts:12 ↔
  // middleware.ts:31).
  const anchors = Array.isArray(c.target.anchors) ? c.target.anchors : [];
  if (anchors.length >= 2) {
    loc += ` — cross-file: ${anchors.map((a) => `${a.filePath}:${a.lineStart}`).join(" ↔ ")}`;
  }
  if (c.target.findingIndex != null) loc += ` (finding #${c.target.findingIndex + 1})`;
  // D8 review [BLOCKER] — question answers and requirement comments
  // arrived UNTAGGED: the human clicked Comment on "Which DB?", typed
  // "Postgres", and the agent got a bare artifact-level comment with no
  // clue which open question it answered. Tag both, resolving the
  // question TEXT so terse answers ("yes") stay unambiguous.
  if (c.target.questionIndex != null) {
    const art = artsForTargets.find((a) => a.id === c.target.artifactId);
    const qs = (art?.content as { openQuestions?: string[] } | undefined)?.openQuestions;
    const qText = qs?.[c.target.questionIndex];
    loc += qText
      ? ` (answers open question #${c.target.questionIndex + 1}: "${qText}")`
      : ` (answers open question #${c.target.questionIndex + 1})`;
  }
  if (c.target.requirementId) loc += ` (requirement ${c.target.requirementId})`;
  // #173 — a decision region comment names the OPTION it anchors to, so the
  // agent knows which option's diagram the region belongs to (the anchor is
  // optionId + visualId + region together). Resolve the option TITLE from
  // the decision artifact's content so terse regions stay placeable.
  if (c.target.optionId) {
    const art = artsForTargets.find((a) => a.id === c.target.artifactId);
    const opts = (art?.content as { options?: Array<{ id?: string; title?: string }> } | undefined)?.options;
    const optTitle = opts?.find((o) => o.id === c.target.optionId)?.title;
    loc += optTitle ? ` (option "${optTitle}")` : ` (option ${c.target.optionId})`;
  }
  // #174 — a decision GRAIN comment names the option PART it anchors to (a
  // specific pro/con/summary, or the decision question). Kept in its OWN
  // block (adjacent to #173's optionId block) so slice-1 merges cleanly.
  // Gated so it fires ONLY for workbench grain sections (optionId + section,
  // or a `decision:*` section) — never the internal revision-request /
  // horizon-check sectionIds, which carry neither and stay untouched.
  if (c.target.sectionId && (c.target.optionId || c.target.sectionId.startsWith("decision:"))) {
    loc += ` — ${describeDecisionSection(c.target.sectionId)}`;
  }
  // #190 — a debrief grain comment names the debrief part it anchors to. Its
  // OWN block (distinct namespace: `debrief:*`, never optionId) so it can't
  // collide with the decision grain block above.
  if (c.target.sectionId && c.target.sectionId.startsWith("debrief:")) {
    const art = artsForTargets.find((a) => a.id === c.target.artifactId);
    loc += ` — ${describeDebriefSection(c.target.sectionId, art)}`;
  }
  // #190 A2 — an explainer grain comment names the walk-through part it anchors
  // to. Its OWN block (distinct namespace: `explainer:*`, never optionId) so it
  // can't collide with the decision or debrief grain blocks.
  if (c.target.sectionId && c.target.sectionId.startsWith("explainer:")) {
    loc += ` — ${describeExplainerSection(c.target.sectionId)}`;
  }
  // #140 — a region comment names the diagram nodes it covers TEXTUALLY so
  // the agent can find them in the Mermaid source it authored (no image).
  // e.g. "— on region [AuthGate, Login]". Labels preferred; ids as a
  // fallback. A region carrying neither is skipped (nothing to say).
  const regionRef = describeRegionRef(c.target.region);
  if (regionRef) loc += ` — on region ${regionRef}`;

  // #187 — a FOLLOW-UP comment (posted to an already-approved artifact via the
  // late lane; the store stamps `followUp` authoritatively) is delivered
  // clearly distinguished: a per-line prose prefix naming the approved artifact
  // + one guidance paragraph (the caller appends it), so the agent treats it as
  // NEW INPUT, not a review reopening. A normal comment has `followUp` absent →
  // prefix is "", no structured flag: byte-for-byte-unchanged delivery.
  // "APPROVED/RESOLVED" — a decision reaches this lane via `approved` status but
  // reads as "resolved" to the human; the pair covers both without a per-type
  // branch.
  const followUpPrefix = c.followUp
    ? `[follow-up on the APPROVED/RESOLVED artifact "${artsForTargets.find((a) => a.id === c.target.artifactId)?.title ?? c.target.artifactId}"] `
    : "";

  if (c.intent === "question" && !c.answeredByCommentId) {
    return {
      bucket: "question",
      prose: `- ❓ QUESTION [${loc}] ${followUpPrefix}${c.content}${commentSecretNote(c)}\n    → Answer via answer_question with commentId="${c.id}"`,
      structured: {
        commentId: c.id,
        artifactId: c.target.artifactId,
        content: c.content,
        // #187 — spread ONLY when the store stamped it (posted to an approved
        // artifact via the late lane) so normal delivery is byte-unchanged.
        ...(c.followUp ? { followUp: true as const } : {}),
        ...commonTargetFields(c, removedLine),
      },
      isFollowUp: !!c.followUp,
    };
  }
  return {
    bucket: "comment",
    prose: `- [${loc}] ${followUpPrefix}${c.content}${commentSecretNote(c)}`,
    structured: {
      id: c.id,
      artifactId: c.target.artifactId,
      kind: "comment",
      content: c.content,
      // #187 — see the question path: present only for a late follow-up.
      ...(c.followUp ? { followUp: true as const } : {}),
      ...commonTargetFields(c, removedLine),
    },
    isFollowUp: !!c.followUp,
  };
}
