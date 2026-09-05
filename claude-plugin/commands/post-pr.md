---
description: Post what we landed on as a review on a GitHub PR — inline comments from the findings that survived
argument-hint: [pr-number-or-url]
---

Post our review on PR $ARGUMENTS.

Call `post_pr_review` with `pr: "$ARGUMENTS"`.

**What posts.** Findings that carry structured evidence (`filePath` +
`lineStart`) from artifacts **I approved**. Those coordinates become the inline
comments — a finding without them has nowhere to land on the diff and won't
post.

The tool checks my recorded verdicts against the session store before it calls
out to GitHub, and refuses if they aren't there. So if it comes back refusing:

- **"has not given a verdict on…"** — I never ruled on that findings artifact.
  Go and get my verdict; don't try to route around it. There is no override
  flag, and asking me in chat is not the same as me approving it in the UI.
- **findings I rejected** are excluded on their own — you don't need to do
  anything.
- **findings marked `audience: "internal"`** never post either. Anything read
  out of my ledger or my past sessions is mine, not the author's business.
- To drop one finding and keep the rest, `revise_artifact` first: rejection is
  per-artifact, so a finding I waved off still posts if it's sitting inside a
  live artifact.
- **"actually, don't send that one"** on a whole artifact I already approved:
  `revise_artifact` with `mode: "retract"`. In a PR-review session that un-arms
  it — approval is what armed it — and it can't be posted afterwards.

**Which event.** The first two are checked in code, not taken on trust.
- `REQUEST_CHANGES` — only if a surviving finding is **high or critical**. It
  blocks the author's merge, so the tool requires one and names the highest
  severity I approved when it refuses. Post a `COMMENT` instead; don't re-rate a
  finding to clear the gate.
- `APPROVE` — if I read it and had nothing to flag. That is a complete review;
  it posts with no inline comments and you don't need findings to use it. It
  does need me to have **approved every live PR changeset** in the UI — and it
  is refused outright if I rejected one. Every standing chunk must name the
  same immutable `source.headSha`; missing, malformed, mixed, or stale commit
  provenance refuses instead of substituting the PR's current head. That
  approval is what authorizes an
  approving review on someone else's repo. A bare approve carries a genuine
  approval line for the author automatically ("Reviewed with deepPairing — no
  blocking findings") — you don't compose the body.
- `COMMENT` — everything else, and the default. Anything that isn't one of these
  three is refused rather than guessed at. A wholly legacy review with no
  recorded head SHA may still post COMMENT/REQUEST_CHANGES unbound, but once
  any standing chunk has a SHA, they must all carry the same valid one.

Before sending, the tool reads the current remote head and then re-reads my
local authorization. The outbound GitHub `commit_id` is the commit I reviewed,
never the current head guessed after the fact. GitHub has no atomic
compare-and-post operation, so a push can still race after that read; this is a
bound-commit guarantee, not a claim that the branch was locked during POST.

**It posts once.** The tool records a landed review and refuses a second post to
the same PR, with the URL of the first — a re-post notifies the author all over
again. Give me that URL. Only if I actually say "post it again" do you re-issue
with `repost: true`.

**Requires `gh` installed and authenticated.** If the tool comes back saying gh
is missing or not authenticated, tell me clearly and stop — don't work around
it, don't try another transport, don't post it as an issue comment instead.

If GitHub rejects the post, relay its message verbatim. The likely one is a
comment anchored to a line that isn't part of the diff — that's fixable by
re-anchoring the finding to a line the PR actually touches, so tell me which
finding it was rather than just reporting failure.

Report the review URL on success.
