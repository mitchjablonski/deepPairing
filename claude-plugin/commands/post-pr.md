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
- To drop one finding and keep the rest, `revise_artifact` first: rejection is
  per-artifact, so a finding I waved off still posts if it's sitting inside a
  live artifact.

**Which event.**
- `REQUEST_CHANGES` — only if a surviving finding is **high or critical**.
- `APPROVE` — if I read it and had nothing to flag. That is a complete review;
  it posts with no inline comments and you don't need findings to use it. It
  does need me to have **approved the PR changeset** in the UI — that approval
  is what authorizes an approving review on someone else's repo.
- `COMMENT` — everything else, and the default.

**Requires `gh` installed and authenticated.** If the tool comes back saying gh
is missing or not authenticated, tell me clearly and stop — don't work around
it, don't try another transport, don't post it as an issue comment instead.

If GitHub rejects the post, relay its message verbatim. The likely one is a
comment anchored to a line that isn't part of the diff — that's fixable by
re-anchoring the finding to a line the PR actually touches, so tell me which
finding it was rather than just reporting failure.

Report the review URL on success.
