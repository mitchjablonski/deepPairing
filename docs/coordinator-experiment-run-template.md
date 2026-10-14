# Coordinator experiment run record (blank)

Use with the [protocol](coordinator-experiment-protocol.md). Every field here is
blank, not evidence that the experiment has run. Copy it to the agreed evidence
location; keep sensitive configuration, transcripts and credentials out of the
repository, GitHub and Agora. Publish only a reviewed, sanitized report. Mark
every observation real-runtime / human-observed / human-reported / inferred /
source-audit / simulated, as applicable; missing values stay unknown.

The lead maintains this record and links immutable evidence once rather than
requesting repeated human entries. The human fills or confirms only the baseline
and human-observation section plus required decisions through the existing UI.
Record the extra bookkeeping effort; the template is not an extra review card.

## Setup agreement and bounds

- Record owner; evidence location/access; single handoff-record writer:
- Real issue/repository; issue owner consent/coordination reference:
- Selection status (pending / agreed); why two scopes are naturally independent:
- Full repository base SHA; protocol commit; product/plugin/source SHA:
- Existing flags/autonomy and any explicitly agreed changes:
- Root/Opus configuration agreement references and date:
- Authorization source (human instruction / applicable delegated policy), exact
  scope, limits and reference; any unresolved authority question:
- Exact harness versions; model IDs/reasoning settings; sanitized launch config:
- Finite elapsed window; maximum worker attempts; allowed tests; usage/spending
  ceiling and how unknown pricing/usage will be handled:
- Planned revision, worker-failure and handoff-interruption exercises; owned
  targets; no real service/unrelated process/uncertain external-write exercise:
- Required asks; decide-alone boundary; maximum interruption burden agreed
  before the run; who can approve changed scope and current-head merge:
- Human observer/reporting method; publication scope; cleanup owner/scope:
- Actual launch authorization reference and time (blank until applicable):

## Readiness and dependency record

| Check | Pass / fail / unknown | Evidence type/reference; checked SHA/time; owner |
| --- | --- | --- |
| Real issue selected with owner; configuration and limits agreed | | |
| Relevant #532/#533/#534/#535/#538 outcomes coordinated | | |
| Lead MCP inventory and actual session/root routing observed | | |
| Worker A excludes DeepPairing tools/MCP and credentials | | |
| Worker B excludes DeepPairing tools/MCP and credentials | | |
| Reviewer excludes DeepPairing tools/MCP and credentials | | |
| Actual MCP inheritance/session behavior checked on approved harnesses | | |
| Worktree/hook/policy coverage checked on trial SHA | | |
| Scope/checkout ownership disjoint; no duplicate authoritative backlog | | |
| Outside-drain record saved/re-readable; one writer; no secrets | | |
| Reviewer independence and exact-head access confirmed | | |
| Existing UI/artifact flow and human observation method ready | | |

For each related fix: record owner, issue/PR, reviewed commit, needed / not
needed / blocked and reason. Do not mark a source audit or simulation as a
runtime inheritance check; required unknowns block dispatch.

## Observed identity and scope map

| Role | Actual harness/task/session ID (or unavailable) | Model/version | Task / attempt | Owned checkout/project root | Scope / forbidden writes |
| --- | --- | --- | --- | --- | --- |
| Lead | | | | | |
| Worker A | | | | | |
| Worker B | | | | | |
| Independent reviewer | | | | | |

- Lead DeepPairing project root/session ID and split/fallback evidence:
- Which IDs are harness-issued versus manual record labels:
- Observed hook `agent_id`, separately from observed MCP caller/connection/
  session identity; any shared-connection assumption still unverified:
- Tool/MCP allowlist evidence; exclusions; credential handling (no token values):
- Reviewer non-authorship/independence evidence:
- Effective worker worktree/hook/project-policy limitations:

Do not manufacture a provider-neutral runtime identity or set a fake
`CLAUDE_CODE_SESSION_ID` for a different client. Each retry gets its own observed
attempt/handle; do not erase the failed attempt or transfer a live writer.

## Brief, asks and authority

- Spec artifact ID/version/title, authoritative status and evidence:
- Agreed requirements/acceptance; will-ask/decide-alone list:
- Required decision inventory frozen before launch; later scope additions:
- Human/delegated policy source and exact action/head it authorizes:
- Artifact `confidence` omitted; no automatic approval claimed:

| Decision/directive | Feedback/comment/decision IDs; artifact ID/version | Authoritative source/status | Received? Saved? | Required ask surfaced? | Human/policy authority and scope |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

A status/comment acknowledgment is not a dispatch receipt. Record uncertainty
when a response was never received/saved; artifact-question carryover does not
prove that an ordinary directive was delivered.

## Outside-drain handoff record (single writer)

| Entry/order | Task/attempt; target actual handle | Full base/output SHA; scoped handoff/evidence reference | Known feedback IDs + artifact versions | Prepared/saved evidence | Sent + harness receipt evidence | Current state / uncertainty |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

- Handoff text saved before dispatch where possible; persistence method/check:
- Save failure, sent-unconfirmed task or unknown delivery (preserve as unknown):
- Post-interruption authoritative records inspected; actual worker/checkout state:
- Reconstructed current decisions versus unavailable delivery history:
- Explicit human reconfirmation for missing/ambiguous directives or authority:
- Resume/cancel decision and authority; how duplicate writers were avoided:
- Uncertain external write and existing recovery route; no automatic retry:

## Exact output, review and merge map

| Task/attempt | Exact worker output SHA | Integrated PR/head SHA | Test commands/results/evidence | Independent reviewer + exact reviewed SHA/receipt | Findings/revision/new SHA | Human/delegated merge authority for current head | Merge ready? Actual merge/result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

Record these separately: worker completion; tests passed; independent agent
approval; human authorization/applicable delegated policy; merge readiness;
actual merge. A head change invalidates old-head merge authorization. Re-review
and recheck according to the recorded policy; do not infer permission from an
agent APPROVE, successful test, old CI run or artifact acknowledgment.

## Failure exercises and evidence classification

| Case | Agreed owned target/bound | Real runtime / simulated / not run | Event and authoritative evidence | Recovery + remaining unknowns | Stop/resume authority |
| --- | --- | --- | --- | --- | --- |
| Revision after independent review | | | | | |
| Worker failure | | | | | |
| Interruption between feedback receipt and handoff | | | | | |

No fixture, agent-only simulation, this preparation, or retrospective #531
history counts as the real trial. Do not deliberately create an uncertain
external write to fill a case. Record any naturally encountered uncertain write
separately and stop its automatic retry.

## Baseline and human observations (human fills/confirms)

- Normal reconciliation workflow; comparable real task; evidence/source:
- Baseline availability/comparability limits; observed timing versus estimates:
- Human before-state: what decisions/ownership/comprehension were difficult:
- Human after-state: what they understood, decided or still could not reconcile:
- Whether the human read the relevant diff; evidence type and confirmation:
- Required decisions surfaced / omitted / unresolved; blockers missed/remaining:
- Human reconciliation actions/minutes and measurement method:
- Approvals, screens, interruptions (required/nuisance), assistance and method:
- Elapsed, active work, waits and recovery effort; unknown/missing values:
- Provider usage/cost, actual source and coverage; unavailable items marked
  unknown, not zero; no invented subscription-to-API cost equivalence:
- Counterexamples, protocol deviations and configuration/version breaks:

## Reviewed report and next decision

- Real run status: not run / attempted / completed; configuration/protocol SHA:
- Existing changeset/debrief artifact IDs/versions; done-when outcomes:
- Each criterion's evidence, missingness and predeclared interpretation:
- Outcome: not run / go / narrow / stop / inconclusive; rationale:
- Human-observed/reported evidence distinguished from source audit/simulation:
- Independent adversarial review receipt/head and resolved findings:
- Publication and any merge authority; exact current head; actual result:
- Bounded follow-up agreed, or stop; no automatic experiment expansion:
- Owned-record/process/worktree cleanup completed or deferred safely:
- #540 closure decision reference (blank until real trial/required observations
  or an authorized real-trial stop report; preparation merge does not close it):
- #430/#434/delegate-first S0/PMF/screen-reader gates remain separate:

Do not fill human observations on the human's behalf or turn missing costs,
missed decisions, failed attempts or unanswered questions into successes.
