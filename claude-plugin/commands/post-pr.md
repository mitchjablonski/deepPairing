---
description: Post what we paired on as inline comments on a GitHub PR
argument-hint: [pr-number-or-url]
---

Call `post_pr_review` with pr: "$ARGUMENTS"

Only the findings we landed on together get posted. Use
`event: "REQUEST_CHANGES"` only if a surviving finding is high or
critical severity; otherwise use the default `COMMENT`.

Requires the `gh` CLI installed and authenticated. If the tool returns
an error about gh missing or unauthenticated, tell me clearly and stop —
don't try to work around it.

Report the created review URL on success.
