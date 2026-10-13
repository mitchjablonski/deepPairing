# Next-up keyboard validation — #529 / #430

Baseline: main `a3eaa231e7916d065a5561160c2da720d7315682` (v0.1.67), isolated
WSL ext4 clone, Node 22.23.2, pnpm 10.33.0, Chromium from Playwright 1.60.0.
Real owned daemons and synthetic fixtures; no user project, host settings or
production daemon was changed. The preview remains opt-in and #430 remains open.

## Real defect and reviewed brief

At the baseline, ArrowDown from the first expanded queue button left focus
there. Escape left the queue open and App's global handler moved focus to main.
A real status transition removing the focused queue button left focus on body.
The contrasting control passed: changing next while the disclosure held focus
preserved focus, selection and scroll. Skip-link placement/activation and the
expanded full-page axe scan passed in the tested dark and light fixtures.

[Issue #529](https://github.com/mitchjablonski/deepPairing/issues/529) records the
bounded real-work brief at 2026-10-13 00:45:07 UTC, focused-node evidence at
[00:46:05 UTC](https://github.com/mitchjablonski/deepPairing/issues/529#issuecomment-6135510801),
and independent Sol 6.1 brief review / Astra implementation approval at
[00:47:19 UTC](https://github.com/mitchjablonski/deepPairing/issues/529#issuecomment-6135531960).
This is agent-reviewed engineering work; the companion preset, human rating and
S0 human-evidence gate were not exercised or completed.

## Bounded repair and proof

Ordered lists and ordinary buttons remain. Up/Down and Home/End move focus among
enabled queue buttons, stopping at the ends, without selecting an artifact.
Escape is consumed inside the expanded bar before App can exit replay or move
focus elsewhere; focus returns to the actual opening control, or the disclosure
if that control has disappeared. A removed queue button or explicit opener gets
a fallback only when it was focused, is disconnected, and the browser's active
element is body. Focus/blur tracking relinquishes ownership when the user leaves.
Surviving controls, other parts of the app, editables, card arrows, modified
chords, Tab and Enter retain their existing behavior.

The pinned baseline's original 48 OFF/ON rows plus two infrastructure guards
passed (50/50, 6.4 minutes). An overlapping diagnostic invocation cleared the
shared output directory during that run, so its retained files are not a
complete 48-row evidence pack; the console result establishes execution only.
Subsequent probes use separate output directories. The corrected focused
browser journeys cover both themes and live arrival/status/removal/approval;
adjacent component checks include the existing live-region guards. The initial
unbounded full web run on `9050e3e0` had two load-sensitive failures (a lazy
footer query and a 10-second fixture timeout); both passed in isolation, and
the full bounded rerun passed all 162 files / 2,109 tests without changing
assertions, timeouts or mocks.

Independent adversarial review of `9050e3e0` caught an additional real gap:
keyboard Why removed its own focused opener, so immediate Escape still reached
App. The original held-state browser test inserted a Tab and the unit test
manually focused the section, concealing that gap. The repair now tracks the
actually focused explicit opener as well as queue buttons. Both regressions
require immediate Escape with no intervening Tab or scripted focus; further
controls cover an opener disappearing later and leaving the bar before removal.
The same review requested precise dark/light limitations, now corrected above.

The checked-in focused suite adds 18 dark/light state rows (A–G, empty, replay),
each with collapsed and expanded full-page WCAG 2/2.1 A/AA axe scans, plus three
keyboard journeys. It verifies high-only/full queues, opener disappearance,
palette teardown, local Escape followed by global replay exit, new-arrival
stability, body-focus recovery, persisted approval and a fresh next item's
single polite DOM announcement. Snapshot-backfilled next transitions stay
silent. The actual applied theme, new runner digest and served runtime hashes
are recorded in each evidence JSON. Final immutable-head run results and
independent adversarial review belong on the PR; approval requires them.

Reproduction and output rules are in
[`attention-walkthroughs.README.md`](../../packages/mcp-server/e2e/attention-walkthroughs.README.md).
Run `pnpm build:clean` before browser checks; the generated plugin bundle is
part of this change. Typecheck and lint pass (0 errors; existing lint warnings).

## Remaining acceptance limits

These are synthetic keyboard/DOM/axe checks, not NVDA, JAWS, VoiceOver, human
dogfooding, comprehension ratings or usability validation. Human baseline
comparison, the separate consent-gated pilot, actual browser zoom, high
contrast, mobile/webview and the long-disconnect escalation remain unmeasured.
This repair makes no approval-policy, schema, dependency, rollout or pilot
decision, and does not satisfy the unfinished parent acceptance gates.
