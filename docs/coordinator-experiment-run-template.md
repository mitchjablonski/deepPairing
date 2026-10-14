# Coordinator experiment run record (blank)

Use with the [protocol](coordinator-experiment-protocol.md). Blank fields are
not observations. The lead maintains this record; the human supplies/confirms
the baseline, end observations and required decisions through the existing UI.
Link frozen setup/evidence once instead of repeating it at every handoff.
Measure bookkeeping effort separately; this is not another review card.

Keep credentials, raw transcripts and sensitive configuration in the agreed
restricted evidence location. Publish only a reviewed, sanitized report.
Label evidence real-runtime / human-observed / human-reported / inferred /
source-audit / simulated; unknown values stay unknown.

## One-time setup reference

- Record owner, single writer and approved evidence/access location:
- Frozen setup agreement reference and date, containing the protocol commit,
  selected real issue/owner consent, repository/full base and product/plugin
  SHAs, exact harness/model versions and sanitized launch/tool configuration:
- Applicable human instruction/delegated policy; exact scope and reference:
- Agreed finite time/attempt/test/usage limits, required asks, interruption
  burden, owned failure-exercise targets, observer and cleanup scope:
- Trial launch authorized? Source/time (blank until applicable):
- Selection status: pending / agreed; #531 is not this trial:
- Related-fix decision reference: owner, issue/PR, reviewed SHA and
  needed / not needed / blocked rationale for #532/#533/#534/#535/#538:
- Any configuration/version break or changed setup agreement:

The setup reference holds the detailed fields from the protocol's freeze
section. Do not silently omit them or copy token values here.

## Readiness receipt

| Required check | Pass / fail / unknown | Evidence reference; actual SHA/time |
| --- | --- | --- |
| Issue selected with owner; setup/limits/authority agreed | | |
| Lead DeepPairing inventory and actual project/session routing | | |
| Worker A DeepPairing tool/MCP/credential exclusion verified | | |
| Worker B DeepPairing tool/MCP/credential exclusion verified | | |
| Reviewer DeepPairing tool/MCP/credential exclusion verified | | |
| Disjoint writers, worktree/hook/policy coverage and dependencies | | |
| Saved outside-drain record; independent reviewer; observation method | | |

- Optional MCP inheritance/attribution probe: not applicable / separately in
  scope. Exclusion evidence or agreed real-runtime probe/result:
- Any hook `agent_id` used, separately from MCP caller/connection identity:
- Missing evidence/blocker and stop/reconciliation decision:

Required unknowns block dispatch. Worker/reviewer MCP identity is not required
when their connections are excluded. A source audit or simulation does not
verify runtime parity or override a failed exclusion check.

## Identity and brief reference

| Role | Observed harness handle / task / attempt | Owned checkout and scoped handoff reference |
| --- | --- | --- |
| Lead | | |
| Worker A | | |
| Worker B | | |
| Independent reviewer | | |

- Lead's observed DeepPairing project root/session and split/fallback evidence:
- Which labels are manual record labels versus real harness-issued IDs:
- Reviewer non-authorship evidence; effective worktree/policy limitations:
- Spec artifact ID/version/title; authoritative status and source:
- Requirements/acceptance; will-ask/decide-alone reference; `confidence` omitted:

No spoofed Claude session ID or invented provider-neutral runtime identity.
Retain each failed attempt; do not transfer a live writer to a new label.

## Handoff receipt (append one short block per attempt)

- Task/attempt/target observed handle; scope/handoff text; full base SHA:
- Known feedback/comment/decision IDs and artifact IDs/versions; authoritative
  current state and authority reference:
- Prepared/saved evidence and time; sent evidence and time; harness receipt
  evidence and time (three distinct facts):
- State: prepared / sent-unconfirmed / receipt-confirmed / completed /
  cancelled / unknown; output commit/evidence if available:
- Interruption/reconciliation: actual worker/checkout status, source records
  inspected, current-state reconstruction versus unavailable delivery history:
- Missing/ambiguous directive or authority reconfirmed by human? Reference:
- Resume/cancel authority; duplicate-writer avoidance; uncertain external write
  and existing recovery path, with no automatic retry:

ACK is not a handoff receipt. Saving after `check_feedback` returns cannot
repair an event never received/saved. Artifact-question carryover does not
prove an ordinary directive's delivery; preserve unknown history.

## Output and review receipt (one block per reviewed head)

- Worker task/attempt and exact output SHA; integrated PR/current head SHA:
- Tests: commands/results and evidence; checks not run and reason:
- Independent reviewer, exact reviewed SHA, verdict and receipt:
- Findings/revision/new SHA; old-head authority invalidated; current-head
  human/delegated authorization source, action and scope:
- Merge readiness/blockers; actual merge/result (not inferred from approval):

Keep worker completion, tests, independent agent review, human/delegated
authority, merge readiness and actual merge distinct. A changed head needs
re-evaluation and current-head authority; old CI or agent APPROVE is insufficient.

## Bounded exercise receipts

For each case, link its agreed owned target, actual event/evidence classification,
recovery/remaining unknowns and stop/resume authority:

- Revision after independent review:
- Worker failure:
- Interruption between feedback receipt and worker handoff:

Mark real-runtime / simulated / not run explicitly. No fixture, preparation
PR or retrospective #531 history completes the real trial. Do not deliberately
create an uncertain external write; record a naturally encountered one
separately and stop automatic retry.

## Baseline and end observations (human supplies/confirms)

- Normal reconciliation workflow/comparable real task; baseline availability,
  evidence type and comparability limits:
- Human before/after explanation of decisions, ownership and comprehension;
  relevant diff read or not; unresolved confusion:
- Required decisions surfaced/omitted/unresolved; missed/remaining blockers:
- Human reconciliation actions/minutes; approvals/screens/interruptions
  (required/nuisance); assistance and measurement method:
- Elapsed/active/wait/recovery/bookkeeping time; estimates versus observations;
  unknown/missing values:
- Provider usage/cost source, coverage and unknown items (unknown is not zero):
- Counterexamples, deviations and configuration/version breaks:

Do not fill this section on the human's behalf or claim causal time savings.

## Reviewed report

- Real run status: not run / attempted / completed; exact configuration SHA:
- Existing changeset/debrief IDs/versions and done-when outcomes:
- Criteria/evidence/missingness; outcome not run / go / narrow / stop /
  inconclusive, using the protocol's predeclared order:
- Independent adversarial review receipt/head and resolved findings:
- Sanitized publication and any merge authority; actual result:
- Bounded follow-up or stop; owned cleanup completed/deferred:
- #540 closure reference (blank until a real trial/required observations or
  authorized real-trial stop report; preparation merge leaves it open):
- #430/#434/delegate-first S0/PMF/screen-reader gates remain separate:

Missing costs, decisions, failed attempts and unanswered questions are not
successes. A synthetic record is labeled synthetic and excluded from trial results.
