# Pilot templates (blank; no participant data)

Use only after the [protocol approval gate](pilot-protocol.md#approval-gate-must-be-completed-before-outreach).
Copy working forms to the approved private storage, never fill them in this
repository or send them through agents by default. All fields below are blank
placeholders, not observations or claims that the pilot has started.

## Approval record

- Protocol commit and approved product release/commit:
- Approved by/date; reference to #434 decision (no private details):
- Facilitator/custodian and access list (private):
- Enrollment window; participant windows; analysis/publication dates:
- Approved recruitment channel/message and target count:
- Restricted storage and withdrawal contact (private):
- Exact deletion deadline and custodian confirmation procedure:
- Approved consent text; optional observation scope:
- Thresholds frozen at approval; predeclared task categories for Narrow:
- Any protocol amendment after approval and rationale (before data use):

## Consent checklist (private, separate from observations)

- Purpose, duration, requested fields, and voluntary participation explained:
- Existing model-provider data flow explained:
- Local files explained: project `.deeppairing/sessions/*` and
  `.deeppairing/daemon.log`; global `~/.deeppairing/philosophy/v1.json` and
  `~/.deeppairing/projects.json`:
- Local files stay on participant's machine unless they choose to send/export;
  pilot does not collect them; stricter no-local-export default vs #434 explained:
- `/deeppairing:share` creates HTML with diffs by default; HTML export
  `includeCode: false` / CLI `--redact-code` disclosed; `/deeppairing:post-pr`
  uses participant's GitHub identity:
- Employer-code restriction and not using share/post-pr on employer code unless
  normally permitted explained:
- Withdrawal/end cleanup confirms each affected store has no active writers
  before backup/restore/edit/delete, including a pre-existing shared daemon;
  only pilot-owned processes may be stopped; if a shared writer cannot be
  safely and voluntarily stopped, defer that store's cleanup and record the
  exception; remove only pilot-created records; preserve pre-existing global
  files; keep a pre-existing plugin install at participant's choice or restore
  its pre-pilot state/preferences:
- No raw code/transcripts/recordings requested; storage/access explained:
- Withdrawal method, aggregation cutoff and exact deletion date supplied:
- Permission to retain/disclose anonymous cohort counts after withdrawal:
- Aggregate-only publication plan and separate observation opt-in explained:
- Participant consent/date; observation consent or decline/date:
- Participant has permission to use the chosen project; no employer identity:

## Participant/task observation (private)

- Random participant code; window start/end; product version:
- Suitable task category; real / synthetic / personal:
- Baseline workflow and recent comparable task (self-report, not control):
- Activation attempted / completed / abandoned / missing:
- Activation elapsed minutes / hands-on estimate / dependency waits:
- Assistance: none / type and count; support blocker and resolution:
- Feedback delivery: answered / acknowledged / pending / unknown:
- Concrete decision-value event (sanitized); observed / reported / inferred:
- Before-state and specific after-state; scorer A / B independent rubric codes:
- Scorer agreement / disagreement and conservative resolution:
- Review/reading minutes and measurement method; interruption count/method:
- Participant estimate of avoided rework, explicitly counterfactual:
- Later natural task opportunities: count / zero / unknown:
- Distinct later-day voluntary reuse: yes / no / unknown; evidence source:
- Any usage prompting or other protocol deviation:
- When/why ordinary chat or plan mode was used instead:
- Confusing/unused surfaces; repeated setup/support needs:
- End interview completed / missing; ceremony rating 1-5 / missing:
- Safety/privacy concern (details handled privately, not copied here):
- Withdrawal/data exclusion status; missing fields and reasons if known:

## Aggregate report (privacy-reviewed before publication)

- Protocol commit, product version(s), observation window:
- Fixed enrolled N (frozen at enrollment close; all four gates use N):
- Withdrawals: any / none / unavailable; any makes gate outcome inconclusive:
- Anonymous cohort-count retention/disclosure permitted; otherwise unavailable:
- O (known >=1 opportunity), confirmed zero, unknown, and missing interviews:
- Coverage: O >= max(5, ceil(0.60 x N)); >=5 members of O interviewed:
- Abandonment/non-response stay in N; no survivor-denominator recomputation:
- Activation count/N; unassisted count; within-20-minute count; missing times:
- Voluntary repeat count/N and count/known-opportunity participants:
- Decision-value count/N, split observed/reported; inferred claims separate:
- Perceived-value event rubric; independent scorer agreement and disagreements:
- Low-burden (1-2) count/N; rating distribution and missing answers:
- Review-time/interruptions summary, sources, missingness, comparability limits:
- Baseline comparison limitations; no causal time-savings claim:
- Most useful workflows; counterexamples and reversion reasons:
- Each predeclared gate: pass / fail / not evaluated, with counts; apply
  Inconclusive -> Go -> Pivot/stop -> Narrow -> Pivot/stop precedence; do not
  evaluate gates after withdrawal or insufficient opportunity coverage:
- Outcome: go / narrow / pivot-stop / inconclusive; rationale:
- Version changes, protocol deviations, exploratory analyses:
- Small-sample/selection/self-report limitations; no PMF claim:
- Evidence-linked follow-ups to #430/#431/#432 or bounded new issues:
- Custodian privacy check and Mitch's publication approval:
- Private deletion completion recorded by custodian; date only here:

Publish aggregate findings only. Do not append completed participant forms,
contact/consent records, uniquely identifying examples or quotes. A simulated
dry run can test this template but must be labeled synthetic and excluded from
every pilot result and success count.
