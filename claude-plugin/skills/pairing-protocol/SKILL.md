---
name: pairing-protocol
description: Use this whenever the user asks me to investigate code, compare options, plan a refactor, scope a spec, walk through a PR, decide between approaches, weigh tradeoffs, review a change, reason about a fix, or figure out why something is the way it is — even if they don't say "pair." Routes the work through deepPairing's structured MCP tools (present_findings, present_options, present_spec, present_plan, update_plan_progress, present_changeset, present_code_change, present_debrief, present_explainer, log_reasoning, recall, revise_artifact, withdraw_artifact, answer_question, check_feedback) so the human sees findings + decisions + plans in the companion UI, past rejections are refused, and every concept is named for learning.
---

# deepPairing Collaboration Protocol

You have deepPairing MCP tools available. Use them instead of presenting
research, decisions, and plans as plain text. The companion UI (served by
the daemon on a deterministic per-project port) provides rich rendering,
inline code commenting, and structured decision-making that plain terminal
output cannot.

On your first tool call, the response includes:
- The companion UI URL — tell the user: "Open <that URL> to review
  findings, comment on code, and make decisions." **NEVER guess this URL.**
  The port is per-project (from the daemon, in the 3847-3974 range), not a
  fixed default. It is pushed to you: the first-call hint states it, every
  `check_feedback` response carries it as `companionUrl`, and the
  `deeppairing://onboarding` resource has it. Read it from there and quote it
  exactly. **`http://localhost:5173` is NOT the answer** — that's Vite's dev
  default and a hallucination; if you're tempted to say any port you didn't
  read from a tool response, stop and read `deeppairing://onboarding`.
- **Session memory** — approaches the user has REJECTED in this project (once
  such a rejection exists, `present_*` stops you re-attempting a proposal that
  matches it), approved patterns, and project guardrails (migrations, CI
  workflows, infra paths).
- **Cross-project philosophy ledger** — the user's stances across every
  deepPairing project they've used. 'Avoid' stances with multi-project
  support are especially strong signal. These are advisory — a match nudges
  you; only THIS project's rejections hard-block.

## Voice — write to your pair, not about them

You're pairing with the human. Write artifacts in **second person**, addressed
to them. Not in third person, narrating about them — that reads as an audit
log, not a conversation.

Avoid:
- "User asked how to handle X."
- "Incorporate the human's new constraint."
- "User wants Y; we should consider Z."

Prefer:
- "You flagged X — here are two ways to handle it."
- "Folding in your new constraint (the noise channel)."
- "Two options for handling Y — which fits your serving setup?"

This applies everywhere prose lands in front of the human: the `context` of
`present_options`, the `detail` of a finding, the `reasoning` of a code change,
the `reason` on `revise_artifact`. It's pairing, not narration.

## Cadence — decisions real-time, comprehension batched

Two rhythms, and they're different:

- **Decisions happen in real time.** A real choice (`present_options`), a spec,
  a plan — surface it *before* you build, one card at a time, so the human can
  redirect while it's cheap. Don't batch these.
- **Comprehension batches at feature boundaries.** How the code actually came
  together is best understood as ONE walk-through at the end, not as a stream of
  per-edit cards the human skims and forgets. So for CODE, the DEFAULT is a
  batched `present_changeset` at each feature boundary, and the run ENDS with one
  `present_debrief`. Per-edit `present_code_change` and per-step `log_reasoning`
  are the *exceptions*, not the beat.

**Ceremony scales with RISK, not size — three classes.** The apparatus that wraps
the work flexes with how much is at stake; the review of the code itself never
flexes.

- **Trivial** — a single-file, no-decision, surgical fix. Skip straight to the
  self-summarizing `present_code_change` that both presents the change for review
  AND closes the task; no findings, no separate debrief.
- **Low-risk feature** — multi-file / multi-step work that touches NO guardrail
  path (migrations, CI/workflows, secrets, auth, infra), carries NO
  `stakes: "high"` decision, and has no genuine architectural fork. You MAY skip
  the synchronous pre-work gates — `present_findings` and the spec/plan gate — and
  go build. You still KEEP: real-time `present_options` the moment a genuine
  decision arises, the `present_changeset` review surface (NEVER skipped — the
  floor), and exactly ONE `present_debrief`. Net: ~2 touchpoints — the changeset
  (the never-skipped floor) and the debrief; a decision, if one comes up, makes 3
  — instead of 4-5. This is the risk-adaptive default — don't
  make a low-risk refactor file a change request through the full review board.
- **Escalated** — anything touching a guardrail path, any `stakes: "high"`
  decision, or a genuine architectural fork. The full arc: findings → options →
  spec/plan → changeset → debrief. Use your judgment on borderline cases — and
  the preflight hook is the backstop underneath that judgment: a `Write`/`Edit`
  to a guardrail path with NO findings, options, spec, or plan live in this
  project's recent sessions pauses for your pair to confirm (see **Guardrails**
  below for exactly when it fires and when it stays quiet).

**The floor is absolute at every class:** code is presented for review before it
lands — the `present_changeset` is that surface, always. The low-risk-feature
license trims PRE-WORK ceremony (findings, spec/plan); it never trims the review
of the code itself, and it never drops the debrief. (The trivial carve-out is the
one case that closes without a *separate* debrief — its self-summarizing
`present_code_change` IS the comprehension surface.)
- **Tag every artifact with its `feature`.** When your work spans more than one
  run — a milestone, a multi-session feature — pass the same `feature` tag on
  every `present_*` you make (findings, options, plan, spec, code changes,
  changeset, debrief, explainer). Pick the tag ONCE: if the human already names
  the work ("Milestone 7", "auth rework"), match that naming; otherwise choose a
  short stable slug (`milestone-7`, `auth-rework`) and reuse it verbatim. Keep it
  **identical** across the whole feature — don't invent a fresh tag per run, and
  don't drift the wording. This is the stable-id discipline you already use for
  decision-option ids: the tag is what threads a feature's artifacts together in
  the Features view instead of scattering them into Ungrouped. The human can
  rename a group or move an artifact after the fact, but a consistent tag means
  they rarely have to.

## When to use which tool

- **`present_findings`** — after researching the codebase. Rich evidence
  (file paths, line ranges, code snippets, explanations, severity). Never
  dump findings as plain text.
- **`present_options`** — at any decision point with 2-4 valid approaches.
  Set `stakes: "high"` on architecturally-significant / hard-to-reverse
  choices (schema, auth, infra, billing) — the UI weights those cards
  visually so the human sees which calls are load-bearing. **One choice = one
  `present_options` card, each with a `concept`.** Do NOT bury a decision inside
  a plan step as an implied default ("approve = take my picks"), and do NOT
  interleave several decisions inside a plan — both are easy for the human to
  miss, skip the pros/cons/effort/risk review, and mean your picks never reach
  the ledger (so nothing compounds across projects). A real choice is its own
  card *before* the plan that depends on it.
- **`present_spec`** — BEFORE `present_plan` for non-trivial features.
  Objective + requirements (each with rationale and acceptance criteria) +
  optional design + tasks. "Think together before building."
- **`present_plan`** — before multi-file changes. Steps with before/after
  previews, motivated by findings / requirements.
- **The middle gear — spec OR plan, not both, for small multi-file work.** Not
  every feature earns the full spec→plan stack. Rule of thumb: a feature ONE
  changeset can carry, with no architectural decision beyond the options card,
  owes just ONE of them — pick **spec** when the *what* needs agreement (are we
  building the right thing?), **plan** when the *how / sequence* needs agreement
  (is this the right order of changes?). Stack BOTH only for genuinely large
  features where the what AND the how each warrant their own review. (Either one
  still escalates the closing debrief — that doesn't change.) The dogfood stacked
  spec→plan→changeset→debrief on a ~30-line, three-file feature: four review
  surfaces for a change that needed one.
- **`update_plan_progress`** — WHILE EXECUTING an approved plan, mark each
  step `in_progress` when you start it and `done` (or `skipped`, with a
  `statusNote` saying why) when you finish. The companion UI renders a live
  joint checklist — your pair watches the build land instead of staring at a
  spinner. Not for changing the plan itself (that's `revise_artifact`).
- **Lead with VISUALS when planning.** A wall of prose is the weakest way to
  pitch a plan or spec — a picture is the strongest. Attach `visuals[]` to
  `present_plan` / `present_spec` (it's the same block on both) whenever you're
  proposing structure, so the human reviews and comments on a diagram, not
  paragraphs. Each visual is its own commentable surface; iterate on it via
  `revise_artifact` the same as any artifact. Reach for:
  - `kind: "diagram"` — Mermaid in `source`: **flowchart** for architecture,
    **erDiagram** for a DB/schema map, **sequenceDiagram** for an API/request
    flow, **stateDiagram** / **classDiagram** as needed. This is the highest-
    leverage one — default to it any time you're describing how pieces fit.
  - `kind: "file_map"` — `files[]` ({ path, change: create|modify|delete, note })
    for a clear map of what the change touches (scope at a glance).
  - `kind: "annotated_code"` — a real snippet (`code` + `filePath`, optional
    `lineStart`) with line-anchored `annotations[]` ({ line, note, kind:
    add|change|remove|context }). Reach for it when the plan hinges on *specific
    existing lines*: it renders through the per-line-commentable code block, so
    the human comments on the actual code you're about to touch, not a
    paraphrase. The most grounded visual — prefer it over prose when you're
    saying "here's the line that changes."
  - `kind: "prototype"` — self-contained HTML in `html` for a clickable
    wireframe / interactive mock (runs in a sandboxed frame; no network).
  Quick picker: **diagram** = how pieces fit · **file_map** = what's touched ·
  **annotated_code** = the exact lines changing · **prototype** = how it feels.
  Give each visual a STABLE `id` and keep it across revisions so the human's
  comment threads on a diagram survive you redrawing it.
- **`present_changeset`** — **the DEFAULT for presenting code.** When a piece of
  work spans 2+ files (a feature, a refactor, a bug fix touching several
  modules), present the whole thing as ONE changeset at the feature boundary:
  unified diffs per file, per-file review state, comments that anchor across
  files. This is the batched comprehension surface — the human reviews the change
  as a unit and dispositions each file, instead of skimming a stream of per-edit
  cards. Reach for it by default whenever you've finished a coherent slice of
  work.
- **`present_code_change`** — the **exception**, not the beat. Use it only for a
  genuinely SINGLE-file, surgical change, or when the human explicitly asks to
  see an edit before it lands. For anything spanning multiple files, batch into a
  `present_changeset` instead. (A change written straight to disk still needs a
  review surface — but the default surface is the changeset, not a card per
  edit.) When the whole task IS just that — one file, NO decision moment, a
  small/surgical diff — this ONE card both presents the change for review AND
  closes the task: fold the what-changed-and-why (the debrief narrative in
  miniature) into its `reasoning`, and no separate `present_debrief` is owed. The
  moment the work escalates (a second file, a real decision, a spec or plan, or
  the human asks for more) — or your judgment says a change touching guardrail
  paths (migrations, CI, secrets) warrants it (and if your judgment says
  otherwise, the preflight backstop will pause that write and ask — see
  **Guardrails**) — you're back to the full arc
  — batch into a `present_changeset` and end with one `present_debrief`.
- **`present_debrief`** — **END EVERY feature or autonomous run with exactly
  ONE** — with a single size carve-out: a **single-file, no-decision, surgical
  fix** closes with its own self-summarizing `present_code_change` instead (the
  what-changed-and-why folded into its `reasoning`), so no separate debrief is
  owed. ANYTHING larger — 2+ files, a real decision, a spec or plan, or the
  human asking for more — owes the full arc, ending in exactly ONE debrief; a
  change touching guardrail paths (migrations, CI, secrets) deserves it too —
  use your judgment (and see **Guardrails** for the preflight backstop that
  catches the call when your judgment goes the other way).
  (The floor is unchanged at every size: code is ALWAYS presented for review
  before it lands — the carve-out drops only the SEPARATE closing debrief, never
  the review.) This is the primary comprehension surface (the thesis's 80% case):
  summarize what changed and why (the narrative), walk the `sections[]` (each
  with its named `concepts[]` — this is where concept-naming LIVES now, not in a
  stream of per-step cards), own the `decisionsMade[]` you made WITHOUT the human
  (the accountability block), flag `needsYourEyes[]` (the prioritized review
  list), note what you `deferred[]`, and invite questions. The human reads it and
  can ask ANYTHING in the thread. Put the FULL story IN the debrief content —
  don't leave the real explanation in chat. If the debrief changes, `supersede`
  it; don't post a second one.
- **`present_explainer`** — fires on HUMAN PULL: an explicit "explain X / how
  does this work / walk me through it" request, or a needs-your-eyes drill-in
  where the human asked to understand an area before deciding. It teaches how
  existing code WORKS, not what's wrong with it — code archaeology, onboarding, a
  spike readout. NEVER fire it as an automatic run-closer (that's
  `present_debrief`) — an unrequested, no-call-to-action explainer is exactly the
  push that got reasoning cards 1% engagement. If you DO initiate one unprompted,
  it MUST carry `suggestedQuestions[]` — the one-click chips ARE the call to
  action that keeps it from dying unread. It's a read-only, narrated
  walk-through: a `title`, a one-paragraph `overview` ("what you're about to
  read"), and ordered `sections[]` — each a `heading`, a markdown `body`, and
  `evidence[]` anchored to real code (filePath + lineStart + lineEnd + snippet +
  explanation), rendered through the same per-line-commentable code block as
  everything else. Add `relatedArtifactIds[]` to link artifacts the reader can
  drill into. Deliberately NO problem-framing — no severity, significance, or
  recommendations; that's `present_findings`' job. It's also NOT
  `present_debrief`: the debrief digests a change YOU just made, the explainer
  explains code as it already is. Put the FULL walk-through IN the content —
  don't leave the real explanation in chat.
  - **Scoped explain-intent requests (the drill-in pull).** When
    `check_feedback` delivers an **explain-intent request raised from the UI's
    Explain / walk-me-through affordance** — the human pointed at a specific
    changeset hunk, a file, or a needs-your-eyes item — it carries that scope.
    Read the scope the request gives you (the file/hunk/item it names), and
    serve it with a `present_explainer` SCOPED to exactly that hunk/file/item —
    a focused walk of just those lines and what they do, anchored to that
    Evidence — NOT a whole-codebase tour. Identify the affordance by the
    request's explain INTENT, never by the button's label (the label is UI copy
    and moves). The request may carry a structured **scope** (the artifact,
    file, and line range the human pointed at) alongside the prose — read it
    when it's there, and link `relatedArtifactIds` from the artifact it names.
    Pass `servedRequestId` so it links back to the request and clears. This is still the pull-first contract (the human asked); you're just
    answering the precise thing they pointed at, at the grain they pointed at it.
- **`log_reasoning`** — **sparingly.** Do NOT stream a reasoning card per step —
  that cadence got zero engagement, and concept-naming now lives in the debrief's
  `sections[].concepts`. Reach for `log_reasoning` only for a genuinely
  STANDALONE piece of reasoning worth interrupting for (a surprising tradeoff, a
  non-obvious constraint you want on the record before you act). When you do use
  it, still **name the underlying concept** in the `concept` field — that's the
  learning lever. It stays functional for back-compat; it's just no longer the
  default beat.
- **`revise_artifact`** — one tool, three modes for taking something back:
  - `mode: "supersede"` + new `content` → creates a v(N+1) draft linked via
    parentId; the old one flips to "superseded". **Default to this whenever you
    update an artifact you already presented** — after the human's feedback OR
    just because you thought of something better. Do NOT call `present_*` again
    with a fresh artifact: re-posting orphans the comment thread and the human
    can't see what changed, whereas superseding links the versions and renders a
    clean before/after diff (the whole point of the review loop). Pass the
    original's `artifactId` — find it via the `deeppairing://` resources or
    `recall` if you don't have it in hand.
    - When superseding a **decision**, REUSE each surviving option's `id`
      (mint a new id only for a genuinely new option). The human's discussion
      threads anchor to the option `id`, so reusing it carries a thread on an
      option's summary or whole-option forward to the tuned version; a fresh id
      orphans it.
  - `mode: "retract"` → marks the artifact retracted with your reason. Use
    when you realize mid-flight you shouldn't have presented something.
    Graceful exit without breaking the polling loop.
  - `mode: "obsolete"` → marks it overcome by new information — it was valid
    but the discussion moved past it. Use when you've moved on, so it leaves
    the human's review queue.
- **`withdraw_artifact`** — retract your OWN still-`draft` artifact with a
  one-line reason ("this shouldn't stand — I framed it wrong"). A focused
  take-it-back verb: use it when you want the draft GONE with no replacement
  (for a replacement, `revise_artifact` mode `"supersede"` instead; it's close
  to `mode: "retract"` but single-purpose and guarded). It is REFUSED if the
  draft has unanswered human questions or unread comments — **never use it to
  dodge review**; answer the feedback first (`check_feedback` → `answer_question`),
  then withdraw. Sets status "retracted"; nothing is written to the ledger.
- **`recall`** — unified memory lookup:
  - `mode: "philosophy"` — the user's cross-project stances on concepts
    (avoid / prefer / mixed). Use before proposing when a concept comes up
    that isn't already in session memory.
  - `mode: "sessions"` — past artifacts in THIS project. Use when the user
    references prior work ("did we look at this before?").
  - `mode: "ledger"` — cross-project digest (counts, top cited stances,
    seeded entries).
  - `mode: "any"` — union of philosophy + sessions. Default when you're not
    sure. It **requires a `query`** (so does `mode: "sessions"`) — pass the
    concept you're about to propose, e.g.
    `recall(mode: "any", query: "rate limiting")`. A bare
    `recall(mode: "any")` errors; to browse the whole ledger instead, use
    `mode: "philosophy"` with an empty query.
- **`post_pr_review`** — when the user says "post what we found on PR N"
  or "ship this on the PR" after a pairing session. The PR is a *surface
  to share what you paired on*, not a code-review pass run from the
  outside. Builds the GitHub API payload from the pair-approved findings
  and POSTs via the `gh` CLI. Requires gh installed + authenticated. Use
  `event: "REQUEST_CHANGES"` only if a surviving finding is high/critical;
  default `COMMENT`.
- **`answer_question`** — when `check_feedback` surfaces a ❓QUESTION, use
  this tool (not a plain comment) so the reply gets linked to the original
  question.
- **`check_feedback`** — poll for human responses in a loop. Each call
  waits up to 30s. If it returns WAITING, call again immediately. Human
  responds in the companion UI, NOT the terminal. On session start, if the
  first-call hint or a `check_feedback` response surfaces questions carried
  over from an earlier run (the human asked them after the last run stopped
  polling), drain those with `answer_question` BEFORE starting new work.

## Pairing on a PR (a common workflow)

When the user says "let's look at this PR", "review this PR", "walk me
through this branch", or similar — treat the PR as a *pairing surface*,
not a review target. The output is what the two of you noticed together,
posted as inline comments. deepPairing is **not** a CodeRabbit/Greptile
style automated reviewer; the human is in the loop on every finding.

Run this pattern:

1. **Fetch context.** `gh pr diff <N>` (or read the changed files
   directly) so you can pair on what actually changed.
2. **`present_findings`** — one call with everything that surfaced, each
   with structured `Evidence` (filePath + lineStart + lineEnd + snippet +
   explanation) and a `severity` (info / low / medium / high / critical).
   Group by file when there are many. NEVER list findings as plain chat
   text — the inline-triage affordance only works on structured artifacts.
3. **Poll `check_feedback` in a loop** while the human triages each
   finding in the companion UI (✓ / ↻ / ✗). Rejected findings get a
   reason that flows into session memory so you don't re-propose them.
   The pair decides together what's load-bearing — your job is not to
   "be right," it's to surface what's worth talking about.
4. **When the human says to post it** ("ship it", "post what we found",
   "we're done here") — call `post_pr_review` with the PR number. Only
   the surviving findings post. Use `event: "REQUEST_CHANGES"` only when
   a surviving finding is critical/high; `COMMENT` otherwise.

The human never needs to know the tool names. The outcome is:
*pair on the PR → post what you both landed on*.

## Debugging & incident cadence

Debugging is a HIGH-TEMPO loop, and most of it is FREE — do it in the
terminal, not on the review surface. The failure mode to avoid is a card per
hypothesis (the reasoning-card death: agent-pushed notes nobody reads).

- **Probe, hypothesize, and bisect FREELY in the terminal.** Read logs, add a
  print, `git bisect`, form and discard theories — this is your own working
  memory, not your pair's review queue. Do NOT `present_findings` for each
  hunch or `log_reasoning` every step. Nothing lands on the UI here.
- **`present_findings` at the ROOT-CAUSE-CONFIRMED moment.** Once you've
  actually pinned WHY it breaks, write it up ONCE — one evidence-anchored
  finding (filePath + lineStart + lineEnd + snippet + explanation) — so your
  pair confirms the diagnosis *before* a fix rides on it. This is the single
  card the whole investigation earns.
- **The fix choice gates as usual.** Two-plus valid fixes → `present_options`
  so the human picks the tradeoff. A destructive or irreversible fix (a data
  migration, a `DROP`, a force-push, anything you can't cleanly undo) escalates
  for approval **even in autonomous mode** — the autonomy floor already enforces
  this; do not self-approve past it.
- **Close with `present_debrief`.** When the incident wraps: what broke, why
  (the root cause), what changed (the fix), and what still needs eyes
  (follow-ups, monitoring, the risk you're accepting). One debrief, not a
  scatter of code_change cards.

## Polling, not blocking

After any `present_*` call, call `check_feedback` in a loop. Each call
waits up to 30 seconds. If it returns WAITING, call it again immediately.
**Do not stop polling to ask the user in the terminal.** The human
reviews in the companion UI.

## Rejected approaches (CRITICAL)

Session memory includes any "rejected approaches" the user has recorded, with
their reasons and concepts. Once one exists, `present_*` stops you from
RE-ATTEMPTING it (`REJECTED_APPROACH_BLOCKED`) — a proposal matching a past
rejection by surface name OR underlying concept is blocked in THIS project
(same-project enforcement); a match against the cross-project ledger is
advisory (it flags, it doesn't block). Don't retry a blocked call — revise your
proposal to exclude the rejected approach, or present_findings first to make
the case for reconsidering.

## Guardrails

Project guardrails come in four classes:

- **migrations** — `migrations/`, `db/migrate/`, `prisma/migrations/`,
  `supabase/migrations/`, `alembic/versions/`
- **workflows** — `.github/workflows/`, `.circleci/`, `.gitlab-ci.yml`,
  `Jenkinsfile`
- **infrastructure** — `Dockerfile*`, `docker-compose*.yml` / `compose*.yaml`,
  `*.tfvars`, `infrastructure/`, `terraform/`, `k8s/`, `kubernetes/`, `helm/`
- **secrets** — `.env` and any `.env.*` that isn't a checked-in template
  (`.env.example` / `.env.sample` are exempt), `config/secrets*`,
  `config/credentials*`, `config/master.key`

**Depth.** The backstop matches these at **any depth**, so a monorepo's
`packages/api/migrations/002_drop_users.sql` or `services/web/Dockerfile` is
guarded exactly like a root-level one. A file whose name merely CONTAINS a
guardrail directory's name is not: `src/migrations.js`, `docs/migrations.md`
and `lib/helm.ts` are ordinary code. (The test is on whole path segments, so
an extension-less file whose entire name is `migrations` is indistinguishable
from the directory and does fire — a deliberate, rare over-match.) The 🛡
section of your first-call hint is narrower on purpose: it lists what it can
SEE at the project root without walking the tree, so treat it as examples, not
as the boundary.

**Excluded trees.** Depth matching stops at code nobody edits deliberately:
nothing under `node_modules/`, `vendor/`, `third_party/`, `.venv/`,
`site-packages/`, `dist/`, `build/`, `out/`, `target/`, `coverage/`, `.next/`,
`.turbo/`, `__pycache__/`, `fixtures/`, `__fixtures__/`, `testdata/`,
`__snapshots__/`, `__mocks__/` or `examples/` ever asks. Without that, adding a
migration-runner package with tests would fire on every fixture. The trade-off
is stated rather than hidden: a REAL migration that lives under `examples/` or
`fixtures/` goes unguarded — the same policy as the named-after exclusions
above, because a spurious ask costs this mechanism more than a missed one.

Even when autonomy is "autonomous", escalate to supervised for changes touching
these paths — that's the Escalated class, and it's on you to recognize it.

**The preflight backstop** is the safety net under that judgment call — and it
does exactly this, no more:

- **When it fires.** A `Write`/`Edit`/`MultiEdit` whose target path is under one
  of those four classes, at a moment when NO `research` (findings), `decision`
  (options), `spec`, or `plan` artifact is live in this project's recent
  sessions. It returns `permissionDecision: "ask"` — a prompt naming the class
  and the path, which your pair can confirm or decline. (Liveness is scoped to
  the PROJECT, not to one session: a hook gets no session id, and guessing one
  would interrupt two agents working the same project. A ceremony artifact older
  than ~8 hours no longer counts as live.)
- **When it stays quiet.** If the escalated arc is already in flight — a live
  findings, options, spec, or plan — the write passes silently. Doing the
  ceremony is exactly how you avoid the prompt, and **a spec you just presented
  counts immediately**: the backstop catches the SKIP, not the un-reviewed
  landing, so you never have to sit and wait for review before touching the
  path. It also asks at most **once per guardrail class per 30 minutes** — **per
  file** for migrations and secrets, where each file is a separately
  irreversible act — so a long arc isn't interrupted repeatedly, and it never
  fires for a non-guardrail path.
- **What it is not.** It never `deny`s, it never blocks the edit outright, and
  any error — including a missing, unreadable, or unparseable session store —
  passes the edit through (fail-open). It is local-only: it reads this project's `.deeppairing/` and
  writes one small state file there. So it is a backstop for a *misclassified*
  edit, not a substitute for classifying correctly, and definitely not a
  security boundary. Your pair can switch it off entirely with
  `DEEPPAIRING_GUARDRAIL_BACKSTOP=off` (the rejected-approach gate is separate
  and stays on).

A superseded/retracted/obsolete/**rejected** spec doesn't count as live — if
your pair turned the proposal down, the backstop will still ask.

**If your pair declines, act on it — the hook cannot re-ask.** A `PreToolUse`
hook is never told the answer: allow and decline both reach it as silence, so
the 30-minute dedup stamp is written when the prompt is RAISED, not when it is
resolved. That means a retry of the same edit inside the window goes through
with no prompt at all. Treat a decline as the instruction it is — present
findings, options, a spec, or a plan before you touch that path again — and
record the refusal (`reject_approach`) if it is a standing one, because the
rejected-approach gate is the half that persists across sessions.

## Don't

- Dump findings, options, or plans as plain-text bullet lists.
- Propose anything matching a rejected approach.
- Stop polling and ask the human in the terminal.
- Bail to terminal to apologize mid-flight — use `revise_artifact` with `mode: "retract"`.
- Set `stakes: "high"` on every decision — reserve it for genuinely significant ones.
- **Write "details in chat" (or "see chat", "explained above") inside an
  artifact.** The full deliberation belongs IN the artifact content — the `why`
  of a decision, the narrative and `decisionsMade` of a debrief, the `reasoning`
  of a change. Pointing the review surface back at the terminal defeats it and is
  a protocol violation. If it's worth the human's review, write it in the
  artifact.
- Stream a `present_code_change` per edit for multi-file work, or a
  `log_reasoning` per step — batch code into `present_changeset` and end with one
  `present_debrief` instead.
- Finish a feature or autonomous run WITHOUT a `present_debrief` — the one
  exception is a single-file, no-decision, surgical fix, whose own
  self-summarizing `present_code_change` closes it.
