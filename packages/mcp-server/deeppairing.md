# deepPairing Collaboration Protocol

**IMPORTANT: You have deepPairing MCP tools available. Use them instead of
presenting research, decisions, and plans as plain text.** The companion UI
provides rich rendering, inline code commenting, and structured decision-making
that plain terminal output cannot.

When you first respond, tell the user: "I have deepPairing tools for structured
collaboration. Open the companion UI to review findings, comment on code, and
make decisions." The URL will be shown in your first tool call response.

## When to Use deepPairing Tools

**Always use `present_findings`** when you have research results, code analysis,
or codebase observations to share. Never dump findings as plain text.

**Always use `present_options`** when there are 2+ valid approaches and you need
the human to choose. Never just list options in text.

**Use `present_spec`** BEFORE `present_plan` for any non-trivial feature. A
spec makes the mental model explicit: objective + requirements (with rationale
AND acceptance criteria) + optional design notes + tasks that trace back to
requirements. Skip for simple tasks. This is a learning artifact, not a
compliance doc — each requirement is a rationale the human can challenge.

**Always use `present_plan`** before multi-file changes. Never describe a plan
in text only.

**Always use `present_code_change`** when you want the human to review a specific
change with before/after context.

**Always use `log_reasoning`** before every Edit or Write to explain your reasoning.

**The only exception** is simple tasks (typo fixes, one-line changes) where the
overhead isn't worth it.

## Task Complexity

Not every task needs the full workflow. Match your ceremony to the task:

**Simple tasks** (typo fixes, renames, one-line changes, formatting):
- Skip present_findings and present_options entirely
- Call log_reasoning with a brief note, then make the change
- No need for present_plan for single-file changes

**Medium tasks** (bug fixes, small features, refactors within one module):
- present_findings if you discover something non-obvious
- Skip present_options unless there's a genuine architectural choice
- present_plan if touching 3+ files

**Complex tasks** (new features, cross-cutting changes, architectural decisions):
- Full workflow: findings → options → plan → execute with reasoning
- This is where deepPairing shines — the human needs to understand deeply

## Tools

### deepPairing_present_findings
Call AFTER researching the codebase, BEFORE proposing solutions.

Provide RICH evidence — actual code snippets, not file references:

BAD:
```json
{ "detail": "Weak hashing", "evidence": "auth.ts:5", "significance": "high" }
```

GOOD:
```json
{
  "title": "Weak Password Hashing",
  "detail": "bcrypt with only 10 salt rounds, below OWASP minimum",
  "evidence": [{
    "filePath": "src/routes/auth.ts",
    "lineStart": 5, "lineEnd": 8,
    "snippet": "const hash = await bcrypt.hash(password, 10);",
    "explanation": "Uses 10 rounds. OWASP recommends 12+ or argon2id.",
    "relatedPaths": ["src/middleware/auth.ts"]
  }],
  "significance": "high",
  "severity": "high",
  "impact": "Vulnerable to GPU brute-force if database compromised",
  "recommendation": "Switch to argon2id with memoryCost: 65536, timeCost: 3"
}
```

For each finding, always provide: title, actual code snippet, explanation of WHY,
impact if not addressed, specific recommendation.

**significance vs severity:** `significance` is *note-worthiness* (is this worth
surfacing?). `severity` is *risk-level-if-unaddressed* (info / low / medium /
high / critical). Both populated gives the human both signals: what's
interesting and what to study first.

### deepPairing_present_options
Call at ANY decision point with multiple valid approaches. Present 2-4 options.

This tool is **non-blocking** — it records the options and returns immediately.
The human can select in the companion UI or tell you directly.

Call `deepPairing_check_feedback` afterward to see if they've decided.

### deepPairing_present_spec
Call BEFORE `present_plan` for non-trivial features. The spec is
"think together before building" — the human challenges rationales and
acceptance criteria before you commit to an approach.

Fields:
- `title`, `objective` (one sentence), `context` (optional background)
- `requirements[]`: each with `id` (e.g. REQ-1), `statement`, `rationale`
  (the WHY — this is where learning happens), `acceptanceCriteria[]`
  (testable conditions), optional `priority` ("must" / "should" / "could")
- `design` (optional high-level notes, not a full doc)
- `tasks[]`: each with `description`, `linkedRequirementIds[]` for
  traceability, optional `estimate` (xs / s / m / l / xl)
- `openQuestions[]`: things you need the human to decide

After approval, call `present_plan` to translate requirements into
implementation steps.

### deepPairing_present_plan
Call BEFORE multi-file changes. Present implementation steps with:
- Which findings motivated each step (motivatedBy)
- Before/after code previews for non-trivial changes
- Structured file changes with descriptions

This tool is **non-blocking** — call `deepPairing_check_feedback` for approval.

### deepPairing_log_reasoning
Call BEFORE every Edit or Write. Explain what and why.

**PAIRING IMPERATIVE — name the concept.** Every time an engineering concept
or pattern is at play, surface it via `concept`. Think: *what is the underlying
pattern this person would need to understand to make the same choice next
time?* Examples: `"dependency inversion"`, `"optimistic UI"`, `"debounce vs
throttle"`, `"command-query separation"`. Include a one-line plain-English
definition in `oneLineExplanation` for concepts the reader might not know.

This is the single highest-leverage move in deepPairing. The human is learning
*from* you — naming the pattern turns every action into a teaching moment.
Name it even when it feels obvious.

Also populate:
- `evidence`: files/line ranges that motivated this reasoning, when it came
  from the codebase
- `relatesTo: { artifactId, kind }`: back-link to a parent artifact when this
  reasoning elaborates, answers, or supersedes another

Example:
```json
{
  "action": "Replace the auth guard with middleware composition",
  "reasoning": "The guard is called in six handlers and each re-implements role checking...",
  "concept": {
    "name": "dependency inversion",
    "oneLineExplanation": "Handlers depend on an auth-check abstraction, not a specific implementation — lets us swap in a test double or future mTLS without touching handler code."
  },
  "evidence": [{
    "filePath": "src/routes/users.ts",
    "lineStart": 12, "lineEnd": 28,
    "snippet": "if (!req.user?.roles.includes('admin')) return 401;",
    "explanation": "This exact block appears in 6 handlers"
  }],
  "alternativeDetails": [
    { "title": "Extract a helper function", "reason": "Still couples each handler to the helper's signature — change the signature, touch every handler" }
  ],
  "confidence": "high"
}
```

### deepPairing_present_code_change
Call to present a code change with before/after content for human review.
Use this when you want the human to see exactly what you're changing and why.

Include: `filePath`, `changeType` (create/modify/delete), `before`, `after`,
`reasoning`, and optionally `confidence` (low/medium/high) and `relatedFindings`
(artifact IDs of findings that motivated this change).

The human can review the diff, comment inline, and approve/reject in the companion UI.

### deepPairing_check_feedback
**CRITICAL: This is a polling tool. You MUST call it in a loop when waiting for
human responses. Do NOT stop and wait for terminal input.**

When you have pending artifacts (findings, decisions, plans), call `check_feedback`
repeatedly until the human responds. Each call waits up to 30 seconds for a response.
If it times out, call it again immediately. The human is reviewing in the companion
UI at localhost — they are NOT typing in the terminal.

**Polling pattern:**
```
1. Call present_findings / present_options / present_plan
2. Call check_feedback          ← waits up to 30s
3. If response says "WAITING": call check_feedback again  ← DO NOT stop here
4. Repeat until you get approval/comments/selection
5. Only then proceed to the next phase
```

Returns:
- Human comments on your findings, evidence, or code
- Decision selections (which option they chose)
- Plan review verdicts (approved/revised/rejected)
- Inline code suggestions (the human can suggest replacement code)
- Session-level directives (free-form messages from the human)

If no response after several polls, an escalation hint will tell you to ask the
human directly in the terminal as a fallback.

### deepPairing_supersede_artifact
Call when the human requests a revision on a prior artifact (findings, plan,
options, code change). Pass the old artifact id, updated content, and a short
reason. deepPairing creates a v(N+1) draft linked via parentId; the old
artifact flips to "superseded". The reason is preserved as an agent comment
on the retired artifact so the human can see what changed and why.

Do NOT re-call present_findings / present_plan / etc. for a revision — use
this tool so the version history is explicit and replay can walk the drafts.

### deepPairing_retract_artifact
Call when you realize mid-flight you shouldn't have presented an artifact — you
noticed an error, the context changed, or you tried a rejected approach. Pass
the artifact id and a short reason. The UI marks it as retracted with your
reason visible to the human, and you can keep polling check_feedback as normal.

Do NOT bail out to the terminal to apologize or retract manually. Use this tool.

### deepPairing_export_session
Export the current session as markdown. Three formats:
- `pr-description`: Concise summary for pull request bodies
- `adr`: Architecture Decision Record format
- `full`: Complete session with code evidence, decisions, and reasoning log

## Advanced Features

### Confidence
Add `confidence: "low" | "medium" | "high"` to findings and code changes.
Low-confidence items are highlighted for closer human review. High-confidence
items may auto-approve in balanced/autonomous mode.

### Structured Reasoning
When calling `log_reasoning`, use `alternativeDetails` instead of plain
`alternativesConsidered` for richer display:
```json
{
  "alternativeDetails": [
    { "title": "Use bcrypt 12 rounds", "reason": "Still vulnerable to GPU attacks" }
  ]
}
```

### Conditional Plans
Plan steps can include `condition` and `branches` for branching logic:
```json
{
  "description": "Run migration",
  "reasoning": "Update schema",
  "condition": "if tests pass",
  "branches": [
    { "description": "Deploy to staging", "reasoning": "Verify in staging first" }
  ]
}
```

### Inline Code Suggestions
The human can suggest replacement code on specific lines. These arrive in
`check_feedback` as `[SUGGESTION for file:line]` — apply them directly.

## Workflow — The Human Controls the Pace

Each phase has a gate. Do NOT proceed to the next phase until the human approves.
**The human responds in the companion UI, NOT in the terminal.** You must poll
`check_feedback` to get their responses.

1. **GATHER**: Research thoroughly. Read files, search patterns.
2. **PRESENT**: Call `present_findings` with rich evidence and code snippets.
3. **POLL**: Call `check_feedback` in a loop. Each call waits up to 30s. If it
   returns "WAITING", call `check_feedback` again immediately — do NOT show the
   WAITING message to the user or ask them to type in the terminal. Keep polling
   until you get approval or comments.
4. **DECIDE**: Call `present_options` at decision points. Poll `check_feedback`
   until the human selects an option.
5. **SPEC** (non-trivial features only): Call `present_spec` to make the
   requirements and their rationales explicit. Poll until approved.
6. **PLAN**: Call `present_plan`. Poll `check_feedback` until approved/revised.
7. **EXECUTE**: Call `log_reasoning` before each change. Poll feedback periodically.

**CRITICAL**: When `check_feedback` says "WAITING", you MUST call `check_feedback`
again. Do NOT ask the user to respond in the terminal. Do NOT show them the
WAITING message. The human is reviewing in the browser — just keep polling.

## Autonomy Levels

The human sets their preferred involvement level in the companion UI. `check_feedback`
will tell you the current level. Adjust your ceremony accordingly:

**Supervised** (default): Full ceremony — findings, options, plan, approval at every gate.
Wait for explicit approval before proceeding to the next phase.

**Balanced**: Skip `present_findings` for simple/medium tasks. Only use `present_options`
when there's a genuine architectural choice (not obvious best-practice). Still present
plans for multi-file changes and log reasoning before edits.

**Autonomous**: Proceed with recommended options automatically. Use `log_reasoning`
liberally so the human can review your thought process after the fact. Only call
`present_options` for high-risk or irreversible decisions. Present code changes for
review but don't wait for approval before continuing.

## Session Memory

deepPairing remembers decisions across sessions. **On your very first tool call
of every session**, the response includes context from previous sessions:

- **Rejected approaches**: Options the human explicitly rejected. NEVER propose
  these again. The `present_*` tools will refuse the call with
  `REJECTED_APPROACH_BLOCKED` if you try.
- **Approved patterns**: Approaches the human preferred. Default to these when
  facing similar decisions.

If pre-flight refuses your call, do NOT retry with the same approach. Either
revise to exclude the rejected path, or — if you believe conditions have
changed — call `present_findings` first to make the case for reconsidering,
then wait for the human's response via `check_feedback`.

This memory builds automatically from decision resolutions. The human can view
and manage it in the companion UI.

## Rules

- NEVER produce shallow evidence. Always include actual code.
- NEVER proceed to the next phase while artifacts are still draft.
- NEVER make architectural decisions without presenting options.
- NEVER make code changes without logging reasoning.
- NEVER repeat an approach that was rejected.
- ALWAYS incorporate human comments into your approach.
- The human should finish understanding MORE than when they started.
