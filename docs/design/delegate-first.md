# Delegate-first pairing — quiet runs, understanding packets (proposal)

> **Status: PROPOSAL, revision 3. Docs only, no code.** Written for Mitch's
> product decision, Fable's UX review and Astra's architecture review.
>
> **Revision 3** answers the independent UX review of `91b21d8e` (CHANGES,
> §12): the quiet run never reads "Up to date" and has silence and exit
> states (§2b), the packet gets a fixed above-the-fold layout with scope
> flags first and proof in the header (§2c), approving the diff inside a
> packet closes the debrief so a low-risk run is two approvals not three
> (§2c, §5), the brief gets its own renderer slice (§2a, §8), the dogfood
> omits `confidence` and adds a baseline run (§7), the cost is stated
> honestly (§5), the announcement is one line on the first brief with no
> "ceremony" in user copy (§3b), §2a and §4 agree on the plan, and
> accessibility is specified (§2c, §11). Mitch reaffirmed D1's migration on
> 2026-10-11 (§9), and the reviewer's concern is recorded under §10.
>
> **Revision 2** records Mitch's decisions of 2026-10-11 (§9: D1 a fourth
> ceremony level that becomes the default, D3 one combined packet never
> auto-approved, D5 trivial work gets a terminal note, D9 the comprehension
> prompt off and offered once) and answers Astra's CHANGES review of
> `f970a190` (§12). The four gaps it closes: the wrong-risk-class residual and
> a reclassification boundary (§2b, §10), canonical brief and changeset
> identity with a shared packet derivation (§3a), supervised byte-identical
> with an explicit escalation rule and a budget that never caps a required
> decision (§2b, §5), and measurement honesty (§6, §7). §11 adds acceptance
> criteria with failure-state and parity cases. No UI expansion and no
> rollout flip are approved by this revision.
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
the same words. The spec also silences the guardrail backstop, which rev 1
called a benefit and rev 2 calls a residual (§2b).

**How the brief renders (S2a).** Today a spec shows `context` as prose, so a
brief's risk and asks would be buried and a 30-second approval is not
realistic. The brief renderer puts a header row first: the risk chip with its
reason, then **"I'll ask you about"** and **"I'll decide alone"** as two short
lists. Each decide-alone line has a **Strike** control that moves it to the
ask list, with an Undo for ten seconds, and the two lists are a roving-tabindex
listbox so striking works from the keyboard (`s` strikes, `u` undoes). Strikes
persist as annotations on the brief and reach the agent through
`check_feedback` as "moved to will-ask". Requirements follow, with their
acceptance criteria. The declared `file_map` and `tasks[]` are collapsed by
default. The approve bar is the spec's own.

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
| **Uncertainty** about whether a choice is the agent's to make, or about its risk | `present_options` | **Uncertainty escalates.** The agent batches only what it is sure is its own. This replaces rev 1's "fold an uncertain fork into `decisionsMade`". |
| A **gate block** the agent cannot route around while meeting done | HELD record plus one `present_options` naming the blocked road as an option it cannot take | Always. |
| **Done is unreachable** as written | One `present_options` naming the scope fork | Always. The agent never redefines done. |
| **Scope or class change** (below) | Supersede the brief, wait for approval | Always. |

**The reclassification boundary.** Rev 1 said a wrong risk class is caught by
the guardrail backstop. It is not. `evaluateGuardrailBackstop` returns silently
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
  paused, and the Next-up bar shows the superseded brief as the Decide item.
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
landing act, and it **never arms a countdown** (D3). Inside a formed packet the
debrief's own approve/reject bar (`DebriefArtifact.tsx:562`) is **hidden**:
**approving the changeset closes the debrief too**, unless the debrief has an
open Ask, in which case the debrief stays pending with "1 question open" and
its bar returns. Rejecting or sending back the changeset leaves the debrief
pending as a separate item (§3a). So a low-risk run is **two approvals**, the
brief and the diff, not three. **Walk me through it** emits a packet-scoped
`explain` request, answered with a `present_explainer` ordered by the WHERE
map. Pull only.

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
| Brief identity | Artifact `id`, `version`, `parentId`, `status` | `BriefRef = { artifactId: string, version: number }`, carried as `ChangesetContent.brief?` and `DebriefContent.brief?` (§3a). |
| Packet identity | — | `DebriefContent.packet?: { changesets: Array<{ artifactId: string, version: number }> }` (§3a). |
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
(`revise-artifact.ts`), so the lineage root is found by walking `parentId`, and
the head is the newest `approved` artifact in that lineage. A run whose brief
is superseded mid-run (the reclassification case) re-binds to the new approved
head, and the packet names that one. `requirementId` collides across specs, so
`doneWhen` is always read against `brief`, never bare.

**The changeset.** The packet names each changeset by exact `{ artifactId,
version }`. A split run lists every part. Cardinality: **one debrief to one or
more changesets, each changeset in at most one packet.** `sections[].changesetRef`
keeps its per-section meaning and does not define the packet.

**Derivation, in one place.** `derivePackets(artifacts)` is a pure function in
`packages/shared` with no React and no store access. `computeAttention` (web)
and `computeDaemonPendingCount` (daemon) both call it, and the existing parity
test is extended to assert equal counts for every case in §11. A packet forms
only when all of these hold:

- the debrief is `draft`, carries `brief` and `packet`, and the brief resolves
  to an artifact in the same session whose status is `approved`;
- every listed changeset resolves to an artifact in the same session with the
  **exact** version and a status of `draft` or `approved`;
- no other draft debrief lists the same changeset.

When a packet forms, the Decide lane shows one item routed to the debrief, the
pending count is one for the group, and the changesets stay listed under the
packet's `⌄` expansion. **When any condition fails, no packet forms and every
pending artifact shows as its own Decide item, as today.** Nothing is ever
absorbed into a packet that does not form.

| Fallback case | What you see |
|---|---|
| Changeset superseded (version mismatch) | Packet dissolves. The new changeset and the debrief are separate items. The debrief carries a "diff revised since this packet" line, and `present_debrief`/`revise_artifact` warn the agent to supersede the debrief with the new ref. |
| Changeset rejected | Packet dissolves. The debrief stays a Decide item with a "diff rejected" line. The rejection reaches the agent as today. |
| Changeset approved, debrief draft | Packet stays, labelled "landed, read the packet". Approving the debrief closes it. |
| Debrief superseded | The new debrief's `packet` takes over if it resolves. The old one is `superseded` and not pending. |
| Debrief rejected or retracted | The changesets stand alone as today. |
| Brief missing, draft, rejected or in another session | No packet. Both items pending. Server warn at present time, the dangling-ref pattern (`present-debrief.ts`). |
| Two draft debriefs name one changeset | No packet for either. Three separate items. Server warn. |
| Debrief with `packet` but no `brief` | No packet. The grouping requires the brief so done-when is always checkable. |

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

- A project with `autonomyLevel` present keeps it. No change, no notice.
- A project with it absent reads as `delegate` (Mitch, reaffirmed
  2026-10-11: everyone on the default moves, announced once). On first load
  after upgrade the daemon writes `autonomyLevel: "delegate"` and
  `autonomyDefaultMigratedAt` and broadcasts `preference_changed`. The
  announcement is **one line at the top of the first brief**, not a collapsed
  Read-lane item: "You're on Delegate now — one brief, a quiet run, one
  packet. Full, Light and Minimal are unchanged. [Switch back]". It shows
  once and is gone. No toast. The word "ceremony" never appears in user copy
  (`AutonomySlider.tsx:12-18` dropped it for a reason).
- Writing the value explicitly means an **older daemon** reading the file
  fails the enum guard and falls back to `supervised`, the fail-safe
  direction. A downgrade never arms more automation.
- Caveat for S1: audit every writer of `autonomyLevel` (`init`, the CLI, the
  routes). Any writer that persisted `supervised` without a human click leaves
  that project on `supervised`. That is the safe error, and it is accepted.
  Going forward the slider and CLI also write `autonomyChosenBy: "human"`, so
  the next migration has a clean key.

**The countdown.** `ArtifactStatusActions.tsx:288` arms auto-approve when the
level is not `supervised`. S1 changes that to an allowlist of `balanced` and
`autonomous`, so `delegate` never arms it, and adds "never for a packet
member" so the preset under `autonomous` cannot auto-approve a packet (D3).

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

**The honest cost.** Rev 1 said "two sittings". Counted properly, a low-risk
delegated run is **three screens** (the brief, the packet, the diff) and,
before §2c's combined approval, **three approvals** (brief, changeset,
debrief). With the combined approval it is **two approvals**, and the diff
screen is optional when the packet satisfies you. Trivial work saves the brief
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
  navigation all approve fast and all look the same. Rev 1's "approved
  unread" label is withdrawn.
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
   `Will ask:`, `Risk class:`, `Why:`. `tasks[]` as intended steps. A
   `file_map` of declared files. **Omit `confidence` on every artifact in the
   run**: at `balanced` a `confidence: "high"` draft arms the auto-approve
   countdown (`ArtifactStatusActions.tsx:283-290`), which would break D3
   before the allowlist exists. Poll `check_feedback` until it is approved.
   Do nothing else first. For trivial work, write the five answers in chat
   and go.
3. **Run.** Build. Post `present_options` for every will-ask item, every
   architectural or irreversible fork, any uncertainty about authority or
   risk, an unroutable block, or unreachable done. On a guardrail path, an
   undeclared package, a dependency, a schema or CI change: stop, supersede
   the brief as escalated, wait. Post nothing else. Until spec tasks have a
   status, post one `log_reasoning` per **completed task** with the task as
   `action`.
4. **Packet.** `present_changeset` with `summary`, `risks[]`, and a `diagram`
   of changed files and neighbours. Then `present_debrief` with the same
   `feature`, `changesetRef` on the first section, a `Brief:` line naming the
   spec title and version, `summary` of three sentences, a `Done when`
   section by requirement id, `needsYourEyes[]` capped at three with lines
   in `why`, `decisionsMade[]` with alternatives, `Not sure about`, `Proof`
   with commands and outcomes, `deferred[]`.
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
| **S1** | §3 fields and `BriefRef`/`packet`/`scopeFlags`. `delegate` enum, policy line, slider entry, migration and announcement (§3b). Countdown allowlist. `derivePackets` in shared with the §11 cases. `update_plan_progress` on specs. Server nudges and scope check. Validators, fixtures, goldens. | S0 gate | Agent-facing, plus the one-time announcement. Content renders as today where no renderer exists. |
| **S2** | Debrief renders the §2c packet layout: scope strip, header row with done-when and proof and the inline not-met expansion, hotspots, "None stated" unknowns, collapsed sections. Combined approval: the debrief's bar hides inside a formed packet and the changeset approve closes it unless an Ask is open. Text status labels. | S1 | Only when `packet` is present. |
| **S2a** | Brief renderer: risk chip, will-ask and decide-alone lists with Strike and Undo, keyboard listbox, strikes as annotations delivered via `check_feedback`, file map and tasks collapsed. | S1 | Only when `delegation` is present. |
| **S3** | WHERE map: breadcrumb, `file_map` with `edges` as a graph, changed-node styling, click-to-file, dashed "(unverified)" paths, the list alternative, expanded by default only across top-level directories. | S1 | Only when edges are present. |
| **S4** | Attention: packet item from `derivePackets`, PACKET line, the run states of §2b (never "Up to date", "Task x/y · last signal", "No signal", "Run stopped"), quieting while an approved brief runs, spec tasks in TurnIndicator and plan strip. Parity test extended. | S1, #430 PR 3 | Behind `nextUpBar` until PR 6 flips it. |
| **S5** | Packet Walk-me-through target. Comprehension prompt behind `comprehensionPrompt`. Metrics: packet latency, feedback by block, quick approvals. | S2, S4 | Opt-in. |
| **S6** | Default flip to `delegate` with the migration live. README "What you get" gains one bullet. Re-run §7 on current `main` first, independent review. | S1 to S5 | Yes. |

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
  click behind, and it is **never auto-approved**. Rev 1's D4 (the countdown)
  is folded in: it never arms on a packet member at any level.
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
the **same** count. Additional cases: an approved brief in another session,
a brief whose lineage has two approved heads (the newest wins, the test pins
it), a changeset with the right id and a stale version, a debrief naming a
changeset that is `retracted`, a demo session (never forms a packet), an
artifact with a missing `createdAt`.

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

**Countdown.** With level `delegate`, no artifact arms the countdown. With
level `autonomous`, a packet member does not arm it and a non-member does, as
today. With `supervised`, nothing arms, as today.

**Migration.** `preferences.json` with `autonomyLevel: "balanced"` is
untouched and no notice renders. An absent field becomes `delegate` with
`autonomyDefaultMigratedAt`, one `preference_changed` broadcast, one Read-lane
item that clears on open and never returns. A file written by S1 and read by
the v0.1.64 daemon loads as `supervised`. A poisoned value still loads as
`supervised`.

**Progress on specs.** `update_plan_progress` on a `draft` spec records and
warns with the plan's wording. On an `approved` spec the TurnIndicator reads
"Working on <title> — task x of y" and the strip renders. On a `rejected`
spec it warns and nothing quiets.

**Run states.** With an approved brief at task 3/5 and no agent signal for
2 minutes, the pill reads "Task 3/5 · last signal 2m ago" and never "Up to
date". At 10 minutes it reads "No signal — check the terminal" in amber, in
the Waiting lane, and notifies at most once. With the wrapper gone and tasks
unfinished, a System item reads "Run stopped at task 3/5, no packet" with the
resume prompt. With all tasks done and no packet, "Finishing — packet next".
With no brief running, today's pill is byte-identical.

**Combined approval.** Inside a formed packet the debrief renders no approve
bar. Approving the changeset sets the debrief `approved` in the same store
write. With an unanswered Ask on the debrief, the changeset approve lands, the
debrief stays `draft` with "1 question open" and its bar returns. Rejecting
the changeset leaves the debrief pending as its own item.

**Brief renderer.** Striking a decide-alone line moves it to will-ask, shows
Undo for ten seconds, persists an annotation, and reaches the agent on the
next `check_feedback` as "moved to will-ask". `s` and `u` do the same from the
keyboard with focus in the listbox. Axe passes on the brief, the packet in
both fold states, the map and its list alternative.

**Backward compatibility.** Every golden fixture for spec, changeset and
debrief loads unchanged. A `present_debrief` without `brief` or `packet`
produces byte-identical content to today.

## 12. Review response map

### Rev 3: independent UX review CHANGES at `91b21d8e`

| Finding | Addressed in |
|---|---|
| **HIGH 1.** "Up to date" mid-run. Never during a running brief, "Task x/y · last signal", "No signal" at ~10 min, "Run stopped" on exit. | §1 agent-activity row; §2b run-state table; §8 S4; §11 "Run states" |
| **HIGH 2.** Packet order: scope strip first, header with done and proof and the diff button, summary, hotspots with an evidence nudge, "None stated" unknowns, WHERE breadcrumb below the fold, sections collapsed, not-met expands inline. | §2c in full; §8 S2 |
| **HIGH 3.** Double approval. Changeset approve closes the debrief unless an Ask is open, debrief bar hidden in a packet. | §2c "Controls and approvals"; §5 honest cost; §8 S2; §11 "Combined approval" |
| **MED 4.** Brief renderer slice: risk chip, strikeable lists with undo, file map and tasks collapsed. | §2a "How the brief renders"; §8 S2a; §11 "Brief renderer" |
| **MED 5.** Dogfood auto-approve on `confidence: "high"` at `balanced`. Omit `confidence`, add a baseline run, D6 soft gate. | §1 ceremony row; §7 steps and gate |
| **MED 6.** Honest cost: three screens, three approvals, trivial still ends with a card. | §5 "The honest cost" |
| **MED 7.** Migration: keep D1, record the concern and mitigations. | §9 D1 reaffirmed; §10 "Migration surprise" |
| **LOW 8.** No "ceremony" in user copy, announcement one line on the first brief. | §3b |
| **LOW 9.** §2a and §4 reconciled on the plan. | §2a "Why the spec, and where the plan went"; §4 first bullet |
| **LOW 10.** Accessibility: list alternative, text status labels, "(unverified)", keyboard striking. | §2c "Accessibility" and item 6; §2a; §11 |

### Rev 2: Astra CHANGES at `f970a190`, and Mitch's decisions of 2026-10-11

| Finding | Source | Addressed in |
|---|---|---|
| **(1)** The backstop is silenced by any live ceremony, draft included, and does not bind edits to the brief. Retain the residual, define a reclassification boundary, do not claim the path gate catches it. | Astra | §1 risk-classing row; §2b "The reclassification boundary" and its server check; §3 `scopeFlags`; §5 backstop row; §10 first bullet; §11 "Scope flags" |
| **(2)** No stable brief or changeset binding. `requirementId` collides, `feature` is a label, `changesetRef` is per section. Specify identity, approved revision, exact version, cardinality, fallbacks. Derive identically on server and web, keep unmatched work visible. | Astra | §3 `BriefRef`, `packet`, `doneWhen` against `brief`; §3a in full; §9 D10; §10 "Packet grouping that hides work"; §11 "Packet derivation" and "Nothing hidden" |
| **(3)** Thresholds "regardless of dial" and "every autonomy level" conflict with supervised byte-identical. Honour declared will-ask boundaries including a human-added low-stakes ask. Replace "batch an uncertain fork" with uncertainty-escalates. The budget never overrides a required decision. Separate mandatory from nuisance. | Astra | §2a item 4 binding; §2b required-decision table and "Which dial this applies to"; §3b; §4 words to the agent; §5 two-column budget; §11 "Supervised byte-identity" and "Will-ask binding" |
| **(4)** "Approved-unread" over-claims. Label it a limited interaction proxy, non-judgemental, no comprehension or causality from click order. The dogfood gate must not reward suppressing a legitimate second interruption. | Astra | §6 "Quick approvals" and the opening sentence; §7 record and gate; §10 "Comprehension debt" and "The rubber-stamp moment" |
| Failure-state and parity cases in acceptance criteria | Astra | §11 |
| D1 fourth level, new default, migration respecting explicit choices, preset kept | Mitch | §0, §3 "Fourth level", §3b, §8 S1 and S6, §9, §11 "Migration" |
| D3 one combined packet, never auto-approved | Mitch | §2c, §3b "The countdown", §9, §11 "Countdown" |
| D5 terminal note, no card for trivial work | Mitch | §1 terminal-approval row (elicitation is off by default), §2a "Size by class", §9 |
| D9 comprehension prompt off, offered once | Mitch | §6, §9 |

No code is changed by this document.
