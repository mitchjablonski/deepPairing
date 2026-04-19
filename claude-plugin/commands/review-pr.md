---
description: Review a GitHub PR and (after my approval) post the findings as inline review comments
argument-hint: [pr-number-or-url]
---

Walk through the PR review workflow for PR $ARGUMENTS:

1. Fetch the diff via `gh pr diff $ARGUMENTS` so you know exactly what
   changed.
2. Call `deepPairing_present_findings` with ONE artifact containing every
   issue you spot. For each finding, attach structured evidence
   (`filePath`, `lineStart`, `lineEnd`, `snippet`, `explanation`) and a
   `severity` (info / low / medium / high / critical). Name the concept
   at play via the `log_reasoning` tool alongside each issue so I learn
   from it.
3. Poll `deepPairing_check_feedback` and let me triage each finding in
   the companion UI. Do NOT post anything yet.
4. When I say "post it" (or "ship the review", etc.), call
   `deepPairing_post_pr_review` with pr: "$ARGUMENTS". Use
   `event: "REQUEST_CHANGES"` if any surviving finding is high or
   critical; `event: "COMMENT"` otherwise.
5. Report the review URL.

If I reject a finding with a reason, remember it — that reason goes into
session memory and you won't re-propose it next time.
