---
description: Post what we landed on as a review on a GitHub PR — inline comments from the findings that survived
argument-hint: [pr-number-or-url]
---

Post our review on PR $ARGUMENTS.

Call `post_pr_review` with `pr: "$ARGUMENTS"`.

**What posts.** Findings that carry structured evidence (`filePath` +
`lineStart`), from artifacts I didn't reject. Those coordinates become the
inline comments — a finding without them has nowhere to land on the diff and
won't post. If I dismissed something during the review, take it out of the
artifact with `revise_artifact` before posting: rejection is per-artifact, so a
finding I waved off will still go to the PR if it's sitting in a live one.

**Which event.**
- `REQUEST_CHANGES` — only if a surviving finding is **high or critical**.
- `APPROVE` — if I read it and had nothing to flag. That is a complete review;
  it posts with no inline comments and you don't need findings to use it.
- `COMMENT` — everything else, and the default.

**Requires `gh` installed and authenticated.** If the tool comes back saying gh
is missing or not authenticated, tell me clearly and stop — don't work around
it, don't try another transport, don't post it as an issue comment instead.

If GitHub rejects the post, relay its message verbatim. The likely one is a
comment anchored to a line that isn't part of the diff — that's fixable by
re-anchoring the finding to a line the PR actually touches, so tell me which
finding it was rather than just reporting failure.

Report the review URL on success.
