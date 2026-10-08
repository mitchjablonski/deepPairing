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

The tested install path is the two commands in the README's
[Get started section](../README.md#get-started): `/plugin marketplace add
https://github.com/mitchjablonski/deepPairing`, then
`/plugin install deeppairing@deeppairing`. Record the exact installed plugin
version and source commit in the approval record and report. The gate matches
lexically; a matching direct edit asks the user for approval, and cross-project
matches are advisory. These are workflow expectations, not a
claim that the tool enforces project policy.

## Approval gate (must be completed before outreach)

Mitch approves the following in a dated decision recorded on #434; private
details remain outside GitHub:

- Named human facilitator and data custodian, eligible audience, recruitment
  channel/message, participant count, and calendar start/end dates.
- This protocol's commit, tested plugin version/source commit, metrics, and
  thresholds below. Thresholds are frozen at approval; do not tune them after
  seeing participant data.
- Plain-language consent text, minimal-data collection method, restricted
  storage location/access list, deletion date, and contact/withdrawal method.
- Whether any live observation is allowed; default is participant-written
  sanitized notes, no screen/audio recording, logs, transcripts, or exports.

Although #434 permits opt-in local exports, this protocol deliberately uses a
stricter default: the study does not request or collect local exports. Any
change requires an approved protocol amendment and specific participant
consent before collection.

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

The value measure is **perceived decision value**, not independently
established or causal value. A qualifying event must name a concrete before
and after: the decision, correction, or comprehension gap before using the
tool, and the specific choice, changed/corrected understanding, or next step
afterward. Generic usefulness, satisfaction, approval, or an unspecified
claim of saved time does not qualify. Two scorers independently code each
sanitized event as qualifies / does not qualify / insufficient detail using
this rubric; report raw agreement and disagreements, with disagreements
resolved conservatively as not qualifying unless both scorers agree it
qualifies. With observation off (the default), events are participant-reported
perceptions. Report an event as observed only when the approved facilitator
directly witnessed it; do not imply observed value when it was not observed.
For gates, count each participant at most once, even if they report multiple
qualifying events.

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

Thresholds (frozen at approval; formulas use the fixed enrolled N):

- At least ceil(0.70 x N) activate; report how many do so unassisted and within
  20 elapsed minutes. The time target is diagnostic, not an exclusion rule.
- At least ceil(0.60 x N) voluntarily return on a distinct later-day task.
- At least ceil(0.50 x N) describe a concrete decision-value event, separating
  observed and participant-reported successes in the report.
- At least ceil(0.60 x N) complete the burden question and rate ceremony 1 or
  2. Missing answers do not satisfy this gate.
- No unresolved safety/privacy incident.

Apply this decision order after checking interpretability:

1. **Inconclusive** if any participant withdraws data, coverage/interview
   minimums are unmet, a material version/protocol break prevents comparison,
   or evidence conflicts without a coherent interpretation. Do not proceed to
   another outcome or recompute N in these cases.
2. **Go** if every numerical gate passes and there is no unresolved
   safety/privacy incident. Go means continue a larger validation phase, not
   claim PMF.
3. **Pivot/stop** if interpretable results show participants with at least one
   qualifying perceived decision-value event below `ceil(0.30 x N)`, or at
   least `ceil(0.50 x N)` participants rate ceremony burden 4 or 5. Report
   counterexamples rather than adding features by default.
4. **Narrow** if the result is interpretable, Go and Pivot/stop do not apply,
   and at least three participants report a qualifying decision-value event in
   the same task category that was predeclared at approval. Test only that
   specific workflow hypothesis next.
5. **Pivot/stop** for any other interpretable result that does not meet Go or
   Narrow. Do not relabel an outcome after seeing subgroups. The task-category
   list and thresholds are frozen at approval; exploratory categories cannot
   establish Narrow.

Synthetic boundary examples (not pilot results): with N=5, the Pivot value
line is 2 participants, so 1 participant with a qualifying event triggers
Pivot/stop and 2 do not; three 4-5 burden ratings trigger Pivot/stop. With
exactly two participants with qualifying events, no burden trigger, and fewer
than three in one predeclared category, the fallback is Pivot/stop. Three
participants with qualifying events in one predeclared category and no burden
trigger yield Narrow if at least one other Go gate fails; if all Go gates pass,
Go takes precedence. A withdrawal yields Inconclusive before any of these
checks.
Go still requires every original gate. Do not retrospectively change a gate
or remove a dropout to obtain a Go. Exploratory subgroups must be labeled
exploratory and cannot count as proof.

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

Explain the local deepPairing files participants may see: per project,
`.deeppairing/sessions/*` contains session records and
`.deeppairing/daemon.log` contains daemon logs; across projects,
`~/.deeppairing/philosophy/v1.json` is the local ledger and
`~/.deeppairing/projects.json` is the project registry. These stay on the
participant's machine unless they choose to send or export them; the pilot
does not collect them. Also disclose that `/deeppairing:share` creates a
self-contained HTML page that includes code diffs by default, and
`/deeppairing:post-pr` posts a GitHub review using the participant's own GitHub
identity. During the pilot, participants should not use either on employer
code unless that is already their normal, permitted practice. For an HTML
export, request `includeCode: false` (the `--redact-code` option for
`dp export html`) to omit code from the generated page; still inspect the
result before sharing. Never use employer/customer code without the required
permission.

Before the pilot, inventory which of these paths already exist and record
whether the plugin is already installed and its relevant preferences. Before
backing up, restoring, editing, or deleting any affected local store, confirm
that it has no active writers. This includes a
pre-existing or shared deepPairing daemon that may still hold pilot session
state or pending writes. Stop only pilot-owned daemons/processes; do not
terminate pre-existing or unrelated processes. If a shared writer remains,
ask whether the participant can safely and voluntarily stop it. If they
cannot or decline, defer all local file operations for that store and record
an exception and follow-up rather than changing a live store. Once quiescent,
privately back up any pre-existing global ledger or registry records that
could be affected. Uninstall the plugin only if
it was installed for this pilot. If it was installed before the pilot, do not
require uninstalling that pre-existing workflow: restore its pre-pilot
state/preferences or leave it installed at the participant's choice. Once
each affected store is quiescent, remove only pilot-created records: delete
pilot session files, remove only the pilot's daemon-log entries, and surgically
remove pilot-created ledger/registry entries. If restoring a pre-pilot backup
is safer, first confirm it will not discard unrelated later data. Never
instruct participants to delete a whole pre-existing global file or
directory. The custodian records completion and any records that could not be
isolated; backups remain restricted and follow the approved deletion deadline.

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
