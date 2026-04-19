---
description: Post the current deepPairing session's findings as inline review comments on a GitHub PR
argument-hint: [pr-number-or-url]
---

Call `deepPairing_post_pr_review` with pr: "$ARGUMENTS"

If there are high or critical severity findings in the session, use
`event: "REQUEST_CHANGES"`. Otherwise use the default `COMMENT`.

Requires the `gh` CLI installed and authenticated. If the tool returns an
error about gh missing or unauthenticated, tell me clearly and stop —
don't try to work around it.

Report the created review URL on success.
