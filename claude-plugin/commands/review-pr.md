---
description: Pair on a GitHub PR with me — surface findings together, then (after my approval) post them as inline comments
argument-hint: [pr-number-or-url]
---

Pair with me on PR $ARGUMENTS. The PR is the surface we're looking at
together; this is NOT an automated review pass. Run this pattern:

1. Fetch the diff via `gh pr diff $ARGUMENTS` so we're looking at the
   same thing.
2. Call `present_findings` with ONE artifact containing
   everything that stood out to you. For each finding, attach structured
   evidence (`filePath`, `lineStart`, `lineEnd`, `snippet`, `explanation`)
   and a `severity` (info / low / medium / high / critical). Name the
   concept at play via `log_reasoning` alongside each finding so I learn
   from the pattern, not just the fix.
3. Poll `check_feedback` and let me triage each finding in
   the companion UI. We decide together what's load-bearing. Do NOT post
   anything yet.
4. When I say "post it" / "ship what we found" / "we're done here", call
   `post_pr_review` with pr: "$ARGUMENTS". Only the
   surviving findings post. Use `event: "REQUEST_CHANGES"` only if a
   surviving finding is high or critical; `event: "COMMENT"` otherwise.
5. Report the review URL.

If I reject a finding with a reason, remember it — that reason goes into
session memory and you won't re-propose it next time.
