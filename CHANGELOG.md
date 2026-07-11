# Changelog

## v0.1.11 — 2026-07-10

The review-round release: everything found by a six-lens project audit
(security ×2, test-suite health, docs-vs-reality, debt, competitive landscape),
fixed. No breaking changes.

### Added
- **Secret warnings you can actually see.** The scanner's matches were being
  emitted and dropped — never rendered anywhere. Now: a prominent warning
  banner on any artifact containing a possible secret (with the field and line,
  never the value itself), an inline ⚠ chip on flagged comments, and the agent
  is told too. Coverage extended to every artifact type and to comments — and
  new high-precision patterns (Stripe, Slack, npm, GitHub fine-grained, GCP
  service-account, signed JWTs), each shipped with a near-miss test so the
  banner stays trustworthy instead of crying wolf.
- **`deeppairing philosophy publish on|off` now exists.** Init has been telling
  every user about this command; it was never implemented. It is now — flip
  cross-project ledger publishing without re-running init.
- **First real interaction e2e suite**: the full review loop (select → approve →
  supersede → verify persisted), region-drag against real rendered diagram
  geometry (including the gutter-start gesture from live field testing), and
  hostile WebSocket upgrades against a real daemon.

### Fixed
- **The doctor's graceful eviction works for the first time.** Its cooperative
  evict request was rejected by the daemon's own auth gate on every attempt
  (silently falling back to SIGTERM). The doctor now authenticates the way any
  client does; the gate itself is unchanged.
- **The docs tell the truth again.** The agent-facing protocol no longer
  licenses skipping the per-edit code-change checkpoint for "simple tasks"
  (the floor is stated plainly: no setting and no task size lifts it); the FAQ
  no longer claims cross-project rejections hard-block (they advise; local
  rejections block); tool counts, schema summaries, and the README's feature
  list match the shipped product.

### Internal
- **The daemon's composition root is finally under test.** Its wiring was a
  1,209-line script no test could import — a test audit proved four real
  regressions (including disabling the update-detection gate entirely) shipped
  green. It's now an importable factory, and each of those four mutations is
  pinned by a test that fails if the wiring is disconnected.
- Dead code removed (an unused animation module, a parked schema alias, a
  vestigial WebSocket fallback that broadcast into an empty set).

## v0.1.10 — 2026-07-10

Region-comment ergonomics, shaped by two rounds of live field testing.
No breaking changes.

### Fixed
- **The diagram's drag-selection area is now visible — and all of it works.**
  The diagram sits in a bounded well (its own background, border, and padding)
  with a crosshair cursor, so you can see exactly where region selection
  starts and ends, in both themes. And the entire well is the capture surface:
  a centered diagram's side gutters used to look selectable but were dead
  ("I can't select left of the login form") — a drag starting there now works,
  clamped to the diagram's edge.
- **Overshooting the diagram no longer cuts your selection short.** The old
  drag handling force-completed the selection the instant your pointer crossed
  the (previously invisible) boundary — no mouse-up, composer opens with a
  partial rectangle. The drag is now pointer-captured: start inside the
  diagram, move anywhere on the page, and the selection completes where you
  release, clamped to the diagram.

## v0.1.9 — 2026-07-10

Fixes from a full release-verification pass — the v0.1.7→v0.1.8 update path was
field-tested with real released bundles (7/7 pass), and the release was reviewed
as a composed whole. Everything found is fixed here. No breaking changes.

### Fixed
- **Project guardrails can no longer be squeezed out of the agent's briefing.**
  With Detail: Terse plus a non-default Autonomy level, the two guidance blocks
  could crowd the guardrail-paths list out of the session preamble — while the
  autonomy guidance simultaneously told the agent to "escalate for guardrail
  paths." Guardrails now ride the uncapped tier unconditionally: present in all
  24 dial combinations, exactly when a trust-raising dial makes them matter most.
  Also clarified the division of labor in the guidance itself: Terse governs
  text; whether an artifact posts at all is governed by the Autonomy dial.
- **The decisions view shows a decision the moment you make it.** It read only
  from disk, so a decision resolved seconds ago could be missing for a few
  seconds until the debounced flush landed. Live sessions are now read from
  memory and merged over the disk scan (live wins; no duplicates; sessions from
  ended daemons still come from disk).
- **The decisions view stays honest across a restart.** If a session's decisions
  file was ever corrupted, the recovery sidecar is now surfaced in the partial
  banner even after the daemon restarts and writes a fresh file — previously the
  banner went quiet and the pre-corruption history had no surviving mention.
  Also: a decision superseded while unresolved now reads "Superseded (never
  resolved)" instead of wearing a permanent "Awaiting your decision" pill.
- **`DEEPPAIRING_NO_OPEN=1` suppresses the browser auto-open** for scripted, CI,
  and agent-driven daemon starts. (Documented in docs/troubleshooting.md.)

## v0.1.8 — 2026-07-10

Polish and honesty. No breaking changes.

### Fixed
- **The Autonomy dial now applies from the agent's first artifact.** Its guidance
  used to arrive only via `check_feedback` — *after* the opening findings/options
  were already posted — so sliding to "Light" or "Minimal" couldn't affect the
  very sequence that felt heavy. The level is now standing guidance in the
  session preamble. The floor is stated at every level, in both blocks: no
  setting ever skips `present_code_change` before a write, and project
  guardrails still escalate to full supervision. The default (Full/supervised)
  preamble is byte-for-byte unchanged.
- **Light theme is now WCAG AA.** Five accent colors inherited dark-theme
  foregrounds onto pale backgrounds — the worst pair measured 1.61 against the
  4.5 floor. All re-tinted to ≥4.6 with margin, hues preserved, and CI now runs
  an axe scan with the light theme active so this class of bug can't return.
  (The dark theme's two borderline tokens were also re-tinted to ≥5.1 — a CI
  flake traced to axe sampling mid-animation on zero-margin pairs.)
- **The agent no longer retries deterministic failures.** Tool errors now
  distinguish transient conditions (daemon 5xx, network failures — retryable)
  from deterministic ones (invalid requests, handler bugs — not retryable), so
  the agent stops looping on errors that can't succeed. Error messages also
  relativize your project path instead of echoing it absolute.

### Changed
- **The docs now lead with the gate, not the Ledger.** README, INSTALL, and the
  plugin manifests reframed around the enforcement promise — a concept you
  rejected is stopped before the edit lands, in the project where you rejected
  it, and flagged (advisory) on your other projects. This also corrects an
  overclaim: the old copy implied rejections were gate-stopped "across every
  project"; cross-project has always been advisory. The Philosophy Ledger is
  still there — inspectable, exportable — as the mechanism underneath.

### Internal
- Cross-project advisory recall now sits behind a narrow `AdvisoryRecall`
  adapter (advisory output proven byte-identical; the synchronous hard-block
  hook gained no dependency), so a future native-memory provider is a swap,
  not a surgery.

## v0.1.7 — 2026-07-10

Three features you asked for, and a safety dial that now fails the right way.
No breaking changes.

### Added
- **Project-wide decisions view.** Every decision across every session of the
  project, in one searchable place — the question, the option you chose, when,
  and which session — with one click back to the decision in context. Until now
  a decision was only visible inside the session that made it, so the record of
  *what we decided and why* was effectively unreachable once a session scrolled
  away. Honest by construction: if one session's decisions file is corrupt, the
  view names it in a banner and still shows everything else — it will never
  render "no decisions yet" while something failed to load, and a decision with
  no readable date shows "date unknown" at the bottom instead of masquerading
  as the newest.
- **Detail density (verbosity) control.** A "Detail: Rich / Terse" toggle in the
  Autonomy popover. Terse tells the agent to tighten the *prose* inside each
  artifact — findings and recommendations in 1–2 sentences, evidence first —
  while never reducing the number of artifacts, never skipping options or code
  review, and never omitting evidence. Evidence is the load-bearing content;
  terse trims the explanation around it. Off by default: a session that doesn't
  opt in behaves byte-for-byte as before.
- **Region-anchored comments on diagrams.** Drag a rectangle over a Mermaid
  diagram (or pick a node by keyboard) and your comment carries the referent by
  *name* — "the box labelled AuthGate" — so the agent can find it in the diagram
  source it authored and revise it. Anchors are matched by node label, so a
  comment survives page reloads and diagram revisions; a node that is genuinely
  removed is flagged honestly. No screenshots: the textual anchor is cheaper,
  browser-independent, and more useful to the agent than pixels. (Prototype
  previews remain un-annotatable by design — they run in an opaque-origin
  sandbox the page cannot read into, and that boundary stays.)

### Fixed
- **The Autonomy dial now fails closed.** An invalid autonomy value (a corrupted
  or hand-edited preferences file, or a bad API write) used to persist and be
  read as "not supervised" — which silently armed the auto-approve countdown and
  relaxed the agent's guidance. Exactly backwards for a safety control. Both
  internal preference routes now validate their input (400 on garbage), and an
  unrecognized stored value heals to `supervised` — the most supervised state —
  on load.
- **A frozen philosophy ledger is now discoverable.** `dp doctor` reports the
  ledger's health, any `.corrupt-*` recovery snapshots, and the exact (safely
  quoted) command to move an unreadable file aside; `check_feedback` tells the
  agent when recording is frozen — and adds nothing to the payload when healthy.
- **Malformed request bodies return 400, never 500**, across all daemon and
  companion-UI routes, with field-level validation messages preserved.
- **`daemon.json` is written atomically at mode 0600.** A disk-full mid-write can
  no longer truncate it (or drop the auth token with it), and a persistently
  failing heartbeat now escalates to stderr instead of failing silently forever.

## v0.1.6 — 2026-07-09

**Updating deepPairing now actually updates deepPairing.** This is the release
that delivers the previous ones. No breaking changes.

### Fixed
- **A plugin update no longer keeps serving the old daemon.** deepPairing reuses
  a running daemon for your project rather than starting a new one — but it never
  checked *which version* was running. So after you updated the plugin, the old
  daemon stayed resident and kept answering, and every fix you'd just installed
  was invisible until you rebooted or killed it by hand. If you updated and
  nothing seemed to change, this was why. Startup now compares the running
  daemon's version against its own and restarts it when they differ.

  Safety: the running daemon is only replaced when it proves it is *this*
  project's daemon and *is* the process holding the port (its `pid` is
  self-reported and must match). A recycled pid, another project's daemon, a
  probe that fails, or a probe that times out all fall back to adopting what's
  there — the restart path can never kill a healthy, current, or foreign
  process. Shutdown is graceful: pending work is flushed to disk before exit.

- **`dp --version` told you the truth.** It printed a hardcoded `0.1.0` no matter
  what was installed — actively misleading for the one command you'd run to check
  whether an update took. It now reads the same constant the MCP handshake and
  the daemon report.

- **Your philosophy ledger can no longer be silently erased.** A corrupt or
  unreadable `~/.deeppairing/philosophy/v1.json` used to be read as *empty*, and
  the next write then persisted that emptiness over months of cross-project
  history. Now the file is snapshotted to `…​.corrupt-<timestamp>` and writes are
  **refused** until you repair or remove it — deepPairing will not overwrite a
  ledger it could not read. Recovery is automatic: fix the file and recording
  resumes on the next read, no restart needed.

  A single malformed entry no longer costs you that concept's whole history
  either — it is rebuilt from the instances it still holds rather than dropped,
  and any entry that genuinely must be dropped is backed up first. An empty
  ledger file is treated as a fresh start, not as corruption.

- **Two daemon crash vectors.** An `fs.watch` error with no listener (routine on
  WSL, where the inotify watch limit is easy to exhaust) took the whole daemon
  down with it. And a periodic heartbeat write that hit a transient disk error
  re-threw from inside a timer and exited the process; it now logs and retries,
  while a *startup* failure stays loud and fatal as it should.

- **Two leaks.** Every `check_feedback` that timed out while you were away leaked
  its waiter, unbounded. And a `check_feedback` that threw mid-poll orphaned its
  10-second heartbeat interval forever.

- **Tool errors read like errors, not protocol failures.** A rejected oversized
  request surfaced as a raw JSON-RPC error the agent couldn't act on; it is now a
  normal tool result the agent can read and retry from. Malformed request bodies
  on the acknowledge routes return `400` instead of `500`.

### Internal
- The release version now lives in one place and a test enforces it. Four files
  must agree on every bump; a comment used to ask a human to remember, and it had
  silently failed three times. CI now fails instead.

## v0.1.5 — 2026-07-09

Your comments are never ignored again. No breaking changes.

### Fixed
- **A comment on a pending decision is no longer swallowed.** When the agent was
  waiting for you to pick an option, a comment you left on that decision was
  invisible to it — dismissed internally as "unrelated chatter" — so it polled
  forever while you waited for a reply. Now **any human comment (or question)
  always reaches the agent**, on every kind of wait, and the response carries
  both signals: what you said, *and* that the decision is still pending. Human
  questions were affected identically and are fixed too.
- Status-only scoping still works as intended: waiting on a decision is not
  woken by an unrelated artifact approval.

### Internal
- `pnpm build:clean` — the committed plugin bundle is generated but must match a
  cold build (CI enforces it). A warm `pnpm build` could serve a cached bundle CI
  couldn't reproduce, which broke the last two releases. Regenerating the bundle
  now has one correct command, documented and named in the CI failure message.


## v0.1.4 — 2026-07-08

Makes the agent's view of your review actions observable. No breaking changes.

### Added
- **`check_feedback` now reports human status changes by artifact id.** When you
  approve or reject a draft, the agent sees it explicitly —
  `✅ RESOLVED: art_… (spec) "…" — approved` — plus a machine-readable
  `statusChanges` array, instead of having to infer it from an aggregate counter.
  Reported once, then acknowledged. The agent's own supersede/retract/obsolete
  transitions are deliberately excluded, so the signal stays high-value. This
  makes a superseding v2 draft's approval directly observable, which it wasn't.
- **`serverVersion` in the `check_feedback` payload**, sourced from a single
  `SERVER_VERSION` constant that also feeds the MCP `serverInfo` handshake and
  the install-health ping — so an agent can tell at a glance whether it's talking
  to a stale daemon instead of diagnosing it from symptoms.

### Fixed
- A stale hardcoded `0.1.0` in the daemon's install-health ping now tracks the
  real server version.
- Test/CI hygiene: a debounced-flush-vs-teardown ENOENT race no longer fails the
  suite with a spurious non-zero exit while every assertion passes; genuine write
  failures (EACCES/ENOSPC) still log. Added `FileStore.dispose()` to cancel a
  pending flush.

> **Upgrading:** deepPairing runs a persistent per-project daemon. Updating the
> plugin files does **not** restart it — a new MCP process adopts the running
> daemon. To actually get onto a new version, restart the daemon (kill the pid in
> `.deeppairing/daemon.json`) or fully restart Claude Code. The new `serverVersion`
> readout makes it obvious when you're still on old code.


## v0.1.3 — 2026-07-07

Multi-session/multi-port field fixes and a decision-prototype rendering fix.
No breaking changes.

### Fixed
- **Older artifacts no longer go missing from another session on the same
  daemon.** The companion UI treated "seen one artifact from a session" as
  "fully loaded" and skipped the full backfill; it now fetches a session's
  complete artifact set even when a stray artifact arrived first.
- **A cross-daemon approval is no longer silently lost.** Acting on an artifact
  owned by a different project's daemon used to POST to the wrong daemon and
  silently roll back. It now fails loudly and guides you to the right project —
  and a same-daemon session that's merely lagging the session poll is confirmed
  against a fresh fetch before any block, so valid approvals aren't held up.
- **Decision-option prototypes run in the live view.** Per-option prototypes
  were stuck on the static "open the live version to run it" placeholder (a
  flag that also disabled option comment-anchoring); the two concerns are now
  separate, so option prototypes render their runnable sandbox while the
  revision-diff view keeps its static preview.


## v0.1.2 — 2026-07-07

Data-loss fixes from real pairing sessions, a more durable rejection gate, and
an honest positioning pass. No breaking changes.

### Fixed (field bugs — data-loss)
- **In-progress comments no longer lost when the agent revises an artifact.**
  The draft composer is now keyed to the stable version-chain root, so a v2
  supersede doesn't strand your unsaved comment.
- **Posted comments no longer vanish when a spec/artifact is updated.** Comments
  now render across the whole version chain (tagged "from v1"), instead of only
  the version they were posted on. Read-side only — no comment is re-parented.
- **A resolved decision now shows as selected on reload.** Resolved state is
  hydrated for live sessions, not only during replay.
- **Flows/artifacts now sort predictably** and a flow can no longer silently
  disappear when two share a title prefix (grouping is keyed by root id, follows
  version chains, and orders by creation time).

### Changed (rejection gate — more durable)
- The gate now matches on the **concept the agent named** (concept↔concept), with
  light stemming so wording variants ("hosting"/"hosted") match — while the
  "rail" ∈ "guardrail" false-positive stays suppressed.
- **Cross-project stances are advisory, not a hard block.** A stance you rejected
  in another project surfaces as a "you avoided this elsewhere — still want it
  here?" nudge you can promote to a hard block by rejecting it locally; only a
  rejection in *this* project hard-blocks. A single-word concept can't hard-block
  ordinary prose (it needs an exact concept match).
- Added instrumentation of near-misses / gate-escapes so any future semantic
  matching is data-driven.

### Docs
- Front-page honesty pass: the moat is described accurately (the match is on the
  concept's words, not arbitrary synonyms), demo-first quickstart with install
  detail moved to INSTALL.md, refreshed screenshots incl. the enforcement moment,
  and a committed capture flow that keeps the screenshots from rotting.


## v0.1.1 — 2026-07-05

Field-driven patch release: fixes and one small feature from the first real
pairing sessions after v0.1.0. No breaking changes.

### Added
- **Reply composers can ask a follow-up question** — a Comment/Ask toggle on
  the rail and line-comment reply boxes; a question-reply re-flags the thread
  as awaiting the agent. The unanswered-question signal now counts a human
  question asked anywhere in a thread (not only at its root).

### Fixed
- **Marketplace/plugin installs now ship the enforcement hooks** — the
  PreToolUse rejected-approach gate + the Stop review checkpoint travel with
  the plugin (`hooks/hooks.json`), so "stopped before the edit lands" holds on
  the marketplace path, not just `deeppairing init`. The hook only ever asks
  (never hard-blocks) and fails open on every error.
- **The companion UI URL is pushed, never guessed** — the live daemon port is
  surfaced in the first-call preamble and every `check_feedback` response, so
  the agent stops hallucinating `localhost:5173`.
- **The daemon releases its listen socket promptly on shutdown** —
  SIGTERM/idle/evict now close the HTTP server before the flush, freeing the
  port for the next daemon (fewer EADDRINUSE stalls on restart/doctor).
- **Tests can no longer write the developer's real `~/.deeppairing` ledger** —
  a global-store guard isolates every test; a stray unit test had polluted the
  cross-project ledger with 222 phantom "Railway" rejections.

### Docs / internal
- README front-door already shipped in v0.1.0; refreshed the screenshots to the
  current Ledger UI, and the capture flow now runs in CI as a
  selector-integrity check so it can't rot silently.
- Web-dom contention test-timeout tuning; e2e daemons isolated to a temp HOME.


## v0.1.0 — 2026-07-04

First public release. deepPairing is an MCP server + companion web UI that
turns Claude Code into a pairing partner: structured artifacts for findings,
options, plans, and code changes; a cross-project Philosophy Ledger that
remembers your rejections and blocks re-proposals before the edit lands.

### Highlights
- **12 MCP tools + a 13th (`update_plan_progress`)** — non-blocking present/check_feedback loop; the agent presents, you review in the UI, it picks up your verdicts.
- **Decision cards** — options with pros/cons/effort/risk, concept naming, optional prediction + confidence capture on high-stakes calls, and ✓/✗/◐ retrospectives that build a calibration record.
- **The Ledger** — cross-project taste (`~/.deeppairing/philosophy/v1.json`), a PreToolUse gate that stops rejected concepts pre-edit, weekly digest, and a compounding badge.
- **Live plan checklists** — step-by-step progress streamed over WebSocket while the agent executes.
- **Session replay** — command palette → "Browse past sessions (replay)"; scrubber, annotations, and a read-only store guard so history can't be mutated.
- **Multi-project** — deterministic per-project daemon ports (3847–3974, hash-derived), a project switcher with pending counts, and cross-session owner routing so verdicts land in the right session's store.
- **Keyboard-first review** — j/k/n navigation, armed-countdown approvals (never one-keystroke commits), q to ask, Escape everywhere it should work.
- **Accessibility** — axe gate in CI with zero disabled rules, both themes AA, focus management on teardown paths, a real `<main>` landmark.
- **Distribution** — self-contained committed plugin bundle (marketplace or `--plugin-dir`, no build), `deeppairing` CLI (`init` / `doctor --fix` / `demo` / `export`), VS Code webview extension.

### Engineering posture
- 1,636 tests (1,518 server+web / 118 shared) + Playwright e2e incl. a live axe net
- TypeScript strict + `noUncheckedIndexedAccess` across all packages; `rules-of-hooks` as a lint error
- ESLint warning ratchets (lower-never-raise); CI staleness gate keeps the committed plugin bundle honest
