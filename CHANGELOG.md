# Changelog

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
