# Delegate-first pairing — quiet runs, understanding packets (proposal)

> **Status: PROPOSAL, revision 1. Docs only, no code.** Written for Mitch's
> product decision, Fable's UX review and Astra's architecture review.
> Source audited at `main` 08e05772 (v0.1.64). Paths are relative to
> `packages/mcp-server/` unless they start with `packages/` or `claude-plugin/`.
> Earlier verdicts this document honours or revisits are named inline as
> *round N*. They live in the review history, not in this repo.

## 0. The ask, in one paragraph

Mitch's direction, verbatim: "the light pairing described is probably generally
the default of most software engineering today, so making it feel stronger and
realer/more understood by the user while less distracting would be the goal."
The flow he described: you write a detailed issue, you and the agent settle a
plan for it, the implementation runs in the background, and you get a generated
artifact plus an explanation back. deepPairing already has every piece of that
flow. What it does not have is the **shape**: the pieces arrive as six or seven
separate review surfaces, the middle of the run is either silent or noisy, and
the end-of-run story is split between a changeset you must approve and a debrief
you may skim. This proposal gives the flow three beats and no more. **An intent
check** up front, one approval. **A quiet run** that interrupts you only for a
consequential fork or a gate block, with progress you can glance at and never
have to dismiss. **An understanding packet** at the end that tells you where
the change sits in the system, why it went that way, what to look at first,
what the agent is not sure of, and what proves it works. The diff stays one
click away, and "walk me through it" stays a pull. Nothing new is invented
where an existing artifact, field or surface will do.

**On "never chase review-after."** Round 10 said that, and it still holds in
the sense it was meant: the review of code *after* it lands must never become a
substitute for the decisions the human owns *before* it is written. The
delegate-first shape does not relax that. The architectural fork, the
high-stakes call and the gate block still interrupt in real time. What moves is
the **ceremony around them**: the findings-spec-plan stack collapses into one
intent check, and the comprehension that used to be scattered across
per-edit cards collapses into one packet. Depth is not removed. It is moved to
the two moments you are guaranteed to be looking.

## 1. What exists today (audited)

Each stage of Mitch's flow, with the pieces that already serve it and the gap.

| Stage | Exists | Where | Gap or disconnection |
|---|---|---|---|
| The request | Free-text request composer with three intents (`explain`, `plan`, `status`), served through `check_feedback` | `packages/shared/src/schemas/request.ts`, `web/src/components/RequestComposerBanner.tsx` | No intent means "do this". A delegated task starts in the terminal and the UI never sees the brief. |
| Restating intent | `present_spec`: `objective`, `context`, `requirements[]` each with rationale and acceptance criteria, `openQuestions[]`, `tasks[]`, `visuals[]`. Terminal quick-approve via elicitation. | `src/mcp/tools/present-spec.ts`, `content-types.ts:313`, `web/src/components/artifacts/SpecArtifact.tsx` | Nothing says **what the agent will decide alone** versus ask about, or which **risk class** it placed the work in. The SKILL's middle gear says "spec or plan, not both", so delegated work often gets a plan (the how) when the human only needs the what and the boundaries. |
| Risk classing | Three classes: trivial, low-risk feature, escalated. Autonomy dial `supervised`/`balanced`/`autonomous`. Guardrail backstop asks once per class per 30 min when no ceremony artifact is live. | `claude-plugin/skills/pairing-protocol/SKILL.md` Cadence, `src/mcp/autonomy-policy.ts`, `src/guardrail-rules.ts`, `src/cli/preflight-hook-core.ts` | The class is chosen silently by the agent. You never see it, so you cannot correct it before the run. |
| Real-time forks | `present_options` with `stakes`, stable option ids, concepts. The decision card is the alive surface (round 15). | `src/mcp/tools/present-options.ts`, `web/src/components/DecisionCard.tsx` | Fine. The gap is on the other side: there is no stated threshold for what *does not* earn a card during a run, so agents either over-ask or fold a real fork into a plan step. |
| Gate blocks | `REJECTED_APPROACH_BLOCKED` on `present_*`, PreToolUse `ask` on direct edits, HELD record in the Next-up bar, hero toast | `src/mcp/preflight-validator.ts`, `src/mcp/tool-helpers.ts`, `web/src/components/NextUpBar.tsx` state F | Works. A block during a background run surfaces as a toast plus a bar record, which is the right weight. |
| Ambient progress | `update_plan_progress` drives the plan strip and "Executing plan — step x of y" in the TurnIndicator. `log_reasoning` feeds the narration line. Next-up bar state D: "WAITING ON CLAUDE · Working · 2m — <narration>". | `src/mcp/tools/update-plan-progress.ts`, `web/src/components/artifacts/PlanArtifact.tsx:436-484`, `TurnIndicator.tsx:88-103`, `NextUpBar.tsx` | Progress needs a **plan artifact**. Spec `tasks[]` have no status. So a delegate run with an intent check and no plan has no progress strip, and agents fall back to `log_reasoning` cards, which round 14 measured at near-zero engagement. |
| Notifications | OS notification per draft (5s throttle, decisions exempt), tab-title badge, toasts for failures, blocks, "Added to your Ledger", "answered" | `web/src/stores/connection.ts:294`, `web/src/stores/toast.ts` | No notion of "a run is in progress, hold everything but Decide and System". The attention model (#430) has the lanes to express it. |
| The diff | `present_changeset`: per-file hunks, `summary`, `risks[]`, `visuals[]`, per-file review state, approve countdown, Walk-me-through per hunk and file | `src/mcp/tools/present-changeset.ts`, `web/src/components/artifacts/ChangesetArtifact.tsx`, `web/src/components/WalkMeThrough.tsx` | `summary` is rendered now (`ChangesetArtifact.tsx:1126`, fixing round 14). The changeset is a **blocking Decide item**, so when it arrives with a debrief you face two drafts and the bar routes you to the diff first, oldest-first. The diff is the wrong front door for understanding. |
| The explanation | `present_debrief`: `summary`, `sections[]` with concepts, evidence and `changesetRef`, `decisionsMade[]` with `alternative`, `needsYourEyes[]` with `artifactRef`, `deferred[]`, `openQuestions[]`, `visuals[]`. Stop hook nags when code was presented and no debrief exists. | `src/mcp/tools/present-debrief.ts`, `content-types.ts:588-660`, `web/src/components/artifacts/DebriefArtifact.tsx`, `src/hooks/stop-hook.ts` | Four gaps. **WHERE**: `file_map` is a flat list and a `diagram` is free-form, so nothing connects the changed files to their neighbours (round 15's weakest axis). **Hotspots**: `needsYourEyes` has no rank, no risk and no file:line evidence, and sits below the walk. **Unknowns**: the explainer has `unknowns[]`, the debrief does not. **Proof**: nothing carries tests run or before/after. |
| Walk me through | `WalkMeThroughButton` on hunks, files and needs-your-eyes items emits a scoped `explain` request. The agent answers with a scoped `present_explainer`. | `web/src/components/WalkMeThrough.tsx`, `request.ts` `RequestScope` | No packet-level target. You can ask about a hunk but not "walk me through this change". |
| Grouping | `feature` tag on every `present_*` groups artifacts in the Features view | `packages/shared/src/schemas/artifact.ts:241`, `web/src/components/FeaturesModal.tsx` | Fine. The packet should ride the same tag. |
| Measurement | `metrics.json` counts (`artifact_created`, `comment_added`, `question_asked`, blocks), `computeEngagementMetrics` with review latency by type | `src/store/metrics-store.ts`, `src/store/engagement-metrics.ts` | Nothing ties a comment or a `needs_changes` to the packet that prompted it. No comprehension signal at all. |

Three facts drive the design:

- **Every piece exists.** This is a composition and guidance problem, not a
  build problem. Round 14's verdict was "built the depth, didn't turn it on".
  The risk here is the same, so §4 and §7 are about the pull, not the parts.
- **The debrief is the right front door and the changeset is the right act.**
  The attention model has to treat them as one thing.
- **Progress today is coupled to a plan.** A delegate run should not need a
  plan to show you a checklist.

## 2. The flow

### 2a. The intent check: one card, one approval

You hand over a task, usually an issue or a paragraph. Before touching a file
the agent posts **one** `present_spec` shaped as a brief, and waits for one
approval. The brief answers five questions in order:

1. **What I understood you to want.** The `objective`, in one sentence, in
   your words where possible.
2. **Done when.** The `requirements[]`, each with an acceptance criterion you
   could check yourself. These are the definition of done, and the packet
   reports against them one by one (§2c).
3. **I'll decide these alone.** A short list of calls the agent expects to
   make without asking: naming, file placement, test shape, which helper to
   reuse. You can strike any line and it becomes an ask.
4. **I'll ask you about these.** The forks it already sees that meet the
   threshold in §2b, so you know what might interrupt you.
5. **Risk class and why.** `trivial`, `low-risk` or `escalated`, with the one
   fact that put it there ("touches `migrations/`", "no guardrail path, no
   schema change"). You can change the class. Changing it changes the
   interruption threshold for the run.

Items 3 to 5 are new optional fields on the spec (§3). Until they exist the
dogfood preset carries them as headed lines in `context` (§7).

**Why the spec and not the plan.** The spec is already the "are we building
the right thing" surface, it already quick-approves from the terminal when the
client supports elicitation, and a live spec already keeps the guardrail
backstop quiet (`preflight-hook-core.ts`, "a spec you just presented counts
immediately"). The intent check therefore buys the quiet run on the existing
mechanism. The plan stays available for escalated work where the order of
changes needs your agreement, which is the middle-gear rule unchanged.

**Size by class.** Trivial work gets the brief as the terminal elicitation
text only, three lines, Accept to go. Low-risk and escalated work get the card.
Nothing else is posted before the run. No findings, no plan, no options unless
one is already visible, in which case it is posted alongside the brief so you
answer both in one sitting.

### 2b. The quiet run

Once the brief is approved the agent builds. Three things may interrupt you.
Nothing else may.

| Interrupt | Surface | Threshold |
|---|---|---|
| A **consequential fork** | `present_options`, as today | Trivial and low-risk runs: a fork is consequential only if it is architectural (it shapes the code written around it) or hard to reverse. This is the existing `autonomous` floor in `autonomy-policy.ts`, applied regardless of the dial. Escalated runs: additionally any `stakes: "medium"` or higher choice the brief did not list under "decide alone". |
| A **gate block** the agent cannot route around | HELD record in the bar plus the hero toast, as today. If the agent cannot find a non-rejected approach that still meets the definition of done, it posts one `present_options` with the blocked road named as an option it cannot take. | Always. A block is your taste speaking. |
| **Done is unreachable** | One `present_options` naming the scope fork ("REQ-3 conflicts with REQ-1 as written, which gives?") | Always. The agent never quietly redefines done. |

Everything else is **batched into the packet**: calls it made alone go to
`decisionsMade[]` with the alternative it weighed, things it could not verify
go to `unknowns[]`, things it skipped go to `deferred[]`.

**Ambient progress, no toasts.** You should be able to glance at the companion
and know the run is alive and roughly where it is, without anything asking to
be dismissed:

- The brief's `tasks[]` become a live checklist, exactly as plan steps do
  today. `update_plan_progress` already takes an `artifactId`. It learns to
  update a spec's tasks (§3). The TurnIndicator line "Executing plan — step x
  of y" reads "Working on <brief title> — task x of y".
- The Next-up bar stays in state D, "◌ WAITING ON CLAUDE · Working · 4m —
  <task>", from the attention model. The narration comes from the current
  task's description, not from `log_reasoning` cards, which stay the
  exception.
- **No OS notification, no toast and no tab-title change for progress.**
  During a run the only events that notify are a Decide item (a fork, the
  packet itself) and a System failure. This is a rule the attention model can
  enforce: while a `delegation` spec is approved and its tasks are not all
  done, `notifyDraft` fires only for `decision` and for the packet.

**Fit with the #430 attention hierarchy.** Nothing here adds a lane. The run
lives in **Waiting**. A fork is **Decide**. A block is **System** then HELD. The
packet is **Decide**. The one change to the model is the packet grouping in
§2c, which is a derivation inside `computeAttention`, not a new surface.
Principle 4 holds: nothing pending is hidden, nothing is auto-approved, no
failure is suppressed.

### 2c. The understanding packet

The run ends with **one** `present_debrief` and **one** `present_changeset`,
posted together, sharing the `feature` tag, the debrief's `changesetRef`
pointing at the changeset. The attention model treats the pair as **one Decide
item** whose front door is the debrief. The bar reads:

```
│ ▲ PACKET  Rate-limit the export endpoint · 3 hotspots · read, then land the diff   [Open ⏎]  Read 1 ⌄ │
```

Opening it shows the debrief, laid out as a packet. Top to bottom:

1. **What changed, in one breath.** `summary`, at most three sentences, plus a
   **done-when report**: each requirement from the brief with met, partly met
   or not met and a one-line reason. The brief and the packet are the same
   list, so you check the agent against its own promise.
2. **Where it sits.** The WHERE map: a `file_map` visual with edges (§3). Changed
   files are highlighted, unchanged neighbours (callers, the route that mounts
   it, the test that covers it) are drawn as context, each node clicks through
   to that file in the changeset. Capped at twelve nodes. This is the connected
   map round 15 asked for, replacing narration.
3. **Look here first.** Two or three `needsYourEyes[]` items, risk-ranked,
   each with `evidence[]` (file, lines, snippet) and its Walk-me-through button.
   These are the hotspots. The cap is part of the design: a fourth item means
   the agent has not ranked.
4. **Why it went this way.** `decisionsMade[]`, each with the `alternative`
   not taken. Decisions you were asked about during the run are linked, not
   repeated. This is the roads-not-taken block and it stays short.
5. **Not sure about.** `unknowns[]`, each with a one-click Ask, the explainer's
   existing pattern.
6. **Proof.** Which tests ran and passed, what was not run and why, and a
   before/after where one exists (a failing command now passing, a screenshot
   pair, a timing). Rendered as a checklist, not prose.
7. **Deferred** and **open questions**, as today.

Two controls sit in the packet header, and neither is new:

- **Open the diff.** Routes to the changeset, the floor. Approving the
  changeset is what lands the work. The debrief's own verdict stays what it is
  today, a read receipt with an optional comment.
- **Walk me through it.** A packet-level `WalkMeThroughButton` whose target is
  the debrief. It emits the same scoped `explain` request and the agent answers
  with a `present_explainer` ordered by the WHERE map. Pull only, never
  automatic, so the explainer stays out of the graveyard by never being pushed.

**What is deliberately not in the packet.** The full diff above the fold. A
per-file narration. A quiz. Anything the brief did not promise.

## 3. New versus reused

Prefer composition. Every schema addition below is optional, so an older
session loads unchanged and a tool call without the field is byte-identical to
today.

| Need | Reuse | New (all optional) |
|---|---|---|
| Intent check | `present_spec` (`objective`, `requirements[]`, `tasks[]`, `context`) | `SpecContent.delegation?: { decideAlone: string[], willAsk: string[], risk: "trivial" \| "low-risk" \| "escalated", riskWhy: string }` |
| Done-when report | Spec `requirements[].id` | `DebriefContent.doneWhen?: Array<{ requirementId: string, status: "met" \| "partial" \| "not-met", note?: string }>` |
| Ambient progress | `update_plan_progress`, plan strip, TurnIndicator, Next-up state D | `SpecTask.status?` and `SpecTask.statusNote?` (mirror `PlanStep`). `update_plan_progress` accepts a spec id and updates `tasks[]`. `FileStore.updatePlanProgress` branches on type. |
| WHERE map | `PlanVisualSchema` kind `file_map`, `ArtifactVisuals`, region comments | `PlanVisual.edges?: Array<{ from: string, to: string, label?: string }>` where `from`/`to` are paths in `files[]`. A `file_map` with edges renders as a graph (Mermaid under the hood, changed nodes styled) with click-to-file when the artifact or its `changesetRef` has that path. Without edges it renders as today. |
| Hotspots | `DebriefReviewItem` (`what`, `why`, `artifactRef`), `WalkMeThroughButton` | `DebriefReviewItem.risk?: "low" \| "medium" \| "high"` and `evidence?: Evidence[]`. Renderer sorts by risk and caps the "Look here first" block at three, with the rest under a disclosure. |
| Unknowns | Explainer `unknowns[]` render and Ask chip | `DebriefContent.unknowns?: string[]` |
| Proof | Nothing | `DebriefContent.proof?: { checks: Array<{ label: string, command?: string, outcome: "pass" \| "fail" \| "not-run", detail?: string }>, before?: string, after?: string }` |
| Packet grouping | `computeAttention`, `changesetRef`, `feature` | A derivation: a draft debrief whose `changesetRef` is a draft changeset forms a `packet` item with the debrief as `next`. No schema change. |
| Walk the packet | `WalkTarget`, request pipe | `{ kind: "packet", artifactId }` added to the `WalkTarget` union. |
| Quiet notifications | `notifyDraft`, attention lanes | A selector `runInProgress(state)` true while an approved `delegation` spec has unfinished tasks. `notifyDraft` consults it. |
| Comprehension prompt (§6) | Debrief verdict footer | `comprehensionPrompt?: boolean` preference, default off. On the debrief's "Got it", one optional 1-to-4 rating stored on the status change. |

Not new, and said plainly: no new artifact type, no new lane, no new approve
path, no new tool. The one tool whose contract widens is
`update_plan_progress`, and only by accepting a second artifact type.

## 4. Agent protocol and SKILL changes

Round 14's failure mode was fields the agent never reached for. The pull has
to come from four directions at once, because any one of them alone has been
shown to fail.

**1. A human-initiated entry: `/deeppairing:delegate`.** A new command in
`claude-plugin/commands/delegate.md`, shaped like `review-pr.md`, that takes an
issue number, URL or free text and carries the three beats as numbered moves
the agent is told not to skip. The human choosing the preset is what the
explainer never had. Its text is the dogfood protocol in §7, so it ships before
any UI.

**2. The SKILL's Cadence section gets a fourth paragraph, "Delegated
work".** It names the shape when the human hands over a task rather than
asking a question: intent check, quiet run, packet. It restates the threshold
table from §2b and the packet's seven blocks from §2c with their caps. It also
says what the run must not do: no `log_reasoning` per step, no
`present_code_change` per edit, no explainer unless pulled, no second debrief.
The existing low-risk class is kept and pointed at this paragraph, since
delegated work is its commonest instance.

**3. The first-call hint leads with it when the autonomy dial is not
`supervised`.** `autonomyHintFor` in `src/mcp/first-call-hint.ts` already
carries a per-level block. `balanced` and `autonomous` gain one line: "For a
delegated task, open with ONE present_spec brief (objective, done-when,
decide-alone, will-ask, risk class), build quietly, end with ONE packet
(present_debrief with doneWhen, hotspots, unknowns, proof, plus the
changeset)." `supervised` stays byte-identical, per the existing invariant.

**4. Server-side nudges on the result text, the STYLE-block pattern.**
`present_debrief` already appends warnings for dangling refs and style. Two
more, warn-only, fire only when a `delegation` spec is live in the session:
`needsYourEyes` missing or longer than three, and `proof` or `doneWhen` absent.
`check_feedback`'s per-poll reminder line, which already carries the autonomy
policy, gains "delegate run: x of y tasks done, packet owed" while a run is in
progress. The Stop hook's existing "owes debrief" nag is unchanged and already
covers the forgotten packet.

Guidance words that matter, written to the agent in the SKILL:

- "The brief is the only pre-work card. If you want to post findings first,
  fold the one finding that matters into the brief's `context`."
- "Interrupt for a fork only if you would be embarrassed to have decided it
  alone. If you are unsure, it goes in `decisionsMade` with the alternative,
  and the packet is where your pair tells you they wanted to be asked."
- "Three hotspots, risk-ranked, each with lines. A fourth means you have not
  ranked."
- "Proof is what you ran, not what you believe. `not-run` is a valid outcome.
  Say why."

## 5. Distraction budget

Concrete limits, per delegated run. The agent is told these numbers, the
server warns when a packet exceeds them, and §6 measures them.

| Moment | Budget |
|---|---|
| Intent check | Exactly 1 card (or 1 terminal prompt for trivial). Posted together with any fork already visible, so one sitting. |
| Forks during a low-risk run | 0 expected. At most 1 before the agent should stop and re-brief: a second fork means the class was wrong. |
| Forks during an escalated run | No fixed cap, but each must carry `stakes` and a `concept`, and none may be `low`. Low-stakes choices go to `decisionsMade`. |
| Gate blocks | Not counted. A block is your prior decision arriving, and it costs one glance at the bar. A block the agent cannot route around costs 1 card. |
| Guardrail backstop prompts | 0 while the brief is live and approved. If one fires, the run has strayed outside the brief and the agent re-briefs. |
| OS notifications | 1 for the brief, 1 per fork, 1 for the packet. 0 for progress, 0 for blocks that resolved themselves. |
| Toasts | Failures and the block hero only, as today. |
| The packet | Summary at most 3 sentences. WHERE map at most 12 nodes. Hotspots at most 3 above the fold. `decisionsMade` at most 5 shown, rest disclosed. `unknowns` at most 5. Proof as a checklist, no narrative. |
| Explainers | 0 unless you pull one. |
| Debriefs | Exactly 1. A change is a supersede, never a second card. |

A low-risk delegated run therefore costs you **two sittings**: the brief and
the packet. That is the same count the existing low-risk class promised
("~2 touchpoints"), with the content of each sitting made deliberate.

## 6. Measurement

All local, all in `metrics.json` or derivable from the session store. No
telemetry leaves the machine.

- **Time to a confident merge.** From packet created to changeset approved,
  per run, with the time you spent with the packet open subtracted from the
  time the tab was hidden. `computeEngagementMetrics` already has review
  latency by type. Add a `packet` type that pairs the two artifacts. Report the
  median and the spread, not a single number.
- **Catches from the packet.** A `needs_changes` on the changeset, a comment
  on a hotspot, an Ask on an unknown or a strike on a `decisionsMade` line,
  counted per packet and attributed to the block that prompted it. The honest
  success signal is catches that came **from reading the packet rather than
  the diff**: a comment anchored to `debrief:needs-your-eyes:<i>` or to a WHERE
  map region before the changeset was opened.
- **Questions raised.** `question_asked` events anchored to the packet, split
  by block. Unknowns that get asked about are the design working. Unknowns
  that never do are noise to trim.
- **Rubber-stamp signal.** A changeset approved within 20 seconds of the packet
  opening, with no scroll past the summary and no hotspot opened. Counted,
  never blocked, shown to you in SessionMetrics as "approved unread".
- **Self-rated comprehension, opt-in.** With `comprehensionPrompt` on, the
  debrief's "Got it" shows one line: "How well could you explain this change
  to a colleague? 1 not at all · 2 roughly · 3 well · 4 I could have written
  it." Optional second line: "What would you check first?" Stored on the
  status change. Default off, offered once in the first packet's footer with a
  "don't ask again". This is opt-in because it is an opinionated behaviour,
  per the standing rule, and because a forced rating teaches people to click
  4.

What this cannot measure, said plainly: whether you actually understood. The
rating is self-report and the catches are a floor. The pilot protocol in
`docs/pilot-protocol.md` is where that question goes if it ever goes
anywhere.

## 7. Dogfood protocol, before any UI

Build nothing in the UI until the shape has been run on real work with the
tools that exist. The preset below uses only current fields. Where a §3 field
is missing, the content goes in prose with a fixed heading so it can be lifted
into the field later without rewriting.

**The preset: `/deeppairing:delegate <issue | text>`** (`claude-plugin/commands/delegate.md`)

1. **Read** the issue (`gh issue view N`) and the code it touches. Call
   `recall` with the two or three concepts you are about to lean on.
2. **Brief.** One `present_spec`. `objective` in one sentence. `requirements[]`
   with acceptance criteria you could check with a command. `context` with
   four headed lines: `Decide alone:`, `Will ask:`, `Risk class:`, `Why:`.
   `tasks[]` as the steps you intend. Attach a `file_map` of what you expect
   to touch. Then poll `check_feedback` and wait for approval. Do nothing else
   first.
3. **Run.** Build. Post `present_options` only for a fork that is architectural
   or hard to reverse, or when done is unreachable as written. Post nothing
   else. Since spec tasks have no status yet, post one `log_reasoning` per
   **completed task** with `action` set to the task description. This is the
   one place the preset tolerates reasoning cards, and §3 removes the need.
4. **Packet.** `present_changeset` with `summary`, `risks[]` and a `diagram`
   visual whose nodes are the changed files and their neighbours (the WHERE
   map by hand). Then `present_debrief` with the same `feature` tag,
   `changesetRef` on the first section, `summary` at most three sentences, a
   section headed `Done when` listing each requirement as met, partial or not
   met, `needsYourEyes[]` capped at three with `why` naming the file and
   lines, `decisionsMade[]` with alternatives, a section headed `Not sure
   about`, a section headed `Proof` listing commands and outcomes, and
   `deferred[]`.
5. **Wait.** Poll. Answer questions. Serve a Walk-me-through with a scoped
   explainer. Never post a second debrief, supersede.

**Four real issues, one per class plus one repeat.** Pick from this repo's
open or recently closed work so the brief can be checked against a known
answer: one trivial (a one-file fix), two low-risk (a multi-file feature with
no guardrail path, for instance the §3 schema fields themselves), one
escalated (anything under `.github/workflows/` or touching the hook scripts).
Run each under the preset with the autonomy dial at `balanced`.

**Record per run,** in the debrief's `openQuestions` so it lives with the
work: interruptions you got (count and whether each was warranted), minutes
from packet to approve, catches and where they came from (packet block or
diff), whether you read the diff at all, and your 1-to-4 rating typed by hand.

**Gate to proceed to §8 slices 2 onward:** across the four runs, at least one
catch came from the packet rather than the diff, you rated 3 or 4 on three of
four, and no run needed more than one unplanned interruption. If the gate
fails, the fix is in §4 guidance or in the shape, not in UI.

## 8. Phased slices, each independently reviewable

| Slice | Contents | Depends on | Visible to users |
|---|---|---|---|
| **S0** | This document. `claude-plugin/commands/delegate.md` preset. SKILL Cadence paragraph "Delegated work" pointing at the preset. | — | Yes (guidance only). Runs the §7 dogfood. |
| **S1** | Schema fields from §3 on spec and debrief (`delegation`, `doneWhen`, `unknowns`, `proof`, review item `risk`/`evidence`, task `status`). `update_plan_progress` accepts a spec. Validators, fixtures, golden tests. Server nudges in `present_debrief` and `check_feedback`. First-call hint lines. | S0 gate | Agent-facing only. Content persists but renders as today where no renderer exists yet. |
| **S2** | Debrief renders the packet order: done-when report, hotspots sorted and capped with evidence and Walk-me-through, unknowns with Ask, proof checklist. Reuses the explainer's unknowns block. | S1 | Yes. Only when the fields are present, so old debriefs are unchanged. |
| **S3** | WHERE map: `file_map` with `edges` renders as a graph with changed-node styling and click-to-file. Region comments keep working. | S1 | Yes. Only when `edges` are present. |
| **S4** | Attention: packet grouping in `computeAttention`, the PACKET line, `runInProgress` quieting `notifyDraft`, spec tasks in the TurnIndicator and plan strip. Parity tests with `computeDaemonPendingCount`. | S1, #430 PR 3 landed | Yes, behind the existing `nextUpBar` preference until PR 6 flips it. |
| **S5** | Packet-level Walk-me-through target. Comprehension prompt behind `comprehensionPrompt`, default off. Metrics: packet latency, catches by block, approved-unread count, in SessionMetrics. | S2, S4 | Yes, opt-in. |
| **S6** | Flip: the SKILL names delegate-first as the default shape for delegated work at every autonomy level, and the README's "What you get" gains one bullet. Re-run the §7 protocol on current `main` first. | S2 to S5, independent review | Yes. |

Each slice: focused tests, full `web/src` suite where it touches web,
typecheck, `pnpm build:clean` bundle, independent sign-off.

## 9. Open questions for Mitch, with a recommendation

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Is delegate-first the shape of `balanced`, or a fourth autonomy setting? | (a) It is what `balanced` means for delegated work. (b) A new level. (c) A per-run choice via the preset only. | **(a) plus (c).** The dial already encodes "skip pre-work ceremony for ordinary work". Making the brief its one pre-work card gives the dial a meaning you can see. The preset remains the explicit entry. No fourth level: the ladder Full ⊃ Light ⊃ Minimal must stay monotonic. |
| D2 | Is the intent check a spec with a `delegation` block, or its own type? | (a) Spec plus optional block. (b) New `brief` type. | **(a).** Zero new types is the standing rule, the spec already quick-approves and already quiets the backstop, and the Features view and recall work unchanged. |
| D3 | Does the packet merge the debrief and changeset into one Decide item? | (a) One item, debrief front door, changeset approve is the landing act. (b) Two items as today. | **(a).** Oldest-first routing sends you to the diff first today, which is the wrong door for understanding. Nothing is auto-approved: the changeset keeps its own approve, one click behind. |
| D4 | Should the approve countdown ever arm on a packet's changeset? | (a) Never. (b) As today, when the dial is `autonomous`. | **(a).** A countdown on a packet is the machine rubber-stamping on your behalf. Hold it while the debrief is unread, and do not arm it on a packet at all. |
| D5 | Trivial work: a brief card or a terminal prompt? | (a) Terminal elicitation only. (b) Always a card. | **(a).** A card for a one-file fix is the "enterprise review board" feel round 5 measured. The elicitation text carries the five answers in three lines. |
| D6 | Fork budget for low-risk runs. | 0, 1 or 2 before re-briefing. | **1.** A second fork means the class was wrong. Re-briefing is cheaper than a third interruption. |
| D7 | Does a struck "decide alone" line record a stance? | (a) No, it becomes an ask for this run only. (b) Yes, "ask me about X" becomes a prefer stance. | **(a) for now.** The ledger is for approaches, not for meta-preferences about asking. Revisit if the dogfood shows the same line struck twice. |
| D8 | Where does the `status` request intent land during a run? | (a) A mid-run mini-packet (progress snapshot, no debrief). (b) As today, a debrief-style summary. | **(a).** A debrief mid-run is a second debrief. Serve `status` with the task checklist plus a two-line note, through `answer_question` or a reasoning card linked to the brief. |
| D9 | Comprehension prompt default. | Off and offered once, or on. | **Off, offered once.** Opt-in is the rule for opinionated behaviours, and a forced rating decays to 4. |

## 10. Risks

- **Comprehension debt.** Packets are easy to approve and hard to read. Over a
  week of delegate runs you can land ten changes you could not explain. The
  design's answer is to put the depth on the surface you must pass through
  (the packet is the Decide item, the hotspots are at the top, done-when is a
  checklist against your own brief) and to count "approved unread" where you
  can see it. The answer is not to block. If the count climbs, the next move
  is guidance and the opt-in prompt, not a gate.
- **The rubber-stamp moment.** It is the second after the packet opens, when
  the summary reads well and the approve button is visible. Mitigations: the
  countdown never arms on a packet (D4), the primary act is "Open the diff"
  not "Approve", and the hotspots sit between the summary and the diff.
  Residual risk is real and is what the rubber-stamp signal measures.
- **A WHERE map that lies.** Edges are agent-asserted. A plausible graph with
  a wrong edge is worse than a list. Mitigation in S3: edges are rendered as
  "as described by the agent" with no verification claim, and a node for a
  path that is not in the changeset or the tree renders as a dashed outline.
  A later slice could derive edges from imports, and it should not be promised
  here.
- **Scope drift inside the quiet run.** The agent redefines done to match what
  it built. Mitigation: the done-when report is keyed by `requirementId` from
  the approved brief, so a dropped requirement shows as `not-met` or is
  missing, and the server nudge names the missing ids.
- **Wrong risk class.** The agent calls escalated work low-risk and runs
  quietly through a migration. Mitigations already exist: the guardrail
  backstop asks on the path regardless of the class, and the brief shows you
  the class before the run. The preset tells the agent that a backstop prompt
  during a run means re-brief.
- **Batching a real fork into `decisionsMade`.** The budget rewards fewer
  interruptions, and the agent can meet it by deciding alone. Mitigation: the
  `decisionsMade` block is rendered as "made without you", each line
  commentable, and the §6 catch count attributes a strike there to the packet.
  D7 keeps this from writing stances until the dogfood says it should.
- **Dormancy, again.** The fields exist and nobody fills them. This is the
  round-14 class and the reason §4 has four pulls and §7 gates the UI on a
  dogfood. If S0 does not change what the agent posts on four real issues, S1
  onward should not be built.
- **Elicitation is not universal.** The trivial-class terminal prompt depends
  on MCP elicitation support in the client. Where it is absent the brief falls
  back to a card, which is today's behaviour. The preset says so.
- **Two surfaces, one item.** The packet grouping in `computeAttention` must
  keep web and server counts in parity. The existing parity test with
  `computeDaemonPendingCount` has to cover the grouping or ProjectSwitcher and
  Threads will count two where the bar shows one.

No code is changed by this document.
