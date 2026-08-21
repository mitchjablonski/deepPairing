/**
 * Q6 (#232) B1 — the AUTHORIZATION gate for posting a review into someone
 * else's GitHub repository.
 *
 * The adversarial review of the first Q6 cut found the sharpest problem in the
 * batch: `post_pr_review` would happily post findings the human had never
 * looked at, and a bare `APPROVE` would post a real approving review on a
 * colleague's PR — with NOTHING gating either except a sentence of prose in
 * review-pr.md telling the agent to wait for the human's word. That was proved
 * inadequate by mutation: strip the sentence, hoist the post step above the
 * discussion phase, and the guidance tests still passed 14/14. Prose is not a
 * gate. An agent that skips a step — or anyone who edits the command file —
 * walks straight through it.
 *
 * So the gate moved into code, and the authority is the one thing the agent
 * cannot forge: THE HUMAN'S RECORDED VERDICT IN THE SESSION STORE. Approving an
 * artifact in the companion UI is a deliberate human act that writes
 * `status: "approved"`. Nothing else counts as permission to write into another
 * person's repository.
 *
 * WHY THIS IS A MODULE AND NOT A CHECK INSIDE THE TOOL: there are TWO doors out
 * of this machine, and both reach the same `gh` call —
 *   • the MCP tool `post_pr_review` (mcp/tools/post-pr-review.ts), and
 *   • the CLI `deeppairing post-pr-review <pr>` (cli/init.ts).
 * A gate on only one of them is not a gate. Both call `authorizeReviewPost`,
 * and neither builds a payload any other way. (This codebase has spent a dozen
 * rounds fighting copy-paste parity drift — see the parity-test regime — so the
 * fix is ONE function with two callers, never two checks kept in sync.)
 *
 * FAIL CLOSED, and deliberately NO ESCAPE HATCH: no `force` flag, no env
 * override, no "the human said so in chat" bypass. If the store does not carry
 * the verdict, the post does not happen. A force flag would recreate the exact
 * hole this closes, because the agent is the one who would pass it.
 */
import type { Artifact } from "@deeppairing/shared";
import { coerceResearchContent, coerceChangesetContent } from "@deeppairing/shared";
import { buildGitHubReviewPayload, type GitHubReviewPayload, type GitHubReviewEvent } from "../export/format-markdown.js";

/** The minimum of a session this gate reads. Structural, so both callers'
 *  slightly different state shapes (store.getFullState vs FileStore.loadSession)
 *  satisfy it without a cast at the call site. */
export interface AuthorizableSession {
  sessionId: string;
  artifacts: Artifact[];
  [k: string]: unknown;
}

export type ReviewAuthorization =
  | { ok: true; payload: GitHubReviewPayload }
  | { ok: false; reason: string };

/**
 * Statuses meaning THE HUMAN HAS NOT RULED on this artifact.
 *
 * `draft` — presented, never opened. `reviewing` — opened, no verdict yet.
 * `revised` — the human sent it BACK for changes, so the standing version is
 * explicitly not what they want going anywhere.
 *
 * A findings artifact in any of these that carries postable evidence REFUSES the
 * whole post rather than being silently dropped. Silent dropping is the worse
 * failure of the two: the human believes their concern reached the author's PR
 * when it never left the laptop, and they find out in the next standup.
 */
const UNDECIDED_STATUSES = new Set(["draft", "reviewing", "revised"]);

/**
 * Statuses that are a DECIDED "no" (or "not this version") — silently excluded,
 * and the rest of the post proceeds.
 *
 * `rejected` — the human said no; that IS their verdict, honoured by omission.
 * `superseded` — a live v(N+1) stands in its place and is judged on its own
 * status. `retracted` — the agent took it back. `obsolete` — overtaken.
 */
const DECIDED_EXCLUDED_STATUSES = new Set(["rejected", "superseded", "retracted", "obsolete"]);

/** Does this findings artifact carry at least one finding that would become an
 *  inline PR comment? Mirrors buildGitHubReviewPayload's own predicate
 *  (structured evidence with filePath + numeric lineStart). A findings artifact
 *  with only prose evidence posts nothing, so its status is not load-bearing
 *  and must not be able to block an otherwise-authorized post. */
function hasPostableEvidence(artifact: Artifact): boolean {
  const findings = coerceResearchContent(artifact.content).findings;
  if (!Array.isArray(findings)) return false;
  return findings.some((f) => {
    const evidence = Array.isArray(f.evidence) ? f.evidence : [];
    return evidence.some(
      (e) => !!e && typeof e === "object" && !!(e as { filePath?: unknown }).filePath &&
        typeof (e as { lineStart?: unknown }).lineStart === "number",
    );
  });
}

/** The session's external-review changesets — a colleague's PR on the review
 *  surface (Q6's reviewIntent). */
function externalChangesets(artifacts: Artifact[]): Artifact[] {
  return artifacts.filter(
    (a) => a.type === "changeset" && coerceChangesetContent(a.content).reviewIntent === "external",
  );
}

/**
 * Decide whether this session authorizes posting a review, and if so build the
 * payload from ONLY what the human approved.
 *
 * Note what is NOT consulted: the agent's intent, the command file, anything
 * said in the conversation. Only artifacts and their human-set statuses.
 */
export function authorizeReviewPost(
  state: AuthorizableSession,
  opts: { event: GitHubReviewEvent },
): ReviewAuthorization {
  const { event } = opts;
  const findingsArtifacts = state.artifacts.filter((a) => a.type === "research" && hasPostableEvidence(a));

  // (a) NOTHING UNRULED MAY POST. One unreviewed findings artifact refuses the
  // whole post and names itself, so the human knows exactly what to go and rule
  // on.
  const unruled = findingsArtifacts.filter((a) => UNDECIDED_STATUSES.has(a.status));
  if (unruled.length > 0) {
    const names = unruled.map((a) => `"${a.title}" (${a.id}, ${a.status})`).join(", ");
    return {
      ok: false,
      reason:
        `Refusing to post: your pair has not given a verdict on ${unruled.length === 1 ? "this findings artifact" : "these findings artifacts"} yet — ${names}. ` +
        `Posting now would put un-reviewed findings on someone else's PR under their name. ` +
        `Wait for them to approve it in the companion UI (or reject it, or send it back), then call post_pr_review again. ` +
        `Keep polling check_feedback until then.`,
    };
  }

  // Everything left is DECIDED. Approved artifacts post; rejected/superseded/
  // retracted/obsolete are honoured by omission.
  const approved = findingsArtifacts.filter((a) => a.status === "approved");
  const decidedNo = findingsArtifacts.filter((a) => DECIDED_EXCLUDED_STATUSES.has(a.status));

  // (b) THE EXCLUSION, stated honestly. This product has NO per-finding verdict:
  // a comment can TARGET a findingIndex but carries no accept/reject state
  // (verified — the schema has no per-finding verdict field at all). So the
  // human's triage is expressed at exactly two grains, and both are enforced
  // here:
  //   • the ARTIFACT — approve it and its findings may post; reject it and none
  //     of them can;
  //   • the artifact's CONTENT — to drop one finding and keep the rest, the pair
  //     revises, which supersedes v1 (excluded above) and puts the trimmed v2 up
  //     for its own approval.
  // post-pr.md says exactly this, so the command and the mechanism now agree.
  // What is deliberately NOT treated as a rejection: a human comment on a
  // finding. A comment is as often agreement ("good catch, say it harder") as
  // dissent, so dropping a commented-on finding would be a guess — and guessing
  // is what this gate exists to stop.
  const payload = buildGitHubReviewPayload({ ...state, artifacts: approved } as never, { event });

  if (payload.comments.length === 0) {
    if (event === "APPROVE") {
      // (c) A BARE APPROVE IS A REAL VERDICT ON SOMEONE ELSE'S PR. With no
      // inline comments there is no approved findings artifact carrying the
      // human's authorization, so it must come from the other artifact this flow
      // produces: the external changeset — which IS the PR on the review
      // surface. Approving it in the UI is precisely the human act of saying
      // "this PR is good", so that is exactly what we require.
      const externals = externalChangesets(state.artifacts);
      const approvedExternal = externals.find((a) => a.status === "approved");
      if (!approvedExternal) {
        const pending = externals.filter((a) => !DECIDED_EXCLUDED_STATUSES.has(a.status));
        return {
          ok: false,
          reason: externals.length === 0
            ? `Refusing to post an APPROVE: nothing in this session records your pair approving this PR. ` +
              `An APPROVE with no inline comments is a real approving review on someone else's repository, and the agent cannot authorize it. ` +
              `Put the PR's diff on the review surface first (present_changeset with reviewIntent: "external") and let them approve it there — that approval IS the authorization.`
            : `Refusing to post an APPROVE: your pair has not approved the PR changeset yet` +
              (pending.length > 0 ? ` ("${pending[0]!.title}" is ${pending[0]!.status})` : "") +
              `. Get your pair's verdict on the changeset first — their approval in the companion UI is what authorizes an approving review on someone else's PR.`,
        };
      }
      return { ok: true, payload };
    }

    // Zero comments on a non-APPROVE event. As in the first Q6 cut, except it
    // now also names an EXCLUDED artifact rather than looking like the findings
    // simply vanished.
    const excludedNote = decidedNo.length > 0
      ? ` (${decidedNo.length} findings artifact${decidedNo.length === 1 ? " was" : "s were"} excluded — ${decidedNo.map((a) => `"${a.title}" is ${a.status}`).join(", ")})`
      : "";
    return {
      ok: false,
      reason:
        `No approved findings with structured evidence (filePath + lineStart) in this session — nothing to post as ` +
        `${event === "REQUEST_CHANGES" ? "the inline comments a REQUEST_CHANGES owes the author" : "inline review comments"}${excludedNote}. ` +
        `Use present_findings with structured Evidence objects and let your pair approve them` +
        (event === "REQUEST_CHANGES" ? "" : `, or pass event: "APPROVE" once they've approved the PR changeset`) +
        `.`,
    };
  }

  return { ok: true, payload };
}
