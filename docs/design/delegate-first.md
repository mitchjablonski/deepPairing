# Delegate-first pairing — quiet runs, understanding packets (proposal)

> **Status: PROPOSAL, revision 7. Docs only, no code.** Written for Mitch's
> product decision, Fable's UX review and Astra's architecture review. Mitch's
> decisions are recorded in §9. The revision history and every review
> response live in the comments on
> [PR #507](https://github.com/mitchjablonski/deepPairing/pull/507). This
> document reads as the current contract. No UI expansion and no rollout
> flip are approved by it.
>
> Source audited at `main` 08e05772 (v0.1.64). Paths are relative to
> `packages/mcp-server/` unless they start with `packages/` or
> `claude-plugin/`. Earlier verdicts are named inline as *round N*.

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
check** up front, one approval. **A quiet run** that interrupts you for every
decision that is yours and for nothing else, with progress you can glance at
and never have to dismiss. **An understanding packet** at the end that tells
you where the change sits in the system, why it went that way, what to look at
first, what the agent is not sure of, and what proves it works. The diff stays
one click away, and "walk me through it" stays a pull. Nothing new is invented
where an existing artifact, field or surface will do. Per D1 the shape ships
as a **fourth ceremony level, `delegate`**, which becomes the default, while
`supervised`, `balanced` and `autonomous` keep their behaviour unchanged.

**On "never chase review-after."** Round 10 said that, and it still holds in
the sense it was meant: the review of code *after* it lands must never become a
substitute for the decisions the human owns *before* it is written. The
delegate-first shape does not relax that. The architectural fork, the
high-stakes call, every ask you declared in the brief and the gate block still
interrupt in real time. What moves is the **ceremony around them**: the
findings-spec-plan stack collapses into one intent check, and the comprehension
that used to be scattered across per-edit cards collapses into one packet.
Depth is not removed. It is moved to the two moments you are guaranteed to be
looking.

## 1. What exists today (audited)

Each stage of Mitch's flow, with the pieces that already serve it and the gap.

| Stage | Exists | Where | Gap or disconnection |
|---|---|---|---|
| The request | Free-text request composer with three intents (`explain`, `plan`, `status`), served through `check_feedback` | `packages/shared/src/schemas/request.ts`, `web/src/components/RequestComposerBanner.tsx` | No intent means "do this". A delegated task starts in the terminal and the UI never sees the brief. |
| Restating intent | `present_spec`: `objective`, `context`, `requirements[]` each with rationale and acceptance criteria, `openQuestions[]`, `tasks[]`, `visuals[]` | `src/mcp/tools/present-spec.ts`, `content-types.ts:313`, `web/src/components/artifacts/SpecArtifact.tsx` | Nothing says **what the agent will decide alone** versus ask about, or which **risk class** it placed the work in. `context` renders as prose (`SpecArtifact.tsx:62-133`), so a brief's risk and asks would sit inside a paragraph. |
| Terminal approval | MCP elicitation quick-approve on spec and plan | `src/mcp/tool-helpers.ts:30-48` `tryElicit` | **Off by default** (`DEEPPAIRING_TERMINAL_APPROVE=1` opts in). It collides with Claude Code's own permission prompts. A "terminal note" therefore means the agent's chat line, not a prompt. |
| Ceremony level | `supervised` / `balanced` / `autonomous` in `preferences.json`, absent means `supervised`, enum-guarded on load. The slider writes on click. `supervised` contributes zero bytes to the first-call hint and `check_feedback`. | `src/store/file-store.ts:123,203-214`, `src/mcp/autonomy-policy.ts`, `web/src/components/AutonomySlider.tsx:20-27`, `packages/shared/src/schemas/request-bodies.ts:180` | The level is a ceremony-count dial. None of the three names the delegate shape. The approve countdown arms for any `draft` carrying `confidence: "high"` whenever the level is **not** `supervised` (`ArtifactStatusActions.tsx:283-290`), a denylist a fourth level would inherit and one a `balanced` dogfood would trip. |
| Risk classing | Three classes: trivial, low-risk feature, escalated. Guardrail backstop asks once per class per 30 min when no ceremony artifact is live. | SKILL Cadence, `src/guardrail-rules.ts`, `src/cli/preflight-hook-core.ts:538-558` | The class is chosen silently by the agent. And the backstop's liveness test (`readSessionCeremony`, `:313`) is **project-wide and content-blind**: any research, decision, spec or plan created in the last 8 hours in any non-demo session, **draft included**, silences it. It does not bind an edit to a brief's paths, requirements or class. |
| Real-time forks | `present_options` with `stakes`, stable option ids, concepts. The decision card is the alive surface (round 15). | `src/mcp/tools/present-options.ts`, `web/src/components/DecisionCard.tsx` | No stated rule for what *does not* earn a card during a run, and no way for you to declare in advance what must. |
| Gate blocks | `REJECTED_APPROACH_BLOCKED` on `present_*`, PreToolUse `ask` on direct edits, HELD record in the Next-up bar, hero toast | `src/mcp/preflight-validator.ts`, `src/mcp/tool-helpers.ts`, `web/src/components/NextUpBar.tsx` state F | Works at the right weight. |
| Ambient progress | `update_plan_progress` drives the plan strip and "Executing plan — step x of y". Next-up bar state D shows "Working · 2m — <narration>". | `src/mcp/tools/update-plan-progress.ts`, `web/src/components/artifacts/PlanArtifact.tsx:436-484`, `TurnIndicator.tsx:88-103` | Progress needs a **plan artifact**. Spec `tasks[]` have no status. |
| Agent activity | One 60s window, `AGENT_ACTIVE_WINDOW_MS`, fed by artifact creation and agent comments. Past it the pill reads **"Up to date"**. | `web/src/lib/agentActivity.ts:22`, `TurnIndicator.tsx:254-258` | A quiet run makes few MCP calls, so the UI would call a live run "Up to date" within a minute. There is no silence state and no mid-run exit state. |
| Notifications | OS notification per draft (5s throttle, decisions exempt), tab-title badge, toasts | `web/src/stores/connection.ts:294`, `web/src/stores/toast.ts` | No notion of "a run is in progress". |
| The diff | `present_changeset`: hunks, `summary` (rendered, `ChangesetArtifact.tsx:1126`), `risks[]`, `visuals[]`, review state, approve countdown, Walk-me-through per hunk and file | `src/mcp/tools/present-changeset.ts`, `web/src/components/artifacts/ChangesetArtifact.tsx` | A **blocking Decide item**. With a debrief beside it you face two drafts and oldest-first routes you to the diff. |
| The explanation | `present_debrief`: `summary`, `sections[]` with `changesetRef`, `decisionsMade[]` with `alternative`, `needsYourEyes[]` with `artifactRef`, `deferred[]`, `openQuestions[]`, `visuals[]`. Stop hook nags when a debrief is owed. | `src/mcp/tools/present-debrief.ts`, `content-types.ts:588-660`, `web/src/components/artifacts/DebriefArtifact.tsx`, `src/hooks/stop-hook.ts` | **WHERE**: `file_map` is flat. **Hotspots**: no rank, risk or evidence. **Unknowns** and **proof**: absent. **Identity**: `changesetRef` is per section and may name several changesets, `feature` is a label, and nothing names the brief a debrief reports against. |
| Walk me through | `WalkMeThroughButton` on hunks, files and needs-your-eyes items emits a scoped `explain` request | `web/src/components/WalkMeThrough.tsx` | No packet-level target. |
| Pending counts | Web `lib/pending.ts` and daemon `computeDaemonPendingCount` share a type set by a parity test | `web/src/lib/pending.ts:21`, `src/daemon/create-daemon.ts:562-577` | Both count artifacts. Any grouping must be derived in one shared place or the two will disagree. |
| Measurement | `metrics.json` counts, `computeEngagementMetrics` review latency by type | `src/store/metrics-store.ts`, `src/store/engagement-metrics.ts` | Nothing ties feedback to the packet that prompted it. No comprehension signal. |

Three facts drive the design: every piece exists, so this is composition and
guidance. The debrief is the right front door and the changeset the right act,
so the attention model has to treat them as one thing without hiding either.
And the backstop cannot be the safety net for a wrong risk class, so the
boundary has to live in the protocol and on the review surface (§2b).

## 2. The flow

### 2a. The intent check: one card, one approval

You hand over a task. Before touching a file the agent posts **one**
`present_spec` shaped as a brief and waits for one approval. The brief answers
five questions in order:

1. **What I understood you to want.** The `objective`, in one sentence.
2. **Done when.** The `requirements[]`, each with an acceptance criterion you
   could check yourself. The packet reports against them one by one (§2c).
3. **I'll decide these alone.** Calls the agent expects to make without
   asking. Strike a line and it becomes an ask.
4. **I'll ask you about these.** The forks it already sees. **This list is
   binding** (§2b): every item on it earns a card when reached, whatever its
   stakes, and anything you add to it, by striking a decide-alone line or by
   commenting on the brief, is binding too.
5. **Risk class and why.** `trivial`, `low-risk` or `escalated`, with the one
   fact that put it there, and the **declared files** it expects to touch as a
   `file_map`. Changing the class changes the interruption threshold. The
   declared files define the scope boundary in §2b.

Items 3 to 5 are new optional fields on the spec (§3). Until they exist the
dogfood preset carries them as headed lines in `context` (§7).

**Approval is a status, not a moment.** A quiet run starts only when the brief
is `approved`. A draft brief quiets nothing (§2b) and a run against a draft
brief is a protocol violation the server names (§4).

**Why the spec, and where the plan went.** It is already the "are we building
the right thing" surface. The brief is the **only card before approval** at
every class. Under `escalated`, a plan may follow the approved brief when the
order of changes needs your agreement, and the brief says so in its will-ask
list ("the migration order"). That is the middle gear unchanged, and §4 uses
the same words. The spec also silences the guardrail backstop, which is a
residual, not a benefit (§2b).

**How the brief renders (S2a).** Today a spec shows `context` as prose, so a
brief's risk and asks would be buried and a 30-second approval is not
realistic. The brief renderer puts a header row first: the risk chip with its
reason, then **"I'll ask you about"** and **"I'll decide alone"** as two short
lists. Each decide-alone line has a **Strike** control that moves it to the
ask list, with an Undo for ten seconds, and the two lists are a roving-tabindex
listbox so striking works from the keyboard (`s` strikes, `u` undoes, both
added to `KeyboardShortcutHelp.tsx` and the `?` overlay). Strikes
persist as annotations on the brief and reach the agent through
`check_feedback` as "moved to will-ask". Requirements follow, with their
acceptance criteria. The declared `file_map` and `tasks[]` are collapsed by
default. The approve bar is the spec's own.

**What is binding after approval.** The binding boundary is the **approved
brief version's `delegation` lists plus every strike annotation recorded on
that exact version**, in persistence order. A strike after approval does not
create a new version and needs no re-approval: it is binding from the moment
it is persisted, it only ever moves a line from decide-alone to will-ask, and
the agent cannot reverse it. The agent changes the lists only by superseding
the brief, which makes a new draft version that needs your approval again.
Annotations on a superseded version are copied forward onto the replacement
by the server, so a strike survives a reclassification.

**Size by class (D5, decided).** Trivial, low-risk work gets **a terminal
note and no card**: the agent writes the five answers as three lines in its own
chat reply and proceeds, since terminal elicitation is off by default and the
existing trivial carve-out already closes with a self-summarizing
`present_code_change`. Low-risk features and escalated work get the card.

### 2b. The quiet run

Once the brief is approved the agent builds. Interruptions come in two kinds
and the design treats them differently. **Required decisions** are never
capped, never batched and never traded against a budget. **Nuisance
interruptions** are what the budget in §5 limits.

| Required decision | Surface | Rule |
|---|---|---|
| An item on the brief's **will-ask** list, including one you added | `present_options` or a question | Always, at any stakes. Your declared boundary outranks the agent's stakes estimate. |
| An **architectural or hard-to-reverse fork** not on the list | `present_options` | Always. This is the existing floor in `autonomy-policy.ts`, unchanged. |
| **Uncertainty** about whether a choice is the agent's to make, or about its risk | `present_options` | **Uncertainty escalates.** The agent batches only what it is sure is its own. |
| A **gate block** the agent cannot route around while meeting done | HELD record plus one `present_options` naming the blocked road as an option it cannot take | Always. |
| **Done is unreachable** as written | One `present_options` naming the scope fork | Always. The agent never redefines done. |
| **Scope or class change** (below) | Supersede the brief, wait for approval | Always. |

**The reclassification boundary.** A wrong risk class is **not** caught by the
guardrail backstop. `evaluateGuardrailBackstop` returns silently
whenever `readSessionCeremony` finds any live ceremony artifact, draft
included, in any recent session of the project, and the brief is such an
artifact. **A low-risk brief silences the one hook that would have asked
before a migration.** That residual stays, is stated here and in §10, and the
boundary is defined in the protocol instead:

- **Trigger.** During a trivial or low-risk run, the agent is about to edit a
  path matched by `GUARDRAIL_RULES` (`src/guardrail-rules.ts:91`), or a path
  outside the brief's declared `file_map` in a different top-level package or
  directory, or to add a dependency, change a schema, or touch CI.
- **Action.** Stop. Supersede the brief with `risk: "escalated"` (or the
  widened `file_map`) and the reason. Wait for approval. Until then the run is
  paused, and the Next-up bar shows the **new draft replacement brief** as the
  Decide item. The superseded predecessor is not pending and is not shown.
- **Server check (S1).** `present_changeset` carrying a `brief` ref compares
  `files[].path` against `matchGuardrailPath` and the brief's declared files.
  A guardrail path under a trivial or low-risk brief, or an undeclared path
  outside scope, produces a warn in the tool result and a persisted
  `scopeFlags[]` on the changeset (§3) that the packet renders as a System
  flag and that is never hidden. It is a flag, not a block: the code is
  already written and the changeset review is the floor.
- **Not claimed.** A hook that binds edits to the brief's paths would be a
  later slice, is fail-open by contract, and is not a security boundary. This
  document does not promise it.

**Which dial this applies to.** The quiet-run rules in this section apply
under the `delegate` level (§3b) and under the `/deeppairing:delegate` preset
when you invoke it. **`supervised` stays byte-identical** in the first-call
hint, the `check_feedback` reminder and the autonomy policy, exactly as today.
Under `supervised` the preset still posts the brief and the packet, because you
asked for them, but nothing is quieted and every fork is presented as today.
`balanced` and `autonomous` are unchanged.

**Ambient progress, no toasts, and never "Up to date" (S4).** The brief's
`tasks[]` become a live checklist through `update_plan_progress`, which learns
to accept a spec id (§3). A quiet run makes few MCP calls, so the 60s activity
window (`agentActivity.ts:22`) would flip the pill to "Up to date" mid-run.
While an **approved** brief has unfinished tasks the run has its own states,
derived in `computeAttention` from the brief, the task statuses and the
newest agent signal:

| State | Pill and bar | Notifies |
|---|---|---|
| Working | "Task 3/5 · last signal 4m ago", bar state D "◌ WAITING ON CLAUDE · <task>" | No |
| Silent, about 10 min with no signal | Amber "No signal — check the terminal", still in the Waiting lane | May, once |
| Agent exited mid-run (wrapper gone, tasks unfinished) | System item "Run stopped at task 3/5, no packet", with the resume prompt | Yes, once |
| All tasks done, no packet yet | "Finishing — packet next" | No |

"Up to date" is never shown while a brief is running. While running, OS
notifications and toasts fire only for a Decide item, a System state above and
the packet. Progress never notifies. A draft brief quiets nothing.

**Fit with #430.** No new lane. The run is Waiting, a fork is Decide, a block
is System then HELD, the packet is Decide. The packet grouping (§3a) is a
derivation, not a surface. Principle 4 holds: nothing pending is hidden,
nothing is auto-approved, no failure is suppressed.

### 2c. The understanding packet

The run ends with **one** `present_changeset` then **one** `present_debrief`,
the debrief naming the brief and the changeset it packages (§3a). The
attention model treats the pair as **one Decide item** whose front door is the
debrief (D3, decided). The bar reads:

```
│ ▲ PACKET  Rate-limit the export endpoint · 3 hotspots · read, then land the diff   [Open ⏎]  Read 1 ⌄ │
```

Opening it shows the debrief laid out as a packet. Today the debrief opens
its walk expanded (`DebriefArtifact.tsx:198-216`). The packet layout
overrides that order when `packet` is present.

**Above the fold, in this order:**

1. **Scope-flag strip**, non-dismissable, only if `scopeFlags` exist (§2b).
2. **Header row.** Title · Brief vN · **Done x/y met** · **Proof ✓ n / ✗ n /
   ○ n not-run** · `[Open the diff · N files +a −b]` · `[Walk me through]`.
   A requirement not met or a failing check **expands inline right here**, so
   the first thing you read is the thing that is wrong.
3. **Summary**, at most three sentences.
4. **Look here first.** At most three `needsYourEyes[]`, risk-ranked, each as
   `file:line · why · [Walk me through]`. A hotspot without `evidence` renders
   with a visible "no lines given" note, and the server nudges the agent.
5. **Not sure about.** `unknowns[]` as chips with `[Ask]`. When empty it reads
   **"None stated"**. It is never hidden, because an agent that states no
   unknowns is itself a thing to notice.

**Below the fold:**

6. **Where it sits.** A one-line WHERE breadcrumb of the top-level directories
   touched. Its map (`file_map` with `edges`, §3) expands on click, and is
   expanded by default only when the change spans more than one top-level
   directory. Edges render as the agent's description with no verification
   claim, and a path that is not in the changeset or the tree renders dashed
   and labelled **"(unverified)"**. A **list view** of the same nodes and
   edges sits beside the map as the accessible alternative.
7. **Calls made alone.** `decisionsMade[]` with the `alternative`. Decisions
   you were asked during the run are linked, not repeated.
8. **Sections**, collapsed. **Deferred. Open questions.**

**Controls and approvals.** **Open the diff** routes to the changeset, the
landing act, and a packet-intended changeset **never arms a countdown** (D3,
§3b). Each member changeset keeps its own approve. The packet header shows
**"Diffs landed x of N"**. The debrief's own approve/reject bar
(`DebriefArtifact.tsx:562`) is **hidden while any member is still draft**, so
you are never offered a verdict on a story whose diffs you have not landed.

**Completion** is one rule: the debrief completes when **every exact member is
`approved` and no Ask on the debrief is open**. Approving the last member
with no Ask open completes it in the same operation, so for the 1:1 case a
low-risk run is **two approvals**, the brief and the diff. For N members it
is the brief plus N member approvals, plus one manual **Close the packet**
whenever an Ask was open at the last landing or the packet formed already
landed. When members are all
approved but an Ask is open, or when the packet formed already landed, the
debrief's bar returns as **"Close the packet"**, so a manual completion is
always reachable, including after an Ask is answered later. Rejecting or
sending back any member dissolves the packet and leaves the debrief pending
as its own item (§3a). **Walk me through it** emits a packet-scoped `explain`
request, answered with a `present_explainer` ordered by the WHERE map. Pull
only.

**Accessibility.** Done-when and proof statuses carry text labels ("met",
"not met", "pass", "not run"), never glyph or colour alone. The map has the
list alternative above. Chips and hotspots are buttons in the tab order. The
header's inline expansion is announced once, politely.

## 3. New versus reused

Prefer composition. Every schema addition is optional, so an older session
loads unchanged and a tool call without the field is byte-identical to today.

| Need | Reuse | New (all optional) |
|---|---|---|
| Intent check | `present_spec` | `SpecContent.delegation?: { decideAlone: string[], willAsk: string[], risk: "trivial" \| "low-risk" \| "escalated", riskWhy: string }`. Declared files ride the existing `visuals[]` `file_map`. |
| Brief identity | Artifact `id`, `version`, `parentId`, `status` | `BriefRef = { artifactId: string, version: number }`, carried as `ChangesetContent.brief?` and `DebriefContent.brief?`. A packet requires every member's `brief` to **equal** the debrief's (§3a). |
| Packet identity | — | `DebriefContent.packet?: { changesets: Array<{ artifactId: string, version: number }> }` (§3a). `isPacketIntended(artifact)` in shared: a changeset with `brief`, or a debrief with `packet`, from creation and for life (§3b). |
| Done-when report | Spec `requirements[].id` | `DebriefContent.doneWhen?: Array<{ requirementId: string, status: "met" \| "partial" \| "not-met", note?: string }>`, resolved against `brief`. |
| Scope flags | `matchGuardrailPath` | `ChangesetContent.scopeFlags?: Array<{ kind: "guardrail-path" \| "outside-declared-scope", path: string }>`, written by the server. |
| Ambient progress | `update_plan_progress`, plan strip | `SpecTask.status?`, `SpecTask.statusNote?`. `update_plan_progress` accepts a spec id and warns on a non-approved spec exactly as it does for plans. |
| WHERE map | `PlanVisualSchema` `file_map`, `ArtifactVisuals` | `PlanVisual.edges?: Array<{ from: string, to: string, label?: string }>`. Without edges it renders as today. |
| Hotspots | `DebriefReviewItem`, `WalkMeThroughButton` | `DebriefReviewItem.risk?`, `DebriefReviewItem.evidence?: Evidence[]`. |
| Unknowns, proof | Explainer `unknowns[]` render | `DebriefContent.unknowns?: string[]`, `DebriefContent.proof?: { checks: Array<{ label, command?, outcome: "pass" \| "fail" \| "not-run", detail? }>, before?, after? }`. |
| Fourth level | `AutonomyLevelSchema`, `autonomy-policy.ts`, slider | `"delegate"` added to the enum, the policy record and the slider (§3b). `supervised` stays absent from the policy record. |
| Packet grouping | `computeAttention`, `computeDaemonPendingCount` | One pure `derivePackets(artifacts)` in `packages/shared`, consumed by both (§3a). |
| Walk the packet | `WalkTarget` | `{ kind: "packet", artifactId }`. |
| Comprehension prompt | Debrief verdict footer | `comprehensionPrompt?: boolean` preference, default off (D9). |

No new artifact type, lane, approve path or tool. One tool widens its
contract: `update_plan_progress` accepts a second artifact type. One enum
widens: the autonomy level.

### 3a. Identity binding and the packet lifecycle

**The brief.** A run is bound to one **approved spec head**: `{ artifactId,
version }` of the spec whose status is `approved` at the moment the first task
starts. Supersede creates a new artifact id with `parentId` and `version + 1`
(`revise-artifact.ts`), so the lineage root is found by walking `parentId`.
The **canonical approved head** of a lineage is the single `approved` artifact
with the greatest `version`. If two approved artifacts share that version, or
the lineage cannot be walked, the head is **ambiguous**: no packet forms,
nothing is rebound, and the server warns `brief_head_ambiguous`. Ties are
never broken by `createdAt`. A run whose brief is superseded mid-run (the
reclassification case) continues under the **new** approved head, and every
artifact created after that point carries the new ref. A ref to a superseded
version is **stale**: it is never silently rebound, the agent is told to
supersede the artifact with the new ref. `requirementId` collides across
specs, so `doneWhen` is always read against `brief`, never bare.

**The changeset.** Each changeset created in a run carries `brief`, the same
BriefRef the agent is running under. The packet names each changeset by exact
`{ artifactId, version }`. A split run lists every part. Cardinality: **one
debrief to one or more changesets, each changeset in at most one packet.**
`sections[].changesetRef` keeps its per-section meaning and does not define
the packet.

**Derivation, in one place.** `derivePackets(artifacts)` is a pure function in
`packages/shared` with no React and no store access. `computeAttention` (web)
and `computeDaemonPendingCount` (daemon) both call it, and the existing parity
test is extended to assert equal counts for every case in §11. A packet forms
only when all of these hold:

- the debrief is `type: "debrief"`, status `draft`, and carries `brief` and a
  `packet` whose `changesets` is non-empty with **distinct** `artifactId`s;
- `brief` resolves to a `type: "spec"` artifact in the same session at the
  **exact** `version`, with status `approved`, which is the **canonical
  approved head** of its lineage (above);
- every listed changeset resolves to a `type: "changeset"` artifact in the
  same session at the **exact** version, with status `draft` or `approved`,
  whose own `ChangesetContent.brief` **equals** the debrief's `brief` in both
  `artifactId` and `version`. A changeset without `brief` never joins;
- no other draft debrief lists any of the same changesets.

The counterexample this closes: approved specs A and B in one session, a
changeset C bound to B, a debrief D bound to A listing C. Without the equal-brief predicate that formed a
packet and showed A's acceptance criteria over B's work. The equal-brief
predicate fails, no packet forms, and D carries a "diff was built under a
different brief" line.

When a packet forms, the Decide lane shows one item routed to the debrief, the
pending count is one for the group, and the changesets stay listed under the
packet's `⌄` expansion. **When any condition fails, no packet forms and every
pending artifact shows as its own Decide item, as today.** Nothing is ever
absorbed into a packet that does not form.

| Fallback case | What you see |
|---|---|
| Changeset superseded (version mismatch) | Packet dissolves. The new changeset and the debrief are separate items. The debrief carries a "diff revised since this packet" line, and `present_debrief`/`revise_artifact` warn the agent to supersede the debrief with the new ref. |
| Changeset rejected | Packet dissolves. The debrief stays a Decide item with a "diff rejected" line. The rejection reaches the agent as today. |
| Some members approved, others draft | Packet stays, header "Diffs landed x of N", debrief bar hidden. Approving a non-last member never completes the debrief. |
| All members approved, debrief draft (including a packet that formed already landed) | Packet stays, labelled "landed, read the packet". The debrief's bar shows as **Close the packet**, the manual completion. |
| Last member approved while an Ask on the debrief is open | The member lands. The debrief stays `draft` with "1 question open". When the Ask is answered, **Close the packet** appears. Nothing completes on its own. |
| Changeset bound to a different brief than the debrief | No packet. Both items pending. Debrief line "diff was built under a different brief". Server warn. |
| Brief ref points at a superseded version (stale) | No packet. Never rebound. Server warn `brief_ref_stale` naming the current head. |
| Ambiguous approved head | No packet. Server warn `brief_head_ambiguous`. |
| Debrief superseded | The new debrief's `packet` takes over if it resolves. The old one is `superseded` and not pending. |
| Debrief rejected or retracted | The changesets stand alone as today. |
| Brief missing, draft, rejected or in another session | No packet. Both items pending. Server warn at present time, the dangling-ref pattern (`present-debrief.ts`). |
| Two draft debriefs name one changeset | No packet for either. Three separate items. Server warn. |
| Debrief with `packet` but no `brief` | No packet. The grouping requires the brief so done-when is always checkable. |

**Commit-time revalidation and recovery.** A member approve is a daemon
operation, not a web assumption. On commit the daemon re-derives the packet
from the **current** store: membership, exact versions, statuses and open
Asks. If the clicked member is no longer the exact version the tab saw, the
approve is **refused** with "this diff was revised, reload", and nothing is
written. If revalidation passes, the member's status is written first. When
that member is the **last unapproved member** of a formed packet **and no Ask
on the target debrief is open at that moment**, the same record also carries
a `packetCompletionIntent` that names the **exact packet
the human's approval was computed against**: `{ debriefId, debriefVersion,
brief: BriefRef, members: Array<{ artifactId, version }>, askGeneration, at, state:
"pending" }`. The intent is scoped to that debrief id and version. It is
**never transferred** to a successor or replacement debrief, or to any packet
whose brief or member set differs. A non-last member approval, or a last one
made while an Ask is open, writes **no intent at all**, so there is nothing
for a later recovery to complete once that Ask is answered. `derivePackets`
stays pure and never reads intents.

**Ask ordering is durable, not a clock comparison.** `askGeneration` is the
target debrief's durable Ask-history generation, captured in the serialized
member-approval operation. Creating or reopening an Ask advances it; answering,
deleting or compacting an Ask never rolls it back. Ordinary replies and Asks
on other debriefs do not advance it. It survives restart and is never reused
or reconstructed from timestamps. `at` is display/audit metadata only: equal
timestamps, a backward wall-clock step, and a new process's monotonic clock
cannot establish whether an Ask happened after approval. A debrief with no
Ask history has a durably established initial generation, distinct from
missing or ambiguous history. Persisting an Ask and advancing its generation
must be one crash-safe logical mutation; an acknowledged Ask must never be
recoverable without its advance. Missing or ambiguous history fails closed
to manual completion, not generation zero. S1 must choose a durable journal
or equivalent representation satisfying this contract; an in-memory counter
is insufficient.

**An intent is consumed exactly once.** Immediately after the member write
the daemon evaluates the predicate below. Whatever the outcome, the intent is
marked `spent`: on success the debrief's `approved` write carries the intent
id and is itself the spend, and on failure a small `spent` write with the
reason follows. **Recovery acts only on an intent that immediate completion
never evaluated**, which is the crash window between the member write and
the evaluation's own write. A recovered `pending` intent is spent without
completing when its target debrief is no longer `draft`, when **the target's
Ask generation differs from the captured value or cannot be verified**, or
when the predicate fails. Only a `pending` intent whose target still matches
and has had no Ask since completes, once. Nothing ever re-evaluates a spent
intent, so an Ask that was open when the diff landed, and was answered
before a restart, leaves the packet waiting for the manual Close.

**One completion predicate, three callers.** `canCompletePacket(store,
target)` holds when: the debrief with exactly `target.debriefId` and
`target.debriefVersion` exists and is `draft`, its `brief` equals
`target.brief`, its `packet.changesets` equals `target.members` as a set,
every member is `approved` at its exact version, no Ask on the debrief is
open, and `derivePackets` on the current store forms exactly this packet.
Intent-driven callers also require the captured Ask generation to match, even
if a later Ask has already been answered. All three callers serialize final
validation and the completion write with Ask mutations, member-status changes
and artifact revisions: no mutation may slip between the check and the write.
This is a commit-time guarantee, not a web snapshot or an earlier read before
an asynchronous wait. Manual Close uses current state under the same
serialization, so a spent intent never prevents a new explicit human action.
The three callers are:

- **immediate completion**, after the last member's write, when the written
  intent's target satisfies the predicate now, which writes the debrief
  `approved` with `reason: "packet_complete"` and the intent id as a second
  record, spending the intent. A failed evaluation spends it too;
- **recovery**, on daemon startup, for every `pending` intent only, under the
  consumed-once rule above. A spent intent, or one whose target is already
  `approved`, is a no-op, so a restart is idempotent;
- **manual Close the packet**, which runs the same predicate against the
  debrief the human is looking at as the target, with no intent needed.

So when approving C completes D1 and the agent then supersedes D1 into a draft
D2 listing the same approved C, D2 has a new id, no intent names it, and the
recovery pass does nothing. D2 stays `draft` and shows **Close the packet**,
exactly as an already-landed packet should. An Ask that arrives before
completion fails the predicate and spends the intent. An Ask that arrives
after the intent and before a recovery pass spends it too, answered or not.
Either way the packet waits for the manual Close. The two writes are not assumed to
be one physical write, and the state after a crash is the state the human
would have reached.

### 3b. The fourth level and its migration (D1, decided)

`delegate` joins `AutonomyLevelSchema`, the file-store enum guard, the policy
record and the slider, labelled **Delegate** with the blurb "One brief, a quiet
run, one packet. Stops at your declared asks and every architectural fork."
The three existing levels keep their strings, triggers and hint bytes.
`delegate` is not a rung on the Full ⊃ Light ⊃ Minimal ladder: its pre-work is
less than Light's, its fork floor is Minimal's **plus** your will-ask list, and
its close is more than any. The policy record gains one `delegate` line and
`supervised` stays absent, per the existing invariant.

**Default and migration.** The slider writes `autonomyLevel` only on a click,
and an absent field reads as `supervised` today (`file-store.ts:123`). So for
the one-time migration: **present means chosen, absent means default.**

**Sequencing (S1 stages, S6 activates).** S1 adds `delegate` to the enum, the
policy record, the enum guard and the slider, so a person can **opt in by
clicking it**, and nothing else. In S1 an absent field **still reads as
`supervised`**, no migration marker is written and no announcement renders.
The migration, the new default and the announcement activate **together at
S6**, after S2 to S5 have shipped the brief, packet and run renderers and the
§7 dogfood and independent review have passed. D1's decision that everyone on
the default moves is unchanged. This is sequencing, so the renderers exist
before anyone is moved onto them. At S6:

- A project with `autonomyLevel` present keeps it. No change, no notice.
- A project with it absent reads as `delegate` (Mitch, reaffirmed
  2026-10-11: everyone on the default moves, announced once). On first load
  after the S6 upgrade the daemon writes `autonomyLevel: "delegate"` and
  `autonomyDefaultMigratedAt` and broadcasts `preference_changed`. The
  announcement is **one line at the top of the first brief**, not a collapsed
  Read-lane item: "You're on Delegate now — one brief, a quiet run, one
  packet. Full, Light and Minimal are unchanged. [Switch back]". It shows
  once and is gone. No toast. The word "ceremony" never appears in user copy
  (`AutonomySlider.tsx:12-18` dropped it for a reason).
- **Trivial-only users never post a brief**, so they would never see that
  line. For them the same sentence shows **once** as the TurnIndicator status
  line on the first session after the migration, with the same Switch back,
  and it stays available under the Autonomy dial in Settings as "Changed to
  Delegate on <date> · Switch back" until the dial is next clicked.
- Writing the value explicitly means an **older daemon** reading the file
  fails the enum guard and falls back to `supervised`, the fail-safe
  direction. A downgrade never arms more automation.
- Caveat, audited in S1 and enforced at S6: every writer of `autonomyLevel`
  (`init`, the CLI, the routes). Any writer that persisted `supervised` without a human click leaves
  that project on `supervised`. That is the safe error, and it is accepted.
  Going forward the slider and CLI also write `autonomyChosenBy: "human"`, so
  the next migration has a clean key.

**The countdown, and eligibility from creation.** `ArtifactStatusActions.tsx:283-290`
arms auto-approve for a `draft` with `confidence: "high"` when the level is
not `supervised`. Since #522 it cancels an auto-armed countdown when
`shouldAutoApprove` turns false and re-checks `autoEligibleNow` at tick zero.
Adding packet intent to those predicates is still not enough on its own,
because the changeset
arrives **before** the debrief, so at the moment it is drafted no packet has
formed, and a rejected debrief or a stale ref can dissolve a packet later and
hand the member back to the ordinary path. So eligibility is **persistent and
independent of formation**: `isPacketIntended(artifact)` is true for any
changeset carrying `brief` and any debrief carrying `packet`, from creation
and for life, since content is immutable and membership history is retained
by the refs themselves. S1 then does the following:

- the arm predicate becomes an allowlist of `balanced` and `autonomous`
  **and** `!isPacketIntended(artifact)`, so `delegate` never arms and a
  packet-intended artifact never arms at any level, formed or not;
- **the revocation mechanism already exists**, shipped by #522 (`0801c5be`,
  fixes #521), and this design reuses it rather than inventing one. The
  reducer carries `countdownAuto`, set only when the confidence path arms
  (`armCountdown` with `auto: true`), never by the `a`/⏎ keymap. An effect
  cancels an auto-armed countdown the moment `shouldAutoApprove` turns false,
  and the tick re-reads the live autonomy level at zero and cancels instead
  of committing. The auto commit sends `reason: "auto_confidence"`, and an
  **absent reason means a human click**, which is how an explicit approval
  stays distinct from a confidence-triggered one. The daemon's status route
  checks the current level for `auto_confidence` and refuses with **409
  `auto_approve_not_permitted`**, no state change, and the tab shows the
  "Auto-approve was cancelled" toast. A human click is never refused on
  these grounds;
- **the S1 delta is three predicates, nothing more.** On the web, both
  `shouldAutoApprove` and #522's tick-time `autoEligibleNow` gain the
  allowlist `balanced` or `autonomous` and `!isPacketIntended(artifact)`, so
  a countdown that reaches zero is re-checked against the same two conditions
  and cancels instead of committing. Because #522's cancel effect keys on
  `shouldAutoApprove`, a countdown already armed on an artifact that becomes
  packet-intended, or on any artifact when the dial moves to Delegate or
  Supervised, cancels with no new effect. On the daemon, the
  `auto_confidence` check replaces its `level === "supervised"` denylist
  with the same allowlist plus `!isPacketIntended(target)`, so the existing
  409 covers Delegate and packet members too. No new reason values, markers
  or error codes.

Ordinary artifacts, with no `brief` and no `packet`, arm and cancel exactly as
today. The dogfood's "omit `confidence`" (§7) is the S0 workaround; this is
the durable contract.

## 4. Agent protocol and SKILL changes

Round 14's failure mode was fields the agent never reached for. The pull comes
from four directions, because any one alone has failed before.

1. **A human-initiated entry: `/deeppairing:delegate`.** A command in
   `claude-plugin/commands/delegate.md`, shaped like `review-pr.md`, taking an
   issue number, URL or text, carrying the three beats as numbered moves. Its
   text is the dogfood protocol in §7. It works at any dial, with the
   `supervised` caveat in §2b.
2. **The SKILL's Cadence section gets "Delegated work".** It names the shape,
   restates the required-decision table and the reclassification boundary
   from §2b, the packet blocks and caps from §2c, and the rule "uncertainty
   escalates". It says what the run must not do: no `log_reasoning` per step,
   no `present_code_change` per edit, no explainer unless pulled, no second
   debrief, no run against a draft brief.
3. **The first-call hint and `check_feedback` carry a `delegate` block** when
   the level is `delegate`. `supervised` contributes zero bytes, as today, and
   the existing test that pins that is extended to the new level's absence
   from a supervised session.
4. **Server-side nudges, warn-only, the STYLE-block pattern.** On
   `present_debrief` when a `brief` is named: `needsYourEyes` missing or over
   three, `proof` or `doneWhen` absent, `doneWhen` ids not in the brief, a
   `packet` that does not resolve. On `present_changeset`: scope flags. On
   `update_plan_progress`: a non-approved brief. On `check_feedback` during a
   run: "delegate run: x of y tasks done, packet owed". The Stop hook's
   "owes debrief" nag is unchanged.

Words to the agent, in the SKILL:

- "The brief is the only card before approval. One finding that matters goes
  in its `context`. Under `escalated`, a plan may follow the approved brief
  only when the order of changes needs agreement, and the brief says so."
- "Your will-ask list is a promise. Everything on it gets a card, however
  small. Everything your pair adds to it does too."
- "If you are not sure a call is yours, or not sure how risky it is, ask.
  Uncertainty escalates. Batch only what you are sure of."
- "A guardrail path, an undeclared package, a new dependency, a schema or CI
  change under a low-risk brief means stop and re-brief. The budget does not
  apply to this."
- "Three hotspots, ranked, each with lines. Proof is what you ran. `not-run`
  is a valid outcome with a reason."

## 5. Distraction budget

The budget limits **nuisance** interruptions. It **never caps a required
decision** (§2b). Hitting the budget on required decisions means the brief was
wrong and the agent re-briefs. It is never a reason to decide alone.

| Moment | Required (uncapped) | Nuisance budget |
|---|---|---|
| Intent check | — | Exactly 1 card, or a chat note for trivial work. Any fork already visible is posted with it. |
| During a low-risk run | Will-ask items, architectural or irreversible forks, uncertainty, unroutable blocks, unreachable done, reclassification | 0 expected. A card for a choice that was the agent's to make is the nuisance. |
| During an escalated run | Same list | Each card carries `stakes` and a `concept`. Low-stakes choices not on the will-ask list go to `decisionsMade`. |
| Guardrail backstop prompts | — | 0 while an approved brief is live, because the hook is silenced by it (§2b residual). A prompt during a run therefore means the brief was not live. |
| OS notifications | 1 per required decision, 1 for the packet | 0 for progress, 0 for resolved blocks. |
| Toasts | Failures and the block hero, as today | — |
| The packet | — | Summary 3 sentences. WHERE map 12 nodes. Hotspots 3 above the fold. `decisionsMade` 5 shown. `unknowns` 5. |
| Explainers | When you pull one | 0 unprompted. |
| Debriefs | Exactly 1, superseded if it changes | — |

**The honest cost.** Counted properly, a low-risk
delegated run is **three screens** (the brief, the packet, the diff) and,
before §2c's completion rule, **three approvals** (brief, changeset,
debrief). With completion it is **two approvals for the 1:1 case**, the brief
and the one diff, and the diff screen is optional when the packet satisfies
you. A run split into N changesets costs the brief plus N member approvals. Trivial work saves the brief
card only: it still ends with a `present_code_change` card, one screen and one
approval, exactly as today. Each declared ask adds one card, by your choice.

## 6. Measurement

All local. No telemetry leaves the machine. Every number below is an
**interaction measure**, and none of them measures comprehension or asserts
cause.

- **Time to land.** From packet created to changeset approved, per run,
  reported as a median and spread. `computeEngagementMetrics` gains a
  `packet` pairing.
- **Feedback from the packet.** Comments, `needs_changes`, Asks and
  `decisionsMade` strikes, counted per packet and attributed to the block
  they anchor to (`debrief:needs-your-eyes:<i>`, a WHERE region, the diff).
  This says which blocks people respond to. It does not say which blocks
  they understood.
- **Questions raised**, split by block. Unknowns that are asked about earn
  their place. Unknowns that never are may be noise or may be clear.
- **Quick approvals.** A changeset approved within 20 seconds of the packet
  opening. Shown in SessionMetrics as "quick approvals" with the tooltip "an
  interaction count, not a comprehension measure". No scroll or click-order
  inference: an expert review, a short packet and assistive-technology
  navigation all approve fast and all look the same.
- **Self-rated comprehension, opt-in (D9).** With `comprehensionPrompt` on,
  the debrief's "Got it" shows one line, "How well could you explain this
  change to a colleague? 1 to 4", and an optional "what would you check
  first?". Off by default, offered once in the first packet's footer with
  "don't ask again". Self-report, kept separate from the counts above.

What this cannot measure, plainly: whether you understood. The pilot protocol
in `docs/pilot-protocol.md` is where that question goes if it goes anywhere.

## 7. Dogfood protocol, before any UI

Build nothing in the UI until the shape has been run on real work with the
tools that exist. The preset uses only current fields. Where a §3 field is
missing, the content goes in prose under a fixed heading.

**The preset: `/deeppairing:delegate <issue | text>`**

1. **Read** the issue and the code it touches. `recall` the concepts you will
   lean on.
2. **Brief.** One `present_spec`. `objective` in one sentence. `requirements[]`
   with checkable acceptance. `context` with headed lines `Decide alone:`,
   `Will ask:`, `Risk class:`, `Why:`. `tasks[]` as intended steps. The
   declared files as a `visuals[]` entry with `kind: "file_map"` and `files[]`
   (`PlanVisualSchema`). **Omit `confidence` on the two tools that accept it
   at content level today, `present_code_change` and `log_reasoning`**
   (`validate-tool-input.ts:1039,1144`): at `balanced` a `confidence: "high"`
   draft arms the auto-approve
   countdown (`ArtifactStatusActions.tsx:283-290`), which would break D3
   before the allowlist exists. Poll `check_feedback` until it is approved.
   Do nothing else first. For trivial work, write the five answers in chat
   and go.
3. **Run.** Build. Post `present_options` for every will-ask item, every
   architectural or irreversible fork, any uncertainty about authority or
   risk, an unroutable block, or unreachable done. On a guardrail path, an
   undeclared package, a dependency, a schema or CI change: stop, supersede
   the brief via `revise_artifact` (`mode: "supersede"`) with new `content`
   whose `context` line reads `Risk class: escalated` and says why, then
   wait. No `risk` field exists today, and `context` is a plain string. Post
   nothing else. Until spec tasks have a
   status, post one `log_reasoning` per **completed task** with the task as
   `action`.
4. **Packet.** `present_changeset` with `summary`, `risks[]`, and a
   `visuals[]` entry with `kind: "diagram"` (Mermaid `source`) of changed
   files and neighbours. Then `present_debrief` with the same `feature`,
   `changesetRef` on the first of its `sections[]`, a `Brief:` line in the
   `summary` naming the spec title and version, the `summary` itself at most
   three sentences, a `Done when` section by requirement id, `needsYourEyes[]`
   capped at three with lines in `why`, `decisionsMade[]` each with its
   `alternative`, a `Not sure about` section, a `Proof` section with commands
   and outcomes, and `deferred[]`.
5. **Wait.** Poll, answer, serve Walk-me-through with a scoped explainer.
   Supersede, never post a second debrief.

**Four real issues plus a baseline.** One trivial, two low-risk (the §3
schema fields are a candidate), one escalated (under `.github/workflows/` or
the hook scripts), at the `balanced` dial since `delegate` does not exist yet.
Run one more low-risk issue **today's way**, without the preset, and record
the same numbers for it: screens opened, approvals given, interruptions, and
minutes to land. The comparison is what tells you whether the shape bought
anything.

**Record per run,** in the debrief's `openQuestions`: every interruption,
tagged **required** (a will-ask item, a fork, uncertainty, a block, a scope
change) or **nuisance** (a choice you would have left to the agent). Minutes
from packet to approve. Feedback and which block prompted it. Whether you read
the diff. Your 1 to 4 rating by hand.

**Gate to proceed to S2 onward.** Across the four runs: every required
decision was surfaced, with none found afterwards in `decisionsMade` that you
would have wanted to be asked. At least one piece of feedback came from the
packet rather than the diff. You rated 3 or 4 on three of four. Nuisance
interruptions are reported and **D6 is a soft gate**: more than one nuisance
card in a low-risk run is a finding to explain, not a fail. A run with two
warranted asks passes, a run that suppressed one fails. Screens and approvals
per run should not exceed the baseline's. If the gate fails, the fix is in §4
guidance or the shape, not in UI.

## 8. Phased slices, each independently reviewable

| Slice | Contents | Depends on | Visible |
|---|---|---|---|
| **S0** | This document. `delegate.md` preset. SKILL "Delegated work" paragraph. | — | Guidance only. Runs §7. |
| **S1** | §3 fields and `BriefRef`/`packet`/`scopeFlags`. `delegate` enum, policy line, enum guard and slider entry as **explicit opt-in only**: absent preferences still read `supervised`, no migration marker, no announcement (§3b). Countdown allowlist plus `isPacketIntended` on `shouldAutoApprove`, on #522's tick-time `autoEligibleNow`, and on the daemon's `auto_confidence` check. `derivePackets` and `isPacketIntended` in shared with the §11 cases. Commit-time revalidation and `packet_complete` recovery. `update_plan_progress` on specs. Server nudges, scope check and the `brief_ref_stale` / `brief_head_ambiguous` warns. Validators, fixtures, goldens. | S0 gate | Agent-facing. The slider shows a fourth choice. Content renders as today where no renderer exists. |
| **S2** | Debrief renders the §2c packet layout: scope strip, header row with done-when, proof, "Diffs landed x of N" and the inline not-met expansion, hotspots, "None stated" unknowns, collapsed sections. Completion: the debrief's bar hides while any member is draft, the last member approve completes unless an Ask is open, **Close the packet** otherwise. Text status labels. | S1 | Only when `packet` is present. |
| **S2a** | Brief renderer: risk chip, will-ask and decide-alone lists with Strike and Undo, keyboard listbox, strikes as annotations delivered via `check_feedback`, file map and tasks collapsed. | S1 | Only when `delegation` is present. |
| **S3** | WHERE map: breadcrumb, `file_map` with `edges` as a graph, changed-node styling, click-to-file, dashed "(unverified)" paths, the list alternative, expanded by default only across top-level directories. | S1 | Only when edges are present. |
| **S4** | Attention: packet item from `derivePackets`, PACKET line, the run states of §2b (never "Up to date", "Task x/y · last signal", "No signal", "Run stopped"), quieting while an approved brief runs, spec tasks in TurnIndicator and plan strip. Parity test extended. | S1, #430 PR 3 | Behind `nextUpBar` until PR 6 flips it. |
| **S5** | Packet Walk-me-through target. Comprehension prompt behind `comprehensionPrompt`. Metrics: packet latency, feedback by block, quick approvals. | S2, S4 | Opt-in. |
| **S6** | The default flip to `delegate`, the one-time migration and the announcement on the first brief and the TurnIndicator, **activated together** (§3b). The `autonomyLevel` writer audit enforced. README "What you get" gains one bullet. Re-run §7 on current `main` first, independent review. | S1 to S5 | Yes. The first moment any default user is moved. |

Each slice: focused tests, full `web/src` suite where it touches web,
typecheck, `pnpm build:clean` bundle, independent sign-off.

## 9. Decisions

**Recorded (Mitch, 2026-10-11):**

- **D1. A separate fourth ceremony level, `delegate`, which becomes the new
  default.** Not a redefinition of `balanced`. `supervised`, `balanced` and
  `autonomous` keep their behaviour. Migration per §3b: an explicit choice is
  respected, a default moves to `delegate` and is announced once. The
  `/deeppairing:delegate` preset stays. **Reaffirmed 2026-10-11** after the
  UX review questioned moving default users: everyone on the default moves.
- **D3. One combined packet.** The debrief is the front door, the diff is one
  click behind, and it is **never auto-approved**. The countdown never arms
  on a packet member at any level.
- **D5. Trivial, low-risk work gets a terminal note and no card.** The note
  is the agent's chat line, since elicitation is off by default.
- **D9. The comprehension prompt is off by default and offered once.**

**Open, with a recommendation:**

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D2 | Brief as spec plus `delegation` block, or its own type? | (a) Spec. (b) New type. | **(a).** Zero new types, Features and recall unchanged, the middle gear intact. |
| D6 | Nuisance budget for low-risk runs before re-briefing. | 0, 1 or 2. | **1.** A second nuisance card means the class was wrong. Required decisions are never counted here. |
| D7 | Does a struck decide-alone line record a stance? | (a) Ask for this run only. (b) A prefer stance. | **(a).** The ledger is for approaches. Revisit if the same line is struck twice in the dogfood. |
| D8 | The `status` request intent during a run. | (a) Progress snapshot, no debrief. (b) Debrief-style summary. | **(a).** A mid-run debrief is a second debrief. Serve it with the task checklist and two lines. |
| D10 | Packet cardinality. | (a) One debrief, one or more changesets, each in one packet. (b) Strict 1:1. | **(a).** Split runs are honest today and should stay so. The derivation refuses a changeset claimed twice. |

## 10. Risks

- **The wrong-risk-class residual.** A low-risk brief silences the guardrail
  backstop for 8 hours across the project (`readSessionCeremony`), so a quiet
  run can reach `migrations/` with no hook prompt. The boundary in §2b is
  protocol plus a server-side flag on the changeset. The hook is not changed
  and is not claimed to catch it. If a future slice binds the hook to the
  brief's paths, it stays fail-open and is not a security boundary.
- **Comprehension debt.** Packets are easy to approve and hard to read. The
  design puts depth on the surface you must pass through and counts quick
  approvals where you can see them, as a count. It does not block, and it does
  not call a fast approval a bad one.
- **The rubber-stamp moment.** The second after the packet opens. The
  countdown never arms (D3), the primary act is "Open the diff", the hotspots
  sit between the summary and the diff. The residual is real and is not
  measurable from click order.
- **A WHERE map that lies.** Edges are agent-asserted and rendered as such.
  Unknown paths render dashed. Deriving edges from imports is not promised.
- **Scope drift.** Done-when is keyed by `requirementId` against the exact
  approved brief, so a dropped requirement is `not-met` or missing, and the
  server names the missing ids.
- **Deciding alone to meet the budget.** The budget excludes required
  decisions by definition, uncertainty escalates, and `decisionsMade` is
  rendered as "made without you" with each line commentable. The dogfood gate
  fails a run that suppressed a warranted ask.
- **Packet grouping that hides work.** The derivation forms a packet only
  when every reference resolves exactly, and dissolves otherwise into visible
  items. Server and web share the function and a parity test. A bug here is a
  #430 principle-4 violation and is treated as release-blocking.
- **Migration surprise.** The UX reviewer's concern, recorded: a user who
  never touched the dial gets a new shape on their next session, and a
  one-line notice is easy to miss. Mitch's decision stands (D1, reaffirmed).
  Mitigations: the notice sits on the first brief, the one artifact they must
  read anyway, with a one-click **Switch back** that writes the old level
  explicitly. The explicit-choice rule keeps anyone who ever clicked the dial
  where they were. An old daemon reading `delegate` falls back to
  `supervised`. If the dogfood or pilot shows the notice is missed, the
  fallback is a second showing on the first packet, not a modal.
- **Dormancy, again.** If S0 does not change what the agent posts on four real
  issues, S1 onward should not be built.

## 11. Acceptance criteria (S1 to S4), including failure states and parity

**Packet derivation (`derivePackets`, shared, unit).** For each row in the
§3a fallback table: the expected packet set, the expected per-artifact
visibility, and `computeAttention` and `computeDaemonPendingCount` returning
the **same** count. Negative cases, each asserting **no packet and every item
visible on both sides**: the A/B/C/D counterexample (changeset bound to B,
debrief bound to A), a member whose `brief` differs only in `version`, a
member with no `brief`, a debrief `brief` at a superseded version (stale, and
the warn names the head), a lineage with two approved artifacts at the same
greatest version (ambiguous, deterministic, no `createdAt` tie-break), a
`packet` with duplicate `artifactId`s, an empty `changesets`, a `brief`
pointing at a `plan` or a `changeset` rather than a `spec`, a member that is a
`code_change` rather than a `changeset`, an approved brief in another session,
a member with the right id and a stale version, a member that is `retracted`,
a demo session, an artifact with a missing `createdAt`.

**Lifecycle (daemon route plus shared derivation).** C1 approved while C2 is
draft: packet stays, "Diffs landed 1 of 2", debrief `draft`, bar hidden. C2
approved with no Ask: C2 written, then the debrief `approved` with
`packet_complete`. An Ask arrives after C1 lands and before C2: approving C2
lands C2, the debrief stays `draft` with "1 question open", and answering the
Ask makes **Close the packet** appear and clicking it approves the debrief. A
packet that forms with all members already approved shows **Close the packet**
from the start. C2 superseded between the tab's click and the commit: the
approve is refused with "this diff was revised, reload", nothing is written,
and the new C2 and the debrief show as separate items. A daemon crash after
the last member's write, which carried a target-scoped `pending`
`packetCompletionIntent`, and before immediate completion ran: startup
recovery completes the debrief **once**. A crash after a failed evaluation
spent the intent: recovery does nothing and **Close the packet** shows. A
non-last member's approval writes no intent. A rejected member dissolves the
packet and the debrief stays pending alone.

**Intent is scoped to the exact target.** An Ask is open on D1 when C, the
last member, is approved: C lands, **no intent is written**, D1 shows "1
question open". The daemon then crashes before any evaluation and the Ask is
answered before the restart: recovery finds no intent, D1 stays `draft`, and
**Close the packet** is shown. C approved with no Ask open completes D1. The agent
supersedes D1 into draft D2 listing the same approved C: D2 stays `draft`,
recovery does nothing, and D2 shows **Close the packet**. A persisted intent
whose target debrief has since been superseded, or whose recorded `brief` or
member set differs from the current debrief's: recovery does nothing. An Ask
arrives on D1 after C's write and before immediate completion: the
evaluation fails and spends the intent, D1 stays `draft` with "1 question
open", and Close appears when the Ask is answered. **The Ask is answered and
the daemon restarts before anyone clicks Close: D1 stays `draft` and Close is
shown**, because the intent is spent and recovery never re-evaluates it. An
Ask created or reopened after a still-`pending` intent advances the target's
Ask generation; found at recovery, answered or not: spent, no completion,
Close shown. A restart with D1 already
`approved` and its intent still on disk: no write, no broadcast. A restart
with D1 `draft`, members approved, no Ask, intent naming exactly D1: completed
once. Manual Close on a packet with an open Ask: refused with "1 question
open". Manual Close after a member was superseded: refused, the packet has
dissolved.

**Clock-independent recovery and mutation ordering.** Intent creation and a
later Ask share the same wall-clock timestamp; the Ask is answered before a
restart: the generation differs, no completion, Close shown. Repeat with the
wall clock stepping backwards between intent and Ask: identical result. An
older answered Ask reopened and answered after the intent also revokes it.
Deleting or compacting that Ask does not erase the generation advance. A
crash during Ask persistence must recover both Ask and generation, or refuse
automatic completion if the mutation's ordering cannot be established. A
known-empty history survives restart and allows the unchanged target to
complete once; missing or ambiguous history never masquerades as empty.
An ordinary reply or an Ask on another debrief does not revoke the intent.
Pause immediately after final validation, concurrently attempt Ask creation
or a member revision, then resume: the mutations are serialized. If the
mutation commits first, completion revalidates and refuses; if completion
commits first, the later mutation remains visible and cannot be consumed by
the old intent. Manual Close obeys the same ordering and open-Ask predicate.

**Nothing hidden (web).** With a packet formed, the `⌄` expansion lists every
member and `n` visits each member in order. With a packet dissolved, every
member is a sidebar row and a bar item. Axe scans pass in both states.

**Quieting.** `notifyDraft` suppression is active only when a `delegate` spec
is `approved` with unfinished tasks. A draft brief quiets nothing. A
`decision` artifact notifies while quieted. A System failure notifies while
quieted. The packet notifies once.

**Supervised byte-identity.** The first-call hint and `check_feedback`
reminder for a `supervised` session are byte-identical to `main` before and
after S1. The existing pin test is extended to assert the `delegate` block is
absent there.

**Will-ask binding.** A fixture brief with a low-stakes will-ask item, run
through the SKILL in a scripted session, yields a `present_options` for it.
The server nudge fires when a packet's `decisionsMade` names a will-ask item.

**Scope flags.** A low-risk brief plus a changeset touching
`packages/api/migrations/x.sql` yields `scopeFlags: [{ kind:
"guardrail-path" }]`, a warn in the tool result, and a System flag in the
packet that is not dismissable. An escalated brief yields no flag. An
undeclared path under a different top-level directory yields
`outside-declared-scope`. Excluded trees (`fixtures/`, `node_modules/`) yield
none, matching `GUARDRAIL_EXCLUDED_SEGMENTS`.

**Countdown and eligibility.** With level `delegate`, no artifact arms the
countdown. A countdown already at zero when the record it was armed on is
replaced by a packet-intended one, or when the dial has just moved to
`delegate`: `autoEligibleNow` fails and the tick cancels instead of
committing. With level `autonomous` or `balanced`: a changeset carrying
`brief` and `confidence: "high"` that arrives **before** any debrief exists
never arms. The same changeset after its packet dissolves (debrief rejected,
or a stale ref) still never arms. A countdown armed on an ordinary artifact is
**cancelled** when a snapshot replaces that record with a packet-intended one,
and `countdownPaused` prevents a re-arm. The daemon refuses an auto-approve
reason on a packet-intended artifact at commit. An ordinary `confidence:
"high"` changeset with no `brief` arms and auto-approves exactly as today.
With `supervised`, nothing arms, as today.

**Countdown revocation on a level change.** An ordinary high-confidence
changeset armed at `balanced`: switching the dial to Delegate before expiry
cancels the countdown and it stays `draft`. The same at `autonomous` switched
to Supervised: cancelled. Switched from `balanced` to `autonomous`: keeps
running. A countdown armed by `a` at `balanced` (`countdownAuto` false), then
the dial switched to Delegate: keeps running and commits with no reason, as a
human click. A tick-zero dispatch with `reason: "auto_confidence"` whose
daemon commit finds the level changed to `delegate` in between: **409
`auto_approve_not_permitted`**, `draft`, the "Auto-approve was cancelled"
toast. The same commit with no reason: lands. A packet-intended artifact
dispatched with `auto_confidence` at `balanced`: 409. A tab that never
re-rendered after a level change still cannot auto-approve, because the
daemon reads the current level. The `supervised` and `balanced` to
`autonomous` cases behave exactly as #522 left them.

**Migration, staged then activated.** After S1: `preferences.json` with an
absent `autonomyLevel` still reads `supervised`, no `autonomyDefaultMigratedAt`
is written, no announcement renders, and clicking Delegate in the slider
writes `autonomyLevel: "delegate"` plus `autonomyChosenBy: "human"`. After S6:
a present `autonomyLevel: "balanced"` is untouched and no notice renders. An
absent field becomes `delegate` with `autonomyDefaultMigratedAt`, one
`preference_changed` broadcast, and the one-line announcement at the top of
the **first brief**, or once in the **TurnIndicator status line** when no
brief is posted, with **Switch back**, shown once and never again. A file
written with `delegate` and read by the v0.1.64 daemon loads as `supervised`.
A poisoned value still loads as `supervised`.

**Progress on specs.** `update_plan_progress` on a `draft` spec records and
warns with the plan's wording. On an `approved` spec the pill reads "Task x/y
· last signal <age>" per the §2b run-state table and the strip renders. On a
`rejected` spec it warns and nothing quiets.

**Run states.** With an approved brief at task 3/5 and no agent signal for
2 minutes, the pill reads "Task 3/5 · last signal 2m ago" and never "Up to
date". At 10 minutes it reads "No signal — check the terminal" in amber, in
the Waiting lane, and notifies at most once. With the wrapper gone and tasks
unfinished, a System item reads "Run stopped at task 3/5, no packet" with the
resume prompt. With all tasks done and no packet, "Finishing — packet next".
With no brief running, today's pill is byte-identical.

**Completion (1:1).** Inside a formed packet with one draft member the
debrief renders no approve bar. Approving the member revalidates on the
daemon, writes the member, then writes the debrief `approved` with
`packet_complete`. With an unanswered Ask on the debrief, the member lands,
the debrief stays `draft` with "1 question open", and its bar returns as
**Close the packet** once the Ask is answered. Rejecting the member leaves
the debrief pending as its own item. The N-member cases are under
"Lifecycle" above.

**Binding after approval.** A strike recorded after the brief's approval is
delivered on the next `check_feedback` and the server nudge fires if the
packet's `decisionsMade` names the struck line. Superseding the brief copies
its strike annotations onto the replacement.

**Brief renderer.** Striking a decide-alone line moves it to will-ask, shows
Undo for ten seconds, persists an annotation, and reaches the agent on the
next `check_feedback` as "moved to will-ask". `s` and `u` do the same from the
keyboard with focus in the listbox. Axe passes on the brief, the packet in
both fold states, the map and its list alternative.

**Backward compatibility.** Every golden fixture for spec, changeset and
debrief loads unchanged. A `present_debrief` without `brief` or `packet`
produces byte-identical content to today.

## 12. Review history

Every review and its response, revision by revision, is in the comments on
[PR #507](https://github.com/mitchjablonski/deepPairing/pull/507).

No code is changed by this document.
