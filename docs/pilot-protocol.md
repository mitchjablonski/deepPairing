# Decision-level pairing pilot (proposed)

Status: **preparation only; not approved to recruit or collect data**.
Tracks [#434](https://github.com/mitchjablonski/deepPairing/issues/434).
Merging this document does not approve the study or close that issue.

## Question and scope

Does deepPairing help engineers retain ownership of consequential decisions
without adding more review work than it removes? This is a small formative
pilot, not a product-market-fit test or a causal productivity experiment.

Recruit 5-10 adult engineers outside the project's building/review-agent loop
who already use Claude Code on established codebases and expect at least two
relevant follow-up tasks in the next fortnight. Suitable tasks include
refactors, migrations, and unfamiliar-code comprehension. Participants must
have permission to use the tool on the chosen project; synthetic or personal
projects are acceptable and recorded as such. Do not solicit employer code.

Use the supported Claude Code plus browser-companion workflow. No VS Code
parity, pricing/incentives experiment, new integration, or telemetry work is
part of this pilot.

## Approval gate (must be completed before outreach)

Mitch approves the following in a dated decision recorded on #434; private
details remain outside GitHub:

- Named human facilitator and data custodian, eligible audience, recruitment
  channel/message, participant count, and calendar start/end dates.
- This protocol's commit, tested release/commit, metrics and thresholds below.
- Plain-language consent text, minimal-data collection method, restricted
  storage location/access list, deletion date, and contact/withdrawal method.
- Whether any live observation is allowed; default is participant-written
  sanitized notes, no screen/audio recording, logs, transcripts, or exports.

Until every item is approved, agents may prepare documents and review them
but must not contact participants, collect responses, or schedule outreach.
Actual recruitment is conducted by the approved human facilitator unless
Mitch separately authorizes a specific agent-mediated action.

## Procedure and stopping rules

1. Freeze the protocol and product version before the first participant.
   The cohort has a 14-calendar-day enrollment window, then enrollment stops.
   Each enrolled participant has 14 calendar days from their first session.
   If fewer than five enroll, report recruitment failure/inconclusive; do not
   extend or substitute internal agents for participants.
2. Obtain consent and assign a random participant code. Before showing the
   demo, record their normal chat/plan workflow, a recent comparable task,
   and its decision/review difficulties. Mark recollections as self-report;
   no matched or randomized control is implied.
3. Invite one real task. Start the activation clock when installation begins;
   stop at the first artifact reviewed with feedback answered or acknowledged
   by the agent. Record elapsed time, estimated hands-on time, dependency
   waits, errors, and assistance separately. Seeded demos do not activate.
   Assistance is allowed and recorded; assisted completion is not unassisted.
4. After that session, use is optional. Do not assign return tasks or send
   usage reminders. At a single pre-agreed end-of-window interview, ask what
   opportunities arose, whether they chose the tool again, and when they
   reverted to ordinary chat/plan mode. Missing responses remain missing.
5. Summarize within seven days of the last window ending. No automatic
   extension or recurring monitoring. At most one neutral scheduling message
   may arrange the agreed interview; it must not ask the participant to use
   the product again.

A participant can stop at any time. Pause the study immediately for suspected
data exposure, unintended code changes, or a material consent deviation;
notify Mitch privately and resume only after explicit approval. Support
blockers that prevent evaluation are recorded, not silently excluded. If a
security/correctness fix requires an upgrade, safety takes priority: record
the version break and report the affected results separately. Do not pool
different materially changed experiences to meet thresholds.

## Measurements and evidence labels

Use the [blank templates](pilot-templates.md). There is no background data
collection. Do not treat existing local approval-rate or review-latency
counters as proof of usefulness, active reading time, or voluntary retention.

| Measure | Definition |
| --- | --- |
| Activation | One real artifact reviewed and feedback acknowledged/answered in the initial session; record failures and assistance. |
| Voluntary repeat | Participant chose deepPairing on a distinct task on a later day without a usage request/reminder; reopening the demo or resuming the initial task does not count. |
| Opportunity | Number of naturally occurring suitable later tasks, including those done without the tool. Zero and unknown are separate values. |
| Decision value | Specific choice/correction/comprehension outcome with a sanitized description of what changed; generic satisfaction or approval counts do not qualify. |
| Burden | Reading/review minutes, interruptions and support events per task, plus an end-of-window 1-5 ceremony rating (1 negligible, 3 tolerable, 5 outweighs benefit). Separate observed timing from estimates. |
| Alternatives/friction | When/why the participant used ordinary chat/plan mode instead; confusing or unused surfaces, repeated setup, and unresolved feedback. |

Tag every entry **observed**, **participant-reported**, or **inferred**.
Observed means the approved facilitator directly witnessed the event;
participant-written notes and recall remain participant-reported. An inferred
claim cannot satisfy a decision-value threshold. Even an observed correction
does not establish that rework would otherwise have occurred. Record avoided
rework/time as participant estimates, never as measured causal savings.

## Predeclared interpretation (requires approval)

Let **N** be the fixed total enrolled cohort count, frozen when enrollment
closes. All four numerical gates below use this same N, never a smaller
respondent or survivor denominator. Non-response and abandonment without a
withdrawal stay in N and do not count as successes. Never invent zero-minute
times for missing observations; report counts with denominators.

Let **O** count participants known to have at least one suitable follow-up
task. A confirmed zero-opportunity participant is not in O; unknown opportunity
is also not in O but is reported separately. Both remain in N and neither
counts as a repeat success. This deliberately measures adoption in the selected
audience, not only willingness to return among those who found an opportunity.

An interpretable cohort needs N >= 5, **O >= max(5, ceil(0.60 x N))**, and
completed end interviews for at least five members of O. Otherwise the result
is **inconclusive**, regardless of favorable anecdotes. This coverage minimum
makes the N-wide repeat gate attainable. Also report repeat count/O as a
secondary descriptive measure; it cannot replace the N-wide gate.

**Any data withdrawal makes the gate outcome inconclusive.** Delete/exclude
that person's observations as promised; do not shrink N and rerun gates on
the survivors. Remaining consented qualitative findings may still inform a
future study. Retain/disclose only consent-permitted anonymous cohort counts;
if even those counts cannot be retained or safely disclosed, report them as
unavailable and do not evaluate gates. Withdrawal is not a product failure.

Provisional thresholds, fixed before enrollment:

- At least ceil(0.70 x N) activate; report how many do so unassisted and within
  20 elapsed minutes. The time target is diagnostic, not an exclusion rule.
- At least ceil(0.60 x N) voluntarily return on a distinct later-day task.
- At least ceil(0.50 x N) describe a concrete decision-value event, separating
  observed and participant-reported successes in the report.
- At least ceil(0.60 x N) complete the burden question and rate ceremony 1 or
  2. Missing answers do not satisfy this gate.
- No unresolved safety/privacy incident.

**Go** means all gates pass: continue a larger validation phase, not claim
PMF. **Narrow** means interpretable evidence identifies a consistent useful
workflow but the broad gates fail: test that specific hypothesis next.
**Pivot/stop** means interpretable evidence shows little concrete value or
burden dominates; report the counterexamples rather than adding features by
default. **Inconclusive** covers insufficient opportunities/data, material
version/protocol breaks, or conflicting evidence without a coherent segment.
Do not retrospectively change a gate or remove a dropout to obtain a go.
Exploratory subgroups must be labeled exploratory and cannot count as proof.

Protocol dry-run examples (synthetic, not pilot results): N=5, O=5 requires
3 repeaters; N=10, O=5 is inconclusive before checking gates; N=10, O=6 can
satisfy the repeat gate with 6 repeaters. With any withdrawal, none of those
cohorts receives a Go by recomputing N. Unknown/missing responses are never
imputed as successful activation, return, value, or low burden.

## Consent and data handling

Before consent, explain purpose, duration, voluntary participation, requested
fields, storage/access, deletion/withdrawal dates, and the limited reporting
plan, including whether anonymous enrollment/withdrawal counts may be retained
after individual records are deleted. Participation is not a condition of
product support. Obtain separate
opt-in for any observation; declining it is not a disqualifier. Do not record
screens/audio or ask for raw source, paths, secrets, prompts, transcripts,
session exports, repository URLs, or employer/customer names.

Use sanitized task categories and participant codes in working notes. Store
contact/consent records separately from observations in approved restricted
storage, not the repository, GitHub, Agora, or agent prompts. Default access:
Mitch and the named human facilitator/custodian only. No agent receives real
participant records unless Mitch and participants explicitly approve that
specific data use. Consent must explain that ordinary Claude Code usage still
sends content to its model provider; local deepPairing storage is not a promise
that agent input never leaves the machine.

Set the deletion deadline to 30 days after the last participant window closes
and tell participants the exact date. Honor withdrawal requests before public
aggregation by deleting their identifiable records and excluding observations.
Document how to request withdrawal without publishing contact details here.
After publication, explain that irreversibly aggregated data cannot be
individually removed. Delete working notes, contact maps and consent records by
the approved deadline; the custodian records completion privately. Retain only
the approved, non-identifying aggregate report.

Before publishing, the custodian checks for indirect identification: no
participant-level rows, distinctive incidents, employer/project details, or
verbatim quotes by default. Suppress/combine small subgroup details. Obtain
Mitch's approval of the aggregate summary before putting it on GitHub; raw
exports do not become safe merely because identifiers were removed.

## Deliverables and issue closure

This PR delivers only the protocol and templates. #434 stays open pending
approval, actual pilot execution, and a reviewed aggregate report (or an
explicitly recorded stop/inconclusive outcome after the approved attempt).
Follow-ups should address repeated evidence, linked to [UI #430](https://github.com/mitchjablonski/deepPairing/issues/430),
[onboarding #431](https://github.com/mitchjablonski/deepPairing/issues/431), and
[positioning #432](https://github.com/mitchjablonski/deepPairing/issues/432).
Neither unfilled templates nor agent-generated participant simulations count
as external validation.
