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
 *
 * ---------------------------------------------------------------------------
 * R1 (#279) — WHAT ROUND 13 FOUND STILL OPEN, all of it by execution:
 *
 *  1. THE APPROVE HOLE. The external-changeset requirement lived INSIDE
 *     `if (payload.comments.length === 0)`, so an APPROVE carrying one approved
 *     finding skipped it entirely — an approving review was posted with both
 *     changesets still in draft, and again on a PR the human had REJECTED.
 *     The requirement is now unconditional for APPROVE, and a rejected external
 *     changeset refuses outright instead of being quietly excluded.
 *  2. ONE-OF-N. `externals.find(status === "approved")` authorized a whole-PR
 *     APPROVE off one approved chunk of a split PR. ALL live external
 *     changesets must now be approved.
 *  3. EVENT NORMALIZATION AT BOTH DOORS. The MCP tool whitelisted; the CLI
 *     passed `(event as any) || "COMMENT"` straight through, so "bogus",
 *     "MERGE" and lowercase "approve" all reached this function — and
 *     "approve" slipped past the `event === "APPROVE"` comparison, taking the
 *     APPROVE authorization with it. Normalization lives HERE now, in the one
 *     place both doors share, and an unknown event is refused rather than
 *     silently downgraded.
 *  4. THE PRIVATE-STANCE LEAK. See isPostableFinding / `audience` in the shared
 *     Finding schema — internal findings are excluded from the payload here and
 *     in buildGitHubReviewPayload, and cannot make an artifact's status
 *     load-bearing either.
 *  6. IDEMPOTENCY. Five calls posted five reviews. A post is recorded in the
 *     session store on success and a second post to the same PR refuses unless
 *     the human explicitly said "post again" (`repost`).
 *  7. THE SEVERITY GATE. "REQUEST_CHANGES only if high/critical" was prose in
 *     two command files — and a low/style finding duly posted a blocking review
 *     on someone's PR. It is a check now.
 */
import type { Artifact, Finding } from "@deeppairing/shared";
import { coerceResearchContent, coerceChangesetContent, isPostableFinding } from "@deeppairing/shared";
import { buildGitHubReviewPayload, type GitHubReviewPayload, type GitHubReviewEvent } from "../export/format-markdown.js";
import type { PostedReviewRecord } from "../store/posted-reviews.js";
import { samePrTarget, parsePrNumber } from "../store/posted-reviews.js";

/** The minimum of a session this gate reads. Structural, so both callers'
 *  slightly different state shapes (store.getFullState vs FileStore.loadSession)
 *  satisfy it without a cast at the call site. */
export interface AuthorizableSession {
  sessionId: string;
  artifacts: Artifact[];
  /** R1 (#279) — reviews already posted FROM this session. Rides getFullState
   *  on both stores (absent on sessions that never posted), so both doors read
   *  the same record with no extra round-trip. */
  postedReviews?: PostedReviewRecord[];
  [k: string]: unknown;
}

export type ReviewAuthorization =
  | { ok: true; payload: GitHubReviewPayload; event: GitHubReviewEvent; reviewedHeadSha?: string }
  | { ok: false; reason: string };

/** R1 (#279) — the three events GitHub's review API accepts, and the ONLY three
 *  this product will send. `PENDING` (save a draft review) is deliberately not
 *  offered: it would be a post the human never asked for, sitting on their
 *  colleague's PR under their name. */
const ALLOWED_EVENTS: readonly GitHubReviewEvent[] = ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const;

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

/** Severity ordering for the REQUEST_CHANGES gate. Absent severity reads as
 *  "info" — the same default buildGitHubReviewPayload renders. */
const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Does this evidence entry anchor to a real diff coordinate? Mirrors
 *  buildGitHubReviewPayload's own predicate (structured evidence with filePath
 *  + numeric lineStart). */
function isAnchored(e: unknown): boolean {
  return (
    !!e && typeof e === "object" &&
    !!(e as { filePath?: unknown }).filePath &&
    typeof (e as { lineStart?: unknown }).lineStart === "number"
  );
}

/**
 * The findings on this artifact that WOULD become inline PR comments: postable
 * audience (R1) AND anchored to a diff coordinate.
 *
 * Both filters must match buildGitHubReviewPayload exactly, or the gate and the
 * payload disagree about what is being posted — which is how a "no findings to
 * post" refusal and a review carrying findings can both be true at once.
 */
function outboundFindings(artifact: Artifact): Finding[] {
  const findings = coerceResearchContent(artifact.content).findings;
  if (!Array.isArray(findings)) return [];
  return findings.filter(
    (f) => isPostableFinding(f) && (Array.isArray(f.evidence) ? f.evidence : []).some(isAnchored),
  );
}

/** Does this findings artifact carry at least one finding that would become an
 *  inline PR comment? A findings artifact with only prose evidence — or, since
 *  R1, only INTERNAL findings — posts nothing, so its status is not
 *  load-bearing and must not be able to block an otherwise-authorized post. */
function hasPostableEvidence(artifact: Artifact): boolean {
  return outboundFindings(artifact).length > 0;
}

/** The session's external-review changesets — a colleague's PR on the review
 *  surface (Q6's reviewIntent). */
function externalChangesets(artifacts: Artifact[]): Artifact[] {
  return artifacts.filter(
    (a) => a.type === "changeset" && coerceChangesetContent(a.content).reviewIntent === "external",
  );
}

const CLOSED_CHANGESET_STATUSES = new Set(["superseded", "retracted", "obsolete"]);
const FULL_GIT_SHA = /^[0-9a-fA-F]{40}$/;

type ParsedPr = NonNullable<ReturnType<typeof parsePrNumber>>;

function samePrIdentity(target: ParsedPr, reviewed: ParsedPr): boolean {
  return target.number === reviewed.number &&
    (!target.owner || (!!reviewed.owner && target.owner.toLowerCase() === reviewed.owner.toLowerCase())) &&
    (!target.repo || (!!reviewed.repo && target.repo.toLowerCase() === reviewed.repo.toLowerCase()));
}

interface ExternalTargetScope {
  matching: Artifact[];
  /** A parseable source URL for another PR. */
  other: Array<{ artifact: Artifact; reviewed: ParsedPr }>;
  /** A source that claims the target URL but contradicts it with source.number. */
  contradictory: Artifact[];
  /** Legacy/malformed source provenance cannot establish a target identity. */
  unknown: Artifact[];
}

/** Partition external-review chunks by the requested PR. Unrelated PRs are
 * valid session history, not contaminants of the target review. */
function scopeExternalChangesets(artifacts: Artifact[], ref: string): ExternalTargetScope {
  const target = parsePrNumber(ref);
  const scope: ExternalTargetScope = { matching: [], other: [], contradictory: [], unknown: [] };

  for (const artifact of artifacts) {
    const source = coerceChangesetContent(artifact.content).source;
    const reviewed = source?.url ? parsePrNumber(source.url) : null;
    if (!target || !reviewed?.owner || !reviewed.repo) {
      scope.unknown.push(artifact);
      continue;
    }
    if (samePrIdentity(target, reviewed)) {
      if (source?.number !== undefined && source.number !== reviewed.number) scope.contradictory.push(artifact);
      else scope.matching.push(artifact);
    } else {
      scope.other.push({ artifact, reviewed });
    }
  }
  return scope;
}

/** #343 — derive the ONE immutable commit represented by the supplied standing
 * target chunks. This reads the raw persisted value as well as the coercer:
 * coercion intentionally drops malformed optional fields for legacy
 * readability, but the authorization boundary must distinguish "old/missing"
 * from "someone supplied a broken SHA" and fail closed.
 *
 * COMMENT/REQUEST_CHANGES compatibility is intentionally narrow: a wholly
 * legacy session (all missing) remains postable without commit_id. Once any
 * standing chunk claims SHA provenance, every standing chunk must carry the
 * same valid SHA. APPROVE always requires that complete provenance. */
function reviewedHeadFor(
  artifacts: Artifact[],
  event: GitHubReviewEvent,
): { ok: true; headSha?: string } | { ok: false; reason: string } {
  const standing = artifacts.filter((a) => !CLOSED_CHANGESET_STATUSES.has(a.status));
  const valid: Array<{ artifact: Artifact; sha: string }> = [];
  const missing: Artifact[] = [];
  const malformed: Artifact[] = [];

  for (const artifact of standing) {
    const rawSource = artifact.content && typeof artifact.content === "object"
      ? (artifact.content as { source?: unknown }).source
      : undefined;
    const rawSha = rawSource && typeof rawSource === "object"
      ? (rawSource as { headSha?: unknown }).headSha
      : undefined;
    if (rawSha === undefined) {
      missing.push(artifact);
    } else if (typeof rawSha !== "string" || !FULL_GIT_SHA.test(rawSha)) {
      malformed.push(artifact);
    } else {
      valid.push({ artifact, sha: rawSha.toLowerCase() });
    }
  }

  if (malformed.length > 0) {
    return {
      ok: false,
      reason:
        `Refusing to post: malformed reviewed head SHA on ${malformed.map((a) => `"${a.title}" (${a.id})`).join(", ")}. ` +
        `Capture the exact 40-hex headRefOid from GitHub, present that commit's diff, and get a fresh human verdict; the current PR head is never guessed as an old approval's commit.`,
    };
  }

  if (valid.length === 0) {
    if (event !== "APPROVE") return { ok: true };
    return {
      ok: false,
      reason:
        `Refusing to post an APPROVE: ${standing.length === 0 ? "no standing external changeset" : missing.map((a) => `"${a.title}" (${a.id})`).join(", ")} ` +
        `records the immutable reviewed head SHA. Legacy session files remain readable, but an unknown commit cannot authorize an approval. ` +
        `Fetch headRefOid, present that exact diff as a fresh external changeset, and get your pair's verdict again; never substitute the PR's current head for an old approval.`,
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `Refusing to post: mixed immutable-SHA provenance across the standing external changesets. ` +
        `${valid.map(({ artifact }) => `"${artifact.title}" (${artifact.id})`).join(", ")} name a reviewed commit, but ` +
        `${missing.map((a) => `"${a.title}" (${a.id})`).join(", ")} do not. Present every chunk from one exact head SHA and get fresh verdicts.`,
    };
  }

  const bySha = new Map<string, Artifact[]>();
  for (const entry of valid) bySha.set(entry.sha, [...(bySha.get(entry.sha) ?? []), entry.artifact]);
  if (bySha.size !== 1) {
    const detail = [...bySha.entries()]
      .map(([sha, chunks]) => `${sha.slice(0, 12)} (${chunks.map((a) => a.id).join(", ")})`)
      .join("; ");
    return {
      ok: false,
      reason:
        `Refusing to post: the standing external changesets describe different reviewed commits: ${detail}. ` +
        `A review is one verdict on one immutable PR head; present every chunk from the same commit and get fresh human verdicts.`,
    };
  }
  return { ok: true, headSha: valid[0]!.sha };
}

/**
 * R1 (#279) fix 3 — normalize the event at the ONE door both callers share.
 *
 * Accepts absent/empty as COMMENT (the documented default at both doors) and
 * uppercases before comparing, so "approve" is APPROVE and gets the APPROVE
 * authorization instead of sliding past a `=== "APPROVE"` test into a
 * no-questions-asked post. Anything else is REFUSED, not coerced: "MERGE" is
 * not a review event, and quietly turning it into a COMMENT would post
 * something nobody asked for.
 *
 * R1 F2 — a non-STRING event is refused before it is ever stringified. The
 * contract is a string enum; `["approve"]` and `{ toString: () => "approve" }`
 * both String()-coerce to "approve", and while the full APPROVE authorization
 * would still run on the result (so this is a contract violation, not a
 * bypass), the honest answer to "the event isn't a string" is to say so, not to
 * silently accept whatever its coercion happens to spell.
 */
function normalizeEvent(raw: unknown): { ok: true; event: GitHubReviewEvent } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { ok: true, event: "COMMENT" };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      reason:
        `Refusing to post: the review event must be a string (one of COMMENT, REQUEST_CHANGES, APPROVE), ` +
        `not a ${Array.isArray(raw) ? "array" : typeof raw}. Pass the event as a plain string.`,
    };
  }
  const normalized = raw.trim().toUpperCase();
  const match = ALLOWED_EVENTS.find((e) => e === normalized);
  if (!match) {
    return {
      ok: false,
      reason:
        `Refusing to post: "${raw}" is not a review event. GitHub reviews are one of ` +
        `COMMENT, REQUEST_CHANGES, APPROVE — and each means something different on someone else's PR, ` +
        `so this is not guessed at. Re-issue the call with the one you meant ` +
        `(REQUEST_CHANGES only when a surviving finding is high or critical; APPROVE only when your pair approved the PR changeset).`,
    };
  }
  return { ok: true, event: match };
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
  opts: {
    /** RAW, straight off either door — normalized and whitelisted in here. */
    event: unknown;
    /** The PR this post targets ("42", "#42", or a URL). Enables the
     *  already-posted check; omitted only by callers with no ref to give. */
    pr?: string;
    /** The human said "post it again". The agent must never set this on its
     *  own initiative — see post-pr.md / review-pr.md. */
    repost?: boolean;
  },
): ReviewAuthorization {
  // (0) THE EVENT ITSELF. Before any verdict is read: an event this product
  // does not send cannot be authorized by anything.
  const normalized = normalizeEvent(opts.event);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  const event = normalized.event;

  // (0b) R1 fix 6 — ALREADY POSTED. Round 13 called post_pr_review five times
  // and got five separate reviews on the same PR, each notifying the author.
  // A review is not idempotent on GitHub's side and nothing here made it so.
  // The record is the session store's, written on success by whichever door
  // posted, so a retry from the OTHER door sees it too.
  const alreadyPosted = opts.pr && !opts.repost
    ? (state.postedReviews ?? []).find((r) => samePrTarget(r, opts.pr!))
    : undefined;
  if (alreadyPosted) {
    return {
      ok: false,
      reason:
        `Refusing to post: this session already posted a ${alreadyPosted.event} review on ${alreadyPosted.pr}` +
        (alreadyPosted.url ? ` — ${alreadyPosted.url}` : "") +
        ` (${alreadyPosted.postedAt}). Posting again would notify the author a second time with a second review. ` +
        `Tell your pair it is already up and link them to it. If they say "post again", re-issue this call with repost: true — ` +
        `that flag is THEIR word, never your own initiative.`,
    };
  }

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

  // A verdict belongs to the requested PR. A session may legitimately review
  // several PRs, so only matching chunks determine this target's verdict and
  // immutable SHA. Legacy source-less chunks remain usable for COMMENT when
  // approved findings authorize an actual payload, but can never grant an
  // APPROVE because they establish neither repository nor commit identity.
  let targetExternals = externalChangesets(state.artifacts);
  if (opts.pr) {
    const standing = targetExternals.filter(a =>
      !CLOSED_CHANGESET_STATUSES.has(a.status));
    const standingScope = scopeExternalChangesets(standing, opts.pr);
    if (standingScope.contradictory.length > 0) {
      const artifact = standingScope.contradictory[0]!;
      return {
        ok: false,
        reason: `Refusing to post: "${artifact.title}" (${artifact.id}) has a source.number that contradicts its source.url. Present one coherent PR identity and get your pair's verdict again.`,
      };
    }
    if (standingScope.matching.length === 0 && standingScope.other.length > 0) {
      const { artifact, reviewed } = standingScope.other[0]!;
      return {
        ok: false,
        reason:
          `Refusing to post: "${artifact.title}" identifies https://github.com/${reviewed.owner}/${reviewed.repo}/pull/${reviewed.number}, ` +
          `not the requested PR ${opts.pr}. Present the requested PR with its full source.url and get your pair's verdict before posting.`,
      };
    }
    targetExternals = scopeExternalChangesets(targetExternals, opts.pr).matching;
  }

  // (c) A BARE APPROVE IS A REAL VERDICT ON SOMEONE ELSE'S PR — and so is an
  // APPROVE that happens to carry inline comments.
  //
  // R1 fix 1 — THIS CHECK USED TO LIVE INSIDE the zero-comments branch below,
  // which meant one approved finding was enough to skip it: round 13 posted an
  // approving review with both external changesets still in DRAFT, and then
  // posted another on a PR the human had explicitly REJECTED. The event is what
  // makes this a verdict, not the comment count, so the event is what gates it.
  if (event === "APPROVE") {
    const externals = targetExternals;

    // The human's "no" on the PR itself is not an exclusion — it is the
    // opposite verdict, and an APPROVE contradicts it outright.
    const refused = externals.filter((a) => a.status === "rejected" || a.status === "revised");
    if (refused.length > 0) {
      const first = refused[0]!;
      return {
        ok: false,
        reason:
          `Refusing to post an APPROVE: your pair ${first.status === "rejected" ? "REJECTED" : "sent back for changes"} ` +
          `"${first.title}" (${first.id}) — that is their verdict on this PR, recorded in the companion UI. ` +
          `An approving review would publish the opposite of what they decided. ` +
          `If they have changed their mind, they re-approve the changeset in the UI first; nothing else counts.`,
      };
    }

    // R1 fix 2 — ALL of them, not `find(...)`. A PR split across three
    // changesets had one approved chunk authorize the whole-PR APPROVE; the
    // human had approved a third of the diff and GitHub was told they approved
    // all of it. (One changeset per PR is still the right default — see
    // review-pr.md — but the gate must not depend on the agent honouring it.)
    const live = externals.filter((a) => !DECIDED_EXCLUDED_STATUSES.has(a.status));
    const unapproved = live.filter((a) => a.status !== "approved");
    if (live.length === 0 || unapproved.length > 0) {
      const pending = unapproved[0];
      return {
        ok: false,
        reason: externals.length === 0
          ? `Refusing to post an APPROVE: nothing in this session records your pair approving this PR. ` +
            `An APPROVE is a real approving review on someone else's repository, and the agent cannot authorize it. ` +
            `Put the PR's diff on the review surface first (present_changeset with reviewIntent: "external") and let them approve it there — that approval IS the authorization.`
          : live.length === 0
            ? `Refusing to post an APPROVE: every external changeset in this session is closed (superseded/retracted/obsolete), so nothing standing records your pair approving this PR. ` +
              `Put the current diff on the review surface and let them approve it there — that approval IS the authorization.`
            : `Refusing to post an APPROVE: your pair has not approved the PR changeset — they have ` +
              `approved ${live.length - unapproved.length} of ${live.length} changeset${live.length === 1 ? "" : "s"} for this PR` +
              (pending ? ` ("${pending.title}" (${pending.id}) is ${pending.status})` : "") +
              `. An APPROVE covers the WHOLE pull request, so every part of it they are reviewing has to carry their approval. ` +
              `Get their verdict on the rest first — their approval in the companion UI is what authorizes an approving review on someone else's PR.`,
      };
    }
  }

  const reviewedHead = reviewedHeadFor(targetExternals, event);
  if (!reviewedHead.ok) return { ok: false, reason: reviewedHead.reason };

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
  // The outbound title is derived only from approved research. Private
  // decisions are unrelated session context and must never leak into a review
  // header when no findings title is available.
  const payload = buildGitHubReviewPayload({ ...state, artifacts: approved, decisions: [] } as never, { event });
  if (reviewedHead.headSha) payload.commit_id = reviewedHead.headSha;

  if (payload.comments.length === 0) {
    // An APPROVE got here only by passing the authorization above, and a bare
    // APPROVE (no inline comments) is its normal, commonest shape.
    if (event === "APPROVE") return { ok: true, payload, event, reviewedHeadSha: reviewedHead.headSha };

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

  // R1 fix 7 — THE SEVERITY GATE, mechanical at last.
  //
  // "REQUEST_CHANGES only if a surviving finding is high/critical" was written
  // in review-pr.md, in post-pr.md, and in SKILL.md — three copies of a rule
  // nothing enforced — and round 13 duly posted a BLOCKING review on a
  // colleague's PR off a single low-severity style nit. REQUEST_CHANGES is the
  // one event that stops a merge; it needs a finding that earns it.
  if (event === "REQUEST_CHANGES") {
    const outbound = approved.flatMap(outboundFindings);
    const blocking = outbound.filter((f) => SEVERITY_RANK[f.severity ?? "info"]! >= SEVERITY_RANK.high!);
    if (blocking.length === 0) {
      const highest = outbound.reduce(
        (acc, f) => (SEVERITY_RANK[f.severity ?? "info"]! > SEVERITY_RANK[acc]! ? (f.severity ?? "info") : acc),
        "info" as string,
      );
      return {
        ok: false,
        reason:
          `Refusing to post a REQUEST_CHANGES: the highest severity your pair approved is "${highest}", and REQUEST_CHANGES blocks the author's merge. ` +
          `Post these as event: "COMMENT" instead — the findings land as the same inline comments, without holding up their PR. ` +
          `If something here really is high or critical, say so to your pair, raise the severity in a revision, and get their verdict on that.`,
      };
    }
  }

  return {
    ok: true,
    payload,
    event,
    ...(reviewedHead.headSha ? { reviewedHeadSha: reviewedHead.headSha } : {}),
  };
}
