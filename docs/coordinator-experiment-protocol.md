# Supervised coordinator experiment: preparation protocol

Status: **preparation only; no real trial has started**. Tracks
[#540](https://github.com/mitchjablonski/deepPairing/issues/540). This first slice
may merge independently; #540 remains open for the real trial and human
observations. Neither this document nor a filled synthetic record authorizes a
live trial model call, a trial harness launch, or a merge.

Use the [blank run record](coordinator-experiment-run-template.md). GitHub is
authoritative for issue ownership, PR heads, reviews and merge state. Agora is
for short coordination, not a second backlog. The lead's handoff record is
evidence about this one run, not a task scheduler or an authority source.

Read the protocol once at setup, then follow the seven workflow moves below.
The lead fills mechanical metadata and reuses evidence links; the human need
not complete the whole template or repeat IDs at every handoff. Ask for the
baseline and a short end-of-run observation through the agreed method, alongside
required decisions in the existing UI. Measure extra record-keeping time
separately; preparation detail must not become another approval surface.

## Question and boundary

Can one lead, two independently scoped workers and an independent reviewer
reduce the human's reconciliation effort without hiding required decisions or
mistaking agent review for authorization? Start with existing harnesses and
DeepPairing's current MCP artifacts and companion UI. The lead coordinates;
DeepPairing records decisions and review. No new dashboard, scheduler, DAG
engine, credential broker, defaults, flags or automatic merge policy is added.

The feasibility baseline was audited at
`a4f3844501a9d73c652cf5dc070b1663cbe2dbdb`; this preparation is based on
`9d609879a40c6bbf01f3c17d9eaac52e2d028e19`. Recheck the actual trial SHA:

- Session identity currently derives from project path and a usable
  `CLAUDE_CODE_SESSION_ID`, with a project-only fallback
  (`src/session-id.ts`, under `packages/mcp-server/`). Do not spoof a Claude
  identity for a Codex client or equate a harness task handle with a
  DeepPairing session ID.
- `check_feedback` currently acknowledges session feedback before returning;
  unanswered artifact questions can carry over, but that does not make every
  consumed directive or status event a replayable handoff receipt
  (`src/mcp/tools/check-feedback.ts`, `src/store/file-store.ts`).
- Worktree/project identity and hook scope have active Claude-owned work:
  #532/#533/#534/#535/#538, including PRs #536/#539. Coordinate with their
  owners and consume reviewed outcomes; do not duplicate these fixes. Record
  which changes are necessary, unnecessary or still blocking this trial and
  why. Recheck after any relevant merge.
- Artifact versions and human verdicts are useful review records, not a
  worker execution state machine. MCP TaskHandle is not a scheduler.
  [Delegate-first](design/delegate-first.md) packet/brief semantics remain a
  proposal; this experiment uses existing fields only.

The [local trust model](../SECURITY.md#threat-model) does not enforce trusted
agent roles. Tool/credential exclusion below is a configuration convention,
not a security boundary against a same-user process with equivalent access.

## Freeze the setup before live work

Mitch's authorization, or an applicable recorded delegated policy, must cover
the exact configuration and bounded experiment before a live call or launch.
The record must name the authority and its scope; do not invent a universal
requirement for a new human click when existing delegated authority applies.
If scope or applicability is uncertain, stop for clarification.

The root coordinator and Opus have selected the candidate **session-scoped hook
behavior** work package: existing Claude-owned #534 (guardrail backstop scope)
and #535 (Stop scope), with Opus leading two separate-worktree workers and a
non-author reviewer. [The recorded refinement](https://github.com/mitchjablonski/deepPairing/issues/540#issuecomment-6158558465)
explicitly changes the original single-issue wording to these two named child
issues in one bounded package, not an open-ended backlog. Owner details and
readiness are still pending; no workers have launched. Do not manufacture
parallelism, add work, or take over another owner's implementation.

Opus identifies PR #536/#532 and PR #539/#533 as prerequisites. Record their
review owners, reviewed merged SHAs and relevance at readiness; landing them
alone does not permit launch. The protocol/configuration, worker exclusions,
attempt/time/usage limits, authority mapping and human-observation method must
also be agreed. #531 is a separate, closed CI task and cannot retrospectively
count as this trial.

Freeze these fields in the run record:

- Named cohesive work package/child issues and owner consent; repository,
  full base SHA, protocol commit,
  product/plugin SHA, existing feature flags and effective autonomy settings.
- Exact lead/worker/reviewer harness versions, model IDs, reasoning settings,
  launch configuration and tool/MCP allowlists. Unknown pricing or unavailable
  usage data stays unknown; agree a spending/usage ceiling without assuming
  subscription access is a zero-cost API or inventing unsupported auth.
- One fresh lead session, two worker scopes, one independent reviewer; each
  role's actual observed runtime identity, attempt and owned worktree/path.
- Only the two predeclared child issues; a finite elapsed-time window, allowed
  tests, maximum worker
  attempts, interruption/revision exercises and cleanup scope. Set these before
  the run; do not extend them silently after a failure. Planned disruptions
  affect only experiment-owned processes and local work, never a real user's
  service, unrelated worker or uncertain external operation.
- Required human decisions, allowed lead-only decisions, delegated approval
  policy and publication/merge authority. New dependencies, scope expansion,
  ambiguous authority and unreachable acceptance criteria require an ask.
- A private/sanitized evidence location, one handoff-record writer, and a
  human observer/reporting method. Do not put secrets, bearer tokens or raw
  transcripts in GitHub, Agora or this repository's blank template.

## Readiness checks (manual; not trial results)

Record pass, fail or unknown, with evidence and time. All required checks must
pass before dispatch. Unknown is a blocker, not a silent default.

1. Confirm the selected package's child-issue owners, exact source/configuration SHAs and the
   agreed limits. Resolve overlapping writers and relevant fix dependencies.
2. Inspect the actual lead's MCP/tool inventory and real session registration.
   Record project root and session ID as observed, including fallback mode.
   Do not infer correct routing merely from a tool name or installed plugin.
3. Explicitly exclude every DeepPairing tool/MCP connection from both workers
   and the reviewer. Do not pass daemon tokens, browser approval credentials,
   DeepPairing session-store access or approval tools in their launch context.
   Record the actual exclusion configuration and inspect their tool inventories
   when the agreed harness test is permitted. A prompt saying “don't poll” alone
   does not establish exclusion. If inheritance cannot be controlled or verified,
   stop; a separate harness with the verified configuration is a scope decision.
4. The lead-only trial requires verified lead routing and worker/reviewer tool
   exclusion, not observation of nonexistent worker MCP connections. Mark the
   worker MCP inheritance/attribution probe **not applicable** with exclusion
   evidence when those connections are excluded. Require a real runtime probe
   only if inherited MCP connections or cross-harness attribution are separately
   agreed in scope; do not add them just to complete a checklist. In that case,
   shared-parent versus distinct MCP-visible identity remains unverified until
   observed, and a hook payload's `agent_id` does not prove MCP caller identity.
   Source audits/fixtures are labeled and cannot establish runtime parity. All
   runtime checks that require a launch wait for the setup agreement above.
5. Verify each owned worktree's effective project/hook identity and relevant
   policy coverage, using read-only diagnostics on the chosen trial SHA. Do not
   redirect all workers into the lead's writable checkout to make UI grouping
   look convenient. Record any unresolved worktree/hook limitation explicitly.
6. Confirm existing artifacts can represent the brief, asks, diff and debrief;
   the lead alone consumes feedback. Omit artifact `confidence` to avoid an
   unintended automatic approval countdown. Do not change shared preferences
   or feature flags merely to satisfy readiness; record any agreed change.
7. Confirm the independent reviewer did not author the reviewed changes and
   can inspect the exact commit and test evidence. Verify an outside-drain
   handoff record is writable and survives an ordinary process restart.

## Current-tool workflow

1. **Brief.** The lead posts one `present_spec` with current fields:
   `objective`, requirement IDs/acceptance criteria, `context` headings for
   decide-alone/will-ask/risk, tasks and a declared file-map visual. Record the
   resulting artifact ID/version and authoritative verdict. This protocol
   follows the agreed approval policy; a draft is never treated as approved.
   Spec tasks are descriptive, not executable dependency records.
2. **Prepare handoffs.** Write the bounded worker scope, acceptance criteria,
   forbidden paths/actions, base SHA, task/attempt/worktree mapping and feedback
   references into the outside-drain record before dispatch where possible.
   Give workers only the lead's scoped handoff, not the feedback consumer or a
   fresh approval credential. Routine progress goes into the existing plan
   checklist where appropriate and one consolidated lead summary, not a new
   attention surface.
3. **Dispatch and receipt.** Only the agreed harness launches the workers.
   Record its actual handles and acknowledgement evidence. A successful local
   record write is not proof the harness received a task. A sent task without
   a verified receipt remains uncertain; do not launch a duplicate writer.
4. **Escalate.** The lead presents required forks with `present_options`, polls
   alone, records the artifact/version and authoritative decision, and updates
   the scoped handoff. Answer human questions with `answer_question`. Re-brief
   and wait under the agreed policy when scope, risk or done changes. Quiet
   progress must not suppress required asks, worker failure or unknown state.
5. **Integrate and review.** Workers return exact output commits, scope/test
   evidence and limitations. The lead verifies the commits before integration.
   Present the diff using `present_changeset`; use current `source` metadata
   where supported and put full local commit/worker/reviewer mappings in the
   debrief and run record. An independent review is a finding/verdict about an
   exact head, not human consent. Resolve findings, run applicable checks and
   obtain authority for the current head under the recorded policy.
6. **Report.** One `present_debrief` names the spec title/version, related
   changeset, done-when result, decisions, ranked needs-your-eyes, uncertainties,
   proof and deferred work using current fields. A proposed automatic packet
   completion is not available. Human observations are filled in or confirmed
   by the human, never supplied by the lead as a substitute.
7. **Merge separately.** Record worker completion, tests, independent review,
   human/delegated authority and merge readiness separately. Any changed head
   invalidates the old head's merge authorization; re-evaluate checks/review and
   obtain current-head authority. A normal authorized merge may occur through
   existing practice, but the experiment adds no autonomous merger.

## Feedback and handoff recovery

Maintain a single-writer, saved record outside DeepPairing's feedback drain.
Use ordered entries with explicit task/attempt references and states such as
prepared, sent-unconfirmed, receipt-confirmed, completed, cancelled or unknown.
These are manual observations, not an implemented scheduler or a new backlog.
Before dispatch, save the handoff text and the authoritative feedback IDs and
artifact versions already known. Record persistence and harness receipt as
separate facts. Do not edit live DeepPairing JSON to simulate delivery.

Saving a ledger **after** `check_feedback` returns cannot close the earlier
ACK-before-delivery gap. If the process never received or saved a drained
event, its delivery history may be irrecoverable/unknown. Reconstruct current
authoritative artifact/decision/comment state where available; retain evidence
that an artifact question can still be unanswered despite acknowledgment.
For missing or ambiguous ordinary directives or authority, explicitly ask the
human to reconfirm. Never claim a consumed event was handed off merely because
the store says acknowledged.

On interruption, stop dispatch, inspect the saved handoff record, authoritative
source records, actual worker status/worktree and exact commits. Reconcile
manually before resuming. Do not blindly resend a prepared/sent-unconfirmed
task: it may already be executing. If an external write's result is uncertain,
do not retry automatically; use the operation's existing recovery mechanism or
an explicit coordinated decision. Preserve unknowns and failed attempts.

Exercise and label three bounded cases during the agreed run: revision after
independent review, failure of an owned worker, and interruption between
feedback receipt and worker handoff. A simulation can test the procedure but
does not demonstrate live harness recovery or complete the real trial. Do not
deliberately create an uncertain external write as a failure exercise.

## Observations and interpretation

Before launch, record the normal reconciliation workflow and a comparable real
task, or mark the baseline unavailable. Separate directly observed timing,
human estimates/self-report and inference. No matched-control or causal
productivity claim follows from this one run.

Measure required decisions surfaced/omitted, unresolved or missed blockers,
human reconciliation actions/minutes, approvals/screens/interruptions, elapsed
and waiting time, assistance, recovery effort and provider usage/cost only where
available. Unknown cost is not zero. Record the human's before/after explanation
of the work and whether they read/understood the relevant diff; approval counts
alone are not comprehension. Preserve missing observations and counterexamples.

Apply this order to the real run's report:

1. **Stop** for an unresolved safety/authority/routing breach, conflicting
   writers, an unraised required decision, uncertain external writes, or an
   agreed limit reached. Pause affected work immediately; do not expand scope
   to rescue the result. Record remediation and the remaining unknowns.
2. **Inconclusive** when the run/baseline or required human observations are
   missing, configuration materially changed, or evidence cannot establish the
   authority/recovery chain. Preparation alone is “not run”, not a trial outcome.
3. **Go** only when the real two-worker/independent-review workflow and agreed
   exercises complete, every required decision is surfaced, no blocker remains,
   and the human's recorded comparison shows less reconciliation effort without
   exceeding the pre-agreed interruption burden. Go permits consideration of
   another bounded trial, not a product/default change or proven causal savings.
4. **Narrow** when safe, interpretable observations show value only for a named
   portion of this workflow; identify that portion and its limitations.
5. **Stop** otherwise, with an evidence-linked account of why this configuration
   did not help. Do not tune criteria after seeing the results.

Independent adversarial review covers routing, recovery/unknown delivery,
exact-head binding, role/authority separation, evidence honesty and interruption
burden before the preparation PR and real trial's reviewable changes merge.
Fix findings rather than relabeling tests as human evidence. #540 stays open
until the real trial and required observations or an authorized real-trial stop
report are recorded. This work does not satisfy #430/#434, screen-reader, PMF,
or delegate-first S0 validation gates.
