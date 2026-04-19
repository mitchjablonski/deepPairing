---
name: pairing-protocol
description: Use deepPairing's MCP tools (present_findings, present_options, present_spec, present_plan, log_reasoning, etc.) instead of plain text when researching, deciding, planning, or executing on this project. Turns Claude Code from a black box into a pairing partner.
---

# deepPairing Collaboration Protocol

You have deepPairing MCP tools available. Use them instead of presenting
research, decisions, and plans as plain text. The companion UI at
localhost:3847 provides rich rendering, inline code commenting, and
structured decision-making that plain terminal output cannot.

On your first tool call, the response includes:
- The companion UI URL — tell the user: "Open http://localhost:3847 to
  review findings, comment on code, and make decisions."
- **Session memory** — rejected approaches from this project (`present_*`
  tools will REFUSE any proposal that matches one), approved patterns, and
  project guardrails (migrations, CI workflows, infra paths).
- **Cross-project philosophy ledger** — the user's stances across every
  deepPairing project they've used. 'Avoid' stances with multi-project
  support are especially strong signal.

## When to use which tool

- **`present_findings`** — after researching the codebase. Rich evidence
  (file paths, line ranges, code snippets, explanations, severity). Never
  dump findings as plain text.
- **`present_options`** — at any decision point with 2-4 valid approaches.
  Set `stakes: "high"` on architecturally-significant / hard-to-reverse
  choices (schema, auth, infra, billing) — the UI captures the user's
  prediction + confidence, raw material for calibration.
- **`present_spec`** — BEFORE `present_plan` for non-trivial features.
  Objective + requirements (each with rationale and acceptance criteria) +
  optional design + tasks. "Think together before building."
- **`present_plan`** — before multi-file changes. Steps with before/after
  previews, motivated by findings / requirements.
- **`present_code_change`** — to review a single change with diff + reasoning.
- **`log_reasoning`** — BEFORE every Edit or Write. **Name the underlying
  concept** in the `concept` field (e.g. "dependency inversion",
  "optimistic UI"). This is the pairing-learning lever — surface the
  pattern so the human learns it, not just the fix.
- **`supersede_artifact`** — when the human requests revision. Creates a v2
  artifact linked via parentId; the old one flips to "superseded".
- **`retract_artifact`** — when you realize mid-flight you shouldn't have
  presented something. Graceful mid-flight exit without breaking the
  polling loop.
- **`request_horizon_check`** — sparingly, on architecturally significant
  artifacts. Captures the human's prediction about what will fail in 3mo /
  1y / 2y.
- **`recall_philosophy`** — before proposing, when a concept comes up that
  isn't already surfaced in session memory. Pulls the user's cross-project
  stance.
- **`search_sessions`** — when the user references prior work ("did we
  look at this before?").
- **`post_pr_review`** — when the user says "post these findings on PR N"
  or similar. Builds the GitHub review API payload from approved findings
  and POSTs via the `gh` CLI. Requires gh installed + authenticated. Use
  `event: "REQUEST_CHANGES"` when findings are severe (high / critical);
  default `COMMENT`.
- **`answer_question`** — when `check_feedback` surfaces a ❓QUESTION, use
  this tool (not a plain comment) so the reply gets linked to the original
  question.
- **`check_feedback`** — poll for human responses in a loop. Each call
  waits up to 30s. If it returns WAITING, call again immediately. Human
  responds in the companion UI, NOT the terminal.

## Reviewing a PR (a common workflow)

When the user says "review this PR", "audit this branch", or similar,
don't just dump a list of issues. Run this pattern:

1. **Fetch context.** Use `gh pr diff <N>` (or read the changed files
   directly) to see what changed.
2. **`present_findings`** — one call with ALL issues you found, each with
   structured `Evidence` (filePath + lineStart + lineEnd + snippet +
   explanation) and a `severity` (info / low / medium / high / critical).
   Group by file when there are many. NEVER list findings as plain chat
   text — the UI's inline-triage affordance only works with structured
   artifacts.
3. **Poll `check_feedback` in a loop** while the user triages findings
   in the companion UI. They can approve/revise/reject each one with
   per-finding chips (✓ / ↻ / ✗). Rejected findings get a reason that
   flows into session memory so you don't re-propose them.
4. **When the user says to post it** (or equivalently: "we're done",
   "ship this review") — call `post_pr_review` with the PR number.
   Only the findings approved (or not explicitly rejected) will post.
   Use `event: "REQUEST_CHANGES"` if there are critical / high severity
   findings; `COMMENT` otherwise.

The user never has to know the tool names. Just the outcome:
*review → post when approved*.

## Polling, not blocking

After any `present_*` call, call `check_feedback` in a loop. Each call
waits up to 30 seconds. If it returns WAITING, call it again immediately.
**Do not stop polling to ask the user in the terminal.** The human
reviews in the companion UI.

## Rejected approaches (CRITICAL)

Session memory includes "rejected approaches" with reasons and concepts.
The `present_*` tools will refuse (`REJECTED_APPROACH_BLOCKED`) if your
proposal matches by surface name OR by underlying concept. Do not retry —
revise your proposal to exclude the rejected approach, or present_findings
first to make the case for reconsidering.

## Guardrails

Project guardrails (migrations, `.github/workflows/`, `Dockerfile`, `.env`)
are detected by filesystem. Even when autonomy is "autonomous", escalate
to supervised for changes touching these paths.

## Craft-development surfaces (sparingly)

- On architecturally-significant decisions, set `stakes: "high"` on
  `present_options`. The UI captures the user's prediction — calibration
  material for future sessions.
- After a significant plan / code change, you may call
  `request_horizon_check` to ask the user about a failure mode 3mo / 1y /
  2y out. Use sparingly; this is not a checkbox.

## Don't

- Dump findings, options, or plans as plain-text bullet lists.
- Propose anything matching a rejected approach.
- Stop polling and ask the human in the terminal.
- Bail to terminal to apologize mid-flight — use `retract_artifact`.
- Call `request_horizon_check` on every artifact.
