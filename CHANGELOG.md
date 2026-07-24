# Changelog

## v0.1.19 — 2026-07-23

The field-day release. Three rough edges the user hit while actually *using* the
product — polish and honesty from real use. A bad diagram no longer leaks
Mermaid's own error-graphic bomb to the bottom of the page; a tab whose daemon
restarted underneath it stops half-working in silence and tells you to reload;
and a truncated tool call now names its real cause instead of teaching the agent
to echo the validation example back as junk artifacts. No schema change — every
fix is read-side or in the shared validation chokepoint, and an old daemon
degrades gracefully.

### Fixed
- **A broken diagram no longer leaks Mermaid's own error graphic.** When an
  agent-authored diagram has a syntax error, Mermaid v11 rendered its *own*
  "Syntax error" bomb graphic into a temp node appended to `document.body` and
  threw *before* removing it — so the error diagram leaked to the bottom of the
  page even though `MermaidDiagram` already catches the throw, shows a clean
  "Couldn't render… showing the source" fallback, and reports the failure back
  to the agent (#176). Adding `suppressErrorRendering: true` to the
  `mermaid.initialize(...)` config makes Mermaid throw *without* drawing the
  bomb (and self-clean its temp node first); the existing catch + fallback +
  #176 report path is unchanged, and `securityLevel: "strict"` sanitization plus
  the repair pass are untouched. A belt-and-suspenders orphan cleanup on both
  terminal catch paths removes any stray temp render node (`#d<id>` wrapping
  `#<id>`), scoped to the exact `dp-mmd-*` id this component minted, should a
  future Mermaid change leave one behind. The clean fallback and the agent
  report are the only two surfaces now — pinned by a real-Mermaid e2e in both
  themes that asserts no `.error-icon` node survives at `document.body`.
- **A tab whose daemon restarted underneath it now tells you to reload.** When
  the daemon restarts under an open companion tab, the tab looks alive — the WS
  reconnect loop reattaches to the new process, so reads and live broadcasts
  keep flowing — but two things are silently stale that only a hard reload
  fixes: the bearer token minted at page load (the new process re-minted it, so
  every **write 401s** with a raw "Authorization required" error — the user hit
  this on mark-file-reviewed) and the JS bundle itself. The tab now shows **one
  persistent, dismissible "Daemon restarted — reload this tab" toast with a
  Reload button** — on both the WS-reconnect path (a *new* `daemonStartedAt`)
  and the 401-on-write path (gated behind an authoritative `/api/daemon-info`
  identity check, so only a *confirmed* restart swaps the raw auth error). A
  genuine permissions error keeps its own message; sleep-recovery to the *same*
  daemon stays silent; the toast fires once per restart (deduped across both
  paths) and never collides with the project-hash-mismatch toast. No auto-reload
  — an unsaved composer draft must survive. Server-side unchanged: the WS
  `connected` frame already carries `daemonStartedAt` and `/api/daemon-info`
  already returns `startedAt`.
- **A truncated tool call names its real cause instead of teaching the agent to
  echo the example.** In a real session an agent's `present_options` call failed
  schema validation; the `INPUT_VALIDATION_FAILED` message embeds a minimal
  teaching **example** (`"context": "Which cache layer?"`, options Redis /
  In-memory LRU), and the confused agent echoed that example **verbatim as a
  real call, twice** — minting junk "Which cache layer?" draft decisions in the
  user's real session. A spike proved there is **no** server-side size cap
  (contexts to ~60KB pass; only the 64KiB body cap trips, with a clear
  `PAYLOAD_TOO_LARGE`) — the field failure was an **upstream-truncated** tool
  call whose `context` streamed before `options`, so args arrived with `context`
  present but `options` absent → a generic Zod error the agent misdiagnosed *and*
  echoed. Two guards now live in the shared per-tool validators
  (`validate-tool-input.ts`), belt and suspenders: (a) a dedicated
  **`TOOL_CALL_TRUNCATED`** error fires when a required array is absent while a
  scalar the schema streams *before* it is present (`present_options`,
  `present_findings`) — and it embeds **no** example on that burned path; and
  (b) an **`EXAMPLE_ECHO_REJECTED`** guard bounces any verbatim replay of a
  teaching example (exact / trim / case only — never fuzzy), fingerprinted by
  `JSON.parse`-ing the example constants so it can't drift. After an adversarial
  review executed four false positives, the matchers are tightened so a match
  always **requires the distinctive scalar** (context / summary / title) and
  item-sets only narrow, never suffice alone — so a real decision whose options
  happen to be titled Redis / In-memory LRU, or a real "Weak password hash"
  finding, or a real "Add rate limiting" plan, is always admitted. Both codes
  are retryable and registered; `revise_artifact` is covered for free through
  the same validators.

## v0.1.18 — 2026-07-22

The stale-signal shows everywhere a carried comment does. A fast-follow to
v0.1.17: the CARRIED/STALE/ORPHAN carryover markers that answer *"the agent
changed this — does your comment still apply?"* now render on the **default**
decision surfaces, not only the Discuss workbench. Before this, a carried
decision comment on the inline card showed with just a generic "from v1" chip and
the stale-signal was hidden unless you opened Discuss. No schema change — the
signal is derived read-side and an old daemon degrades gracefully.

### Fixed
- **Carryover markers render wherever a carried decision comment does.** The
  CARRIED (green — part still live, text unchanged), STALE (amber — the part
  survived but the agent changed the words), and ORPHAN (red — the option is gone
  from v2) badges shipped in v0.1.17 only inside the Discuss workbench, yet a
  decision's carried comments also surface on the inline **DecisionCard**, the
  **OptionCard**, and the **ArtifactPanel** decision "Comments" view — where they
  wore only a generic "from vN" chip that buried the "your comment may be stale
  now" signal. The same honest badge now shows on all of them: a per-option
  aggregate badge on `OptionCard`, a new lazy `DecisionGeneralComments` view in
  the ArtifactPanel, and inline via the DecisionCard's option cards. `CommentThread`
  gained an optional `carryoverFor` prop — when a comment carries, the richer badge
  renders and the generic "from vN" chip is suppressed; the workbench doesn't pass
  it, so its rail is byte-unchanged. Pro/con threads stay deliberately uncertain
  (STALE, never a confident green) in the new surfaces too. Decision-only; no
  other artifact type is touched.

### Changed
- **`computeCarryover` and `CarryoverBadge` are now a single shared source.** Both
  were extracted verbatim out of `DecisionWorkbench` into `decision/carryover.ts`
  and `decision/CarryoverBadge.tsx`, which the workbench now re-imports with
  behavior byte-unchanged, so every default surface and the workbench compute the
  marker from one implementation. A single-source identity test fails any future
  fork.

## v0.1.17 — 2026-07-22

The loop stays honest across change. Two follow-ups that keep the human↔agent
conversation truthful when the thing under discussion moves: a diagram that
**reports back when it breaks** — instead of the agent never learning its
Mermaid render failed — and decision-comment threads that **follow a tune** from
v1 to v2 with a plain read-side marker for whether your comment still applies. No
breaking changes — every new field is optional and an old daemon degrades
gracefully.

### Added
- **A broken diagram reports itself back to the agent.** The companion UI is the
  one place a version-matched Mermaid render actually runs, so when a decision or
  plan diagram genuinely fails to render — *after* the existing #163 client
  repair pass has also failed — the browser now POSTs a lightweight failure
  report (`artifactId`, `visualId`, a short `error`, the `title`) so the agent
  finds out. It **never sends the Mermaid source** (a secret can hide in a node
  label), and the store authoritatively secret-scans and redacts the error and
  title before persisting. `check_feedback` surfaces pending render failures in
  prose and in `structuredContent.renderFailures` (spread only when present, so
  the healthy-payload contract is untouched) so the agent is told to fix and
  re-present. Reports drain once, clear when the artifact is superseded, and a
  re-arm guard keeps a remounted still-broken diagram from re-nagging — a
  verify-*after* belt, since a prior spike proved verify-before on the stdio path
  infeasible.
- **Decision-comment threads follow a tune, with a marker for whether they still
  apply.** When the agent tunes a decision (`revise_artifact` supersedes v1→v2),
  your grain-comment threads now carry to the matching part of v2 and each one
  wears an honest read-side badge: **CARRIED** (green — the part is still live and
  its text is unchanged), **STALE** (amber — the part survived but the agent
  changed the words: "does your comment still apply?"), or **ORPHAN** (red — the
  option is gone from v2, shown as "from v1 · no longer in this decision" instead
  of a raw id). The decision question carries unconditionally; question,
  whole-option, and summary grains carry reliably. This rides a new stable-option
  -id convention — a `KEEP IT ACROSS REVISIONS` note on the option id plus a
  `SKILL.md` line telling the agent to reuse each surviving option's id when
  superseding, mirroring the shipped `PlanVisual.id` pattern. Pro/con threads are
  deliberately shown as uncertain (never a confident CARRIED) across versions —
  reliable pro/con carryover is deferred to slice 2b behind a `pros/cons →
  {id,text}` schema change.

### Fixed
- **Aggregated-thread chips now meet AA contrast.** The new carryover axe scan
  caught a latent sub-AA contrast in `CommentThread`'s `from vN` and `delivered`
  chips on an elevated surface (3.54 / 3.44:1); dropping the `/80` and `/70`
  opacity restores full `text-muted` and `accent-blue` (≥4.7:1) in both themes,
  with no token changes and zero disabled rules.

## v0.1.16 — 2026-07-21

The decision discuss workbench. A decision's options used to be readable only
one-at-a-time in the card; now a single **💬 Discuss** affordance opens a focused
workbench that lays them out **side-by-side as columns** and makes every part
commentable at its own grain — a specific pro, a con, an option's summary, the
whole option, or the decision question itself. Pop one option out to focus it
full-width when you want to go deep. No schema change — the workbench anchors on
the decision comment targets already in the schema, and an old daemon degrades
gracefully.

### Added
- **Expand a decision to a discuss workbench.** The inline decision card stays
  clean — one **💬 Discuss** affordance (with a comment count once threads
  exist), out of the option grid so it's misclick-safe. It opens a focused
  workbench that lays the options out **side-by-side as columns** — each with its
  summary, pros/cons, effort/risk chips, concept, and diagram — where **every
  part is commentable at the right grain**: hover the 💬 (or click the row) on
  any pro/con, an option's summary, the whole option, or the decision question,
  and a rail hosts the thread with a Comment/Ask composer. Threads anchor via the
  decision comment targets already in the schema (`optionId` + `sectionId`), so
  there's no schema change; decision-level actions (choose / reject / send-back)
  reuse the same `DecisionFooter` the card threads, and an option's diagram opens
  the region-comment focus view unchanged. `check_feedback` now names the option
  part a grain comment anchors to (a specific pro/con, the summary, or the
  question) so the agent reads a comment at the grain you left it.

### Changed
- **Pop out to focus one option, or keep the whole grid in view.** A per-option
  **⤢ pop-out** focuses a single option full-width in place, with a persistent
  whole-option comment/ask composer below it; **← Back to all options** returns
  to the compare grid, and Esc is layered (pop-out → grid → close the
  workbench). The comment rail now stays collapsed until there's actually a
  discussion — the options get the full width until you start one — and the
  surface widened to 1280px to hold the columns. The discuss composer is an
  opt-in roomy mode (taller, resizable, `text-sm`, readable bubbles) that leaves
  the ~10 other comment call sites dense and unchanged.

## v0.1.15 — 2026-07-20

The review lane, made rich and bidirectional. A change that spans many files is
now reviewed as one unit, the human can propose concrete code that the agent
must answer, decision diagrams take region comments, and the changeset review is
keyboard-first. No breaking changes — every new schema field is optional and an
old daemon degrades gracefully.

### Added
- **Multi-file changesets are reviewed as one artifact.** A change spanning 2+
  files is no longer scattered across single-file `code_change` cards — a new
  `changeset` artifact (and a 15th MCP tool, `present_changeset`) presents it as
  a single unit: a file rail with per-file M/A/D marks and diffstat bars, a
  per-file unified-diff pane reusing the existing inline-comment machinery,
  cross-file comment anchors that thread a single thought across files, and risk
  chips on the summary. Rejecting the changeset flows through the one-framing-
  entry gate (no per-file fan-out), and `check_feedback` reports it with the
  same "Do NOT apply" posture every rejected type gets. `code_change`
  (single-file) is unchanged and coexists.
- **The human can suggest concrete edits — and the agent must answer.** A new
  suggested-edit lane: select lines, propose replacement code (with an optional
  "why" that teaches the ledger), and the agent is required to respond via
  `check_feedback` — apply verbatim, apply-with-extension, or counter with a
  reason. A countered suggestion gives you Take-the-counter or Insist-on-mine
  (insist makes your version authoritative and tells the agent to apply exactly,
  not re-argue). Suggestions are first-class state (pending / applied / countered
  / insisted) with a state pill and a mini unified diff on the card; an
  applied-with-why and an insist both record to the ledger.
- **Comment on a region of a decision diagram.** A decision option's diagram can
  now be commented on by dragging out a specific region in a focused view — the
  comment anchors to `optionId` + `visualId` + `region` and survives a
  re-render by matching on the labels of the nearest nodes rather than raw
  coordinates.

### Changed
- **Changeset review is keyboard-first, with a per-file disposition.** Each file
  gets a **Looks right** (✓) / **Needs changes** (↻, captures a reason)
  disposition (the earlier "skip" is gone), and the whole-changeset action is
  *derived* from them: all look-right → **Approve changeset**; any flagged →
  **Send back N** (only the flagged files, with their reasons, go back through
  revision — the rest are accepted). A central keymap (`a`/`r`/`j`/`k`/`⏎`/`⇧⏎`),
  live only while a changeset is focused, drives triage with auto-advance; a
  reused 3-2-1 confirm-countdown arms the approve when every file reads
  look-right; `?` shows a cheat-sheet rendered straight from the keymap; and a
  "Review all" toggle stacks every file's diff in one scroll.

### Fixed
- **Region drags cover the whole diagram well.** The region-selection overlay
  was sized to the SVG box, but the well centers a narrow diagram with wide
  gutters — so the visible (darkened) border and the draggable area disagreed
  and you couldn't start a drag in the gutter. The overlay now spans the whole
  well (`inset-0`) and a gutter-started drag clamps to the diagram's edge.

The first-impressions release: the batch from the new-user journey audit. The
demo survives a cold start, the gate fires from its most natural trigger, no
command dead-ends into a wrong repo, and the cross-project ledger is yours to
prune. No breaking changes.

### Added
- **The cross-project ledger is now yours to prune.** There was no first-class
  way to remove a stance — you had to hand-edit the JSON. Now every stance row
  in the Ledger drawer carries a ✕ that arms an inline confirm (telling you
  exactly how many recorded instances across your projects it will delete), and
  `deeppairing philosophy remove <concept>` does the same from the terminal.
  Either path writes a timestamped ledger backup *before* the first removal and
  refuses if that backup can't be written, and prints the
  `philosophy import <backup> --merge` incantation to restore.
- **The block moment persists past its toast.** When the pre-flight gate fires,
  a new session-scoped header chip + popover keeps the record — what was
  blocked, the concept, the prior reason, and when — instead of the moment
  vanishing with the 12s toast.

### Fixed
- **Rejecting a decision now arms the gate — the signature loop fires from its
  most natural trigger.** A whole-card "none of these, I reject this framing"
  reject used to record *nothing*: the ledger only learned option concepts when
  you *picked* one, so a re-proposal of the rejected framing sailed straight
  through. Now a card reject records each presented option's concept with your
  reason, and `check_feedback` gives a rejected decision the same "Do NOT apply
  / address the rejection" posture every other rejected type gets — no more
  reporting the rejection while simultaneously saying "You may proceed with
  implementation."
- **The demo survives a cold start.** Four cold-start bugs made a first
  `deeppairing demo` fail-then-work, hang the terminal, print a URL that died
  in ~60s, or miss its own hero moment. Fixed: readiness now waits up to 40s
  with a progress line (a cold 9P boot no longer reads as a freeze and times
  out early); the CLI exits cleanly instead of hanging on the detached child's
  pipe; a demo-aware idle grace keeps the daemon alive ~10 min so the printed
  URL still works; and the hero `preflight_blocked` moment is replayed to a tab
  that opens after it fired. Timeout errors now report this project's *actual*
  probed port range and a command that actually runs.
- **The demo never touches your real ledger.** A demo run walked its scripted
  rejection through a real store on your real project root — polluting
  `~/.deeppairing`'s cross-project ledger (non-idempotently: six runs left six
  duplicate instances the advisory tier later cited as real taste) and arming
  your local pre-flight gate with demo-fiction. Demo sessions now keep
  preferences purely in memory and never hit the ledger mirror sites;
  `preferences.json` and the ledger stay byte-identical. The drawer opened from
  a demo tab still *shows* the example stance, via an in-memory overlay that
  never persists.
- **No command dead-ends anymore.** Every `npx deeppairing …` suggestion —
  in strings, docs, the web UI, and comments — resolved to an npm placeholder
  that exits 1 with a wrong repo URL, a hostile first impression for anyone
  copy-pasting it. All rewritten to the path form that actually runs, with a
  grep-guard test so they can't creep back.
- **The rejection gate is live from session one.** `init` claimed to install
  the PreToolUse rejection-gate hook but didn't — it only arrived at first
  daemon start. `init` now writes all three hooks, so the concept-rejection
  gate protects you from the first session, not the first daemon boot.

### Internal
- **Manual-seed idempotency.** The ledger's deterministic manual-seed shape now
  permanently dedupes on (concept, project, seed, verdict) — genuine
  cross-session rejections and opposite-verdict re-seeds still append.
- **A protocol-blind agent gets onboarded even when its first calls fail.** A
  short pointer line now rides `INPUT_VALIDATION_FAILED` responses while the
  onboarding latch stays armed, so the full protocol still rides the first
  *successful* call.
- **`doctor` gains a PreToolUse check** (and drops the plugin-redundant row),
  so a missing gate hook is diagnosable.

### Docs
- **Troubleshooting entries for the cold-start reality.** New guidance for the
  `daemon did not become ready within …ms` cold-boot on 9P/network
  filesystems, the Claude Code MCP startup timeout on `/mnt/c` (`MCP_TIMEOUT`),
  and the "plugin loads but no daemon" symptom.
- CLAUDE.md now documents the required `Finding.significance` field (both
  `significance` and `impact` exist; the required one was missing).

## v0.1.13 — 2026-07-18

Code you can read, secrets that can't slip through. No breaking changes.

### Fixed
- **Light-mode code is readable again.** An accessibility audit of the syntax
  palettes found 20 token colors below the AA contrast floor on code
  backgrounds — light-mode comments were the worst at 2.14:1, with strings,
  punctuation, JSON keys, and more also failing; even dark mode had four
  offenders. Every one is re-tinted to ≥4.6:1 with its hue preserved (the
  palette still reads as vitesse), pinned by a test that runs the real
  highlight pipeline across all 13 grammars, and the accessibility scans now
  exercise real multi-line code in both themes so palette drift can't return
  silently.

### Internal
- **The secret scanner is now un-bypassable on every write path.** Artifact
  content is scanned authoritatively inside the store at create time (matching
  how comments already worked) — client-supplied warnings can neither forge nor
  suppress the result — and the one previously unscanned content-mutation path
  (plan progress notes) is covered. One scan per artifact; the warning banner,
  sidebar marker, and agent signal are unchanged.

## v0.1.12 — 2026-07-18

Every feature in this release came from live pairing feedback — asked for in
the tab, built, felt, and refined in rounds. No breaking changes.

### Added
- **A new artifact shows you where it landed.** A card that arrives live gets a
  brief glow in the sidebar — and if it lands outside your scroll view, a small
  pip points the way, jumping there only when you click. Your scroll is never
  moved for you, nothing glows on load/reload/replay (initial population and
  cross-session backfill are absorbed silently), screen-reader users get a
  polite announcement, and reduced-motion gets a static ring.
- **`deeppairing port` and `deeppairing status`.** Instantly find the daemon's
  port and companion URL for any project — `!deeppairing port` from inside a
  Claude Code session prints just the number (scriptable), `status` gives the
  full picture (URL, pid, version, alive). Robust from subdirectories (walks up
  to the nearest `.deeppairing`), never adopts another project's daemon on a
  recycled port, and survives hostile `daemon.json` contents. The agent can
  answer too: a new `get_companion_url` MCP tool (the 14th) reports this
  session's actual daemon.
- **Open questions are now answerable in place.** Each question is its own
  section with the answer box just *there* — type and hit Answer (⌘⏎), or Ask
  to send it back to the agent as a question; replies thread directly under
  the question they answer. The old cramped row with tiny icons and a popover
  is gone. Shaped by two live refinement rounds.

### Fixed
- **Modal panels are solid again.** The project-decisions and session-browser
  modals used a color token that was never defined, so their panels rendered
  transparent over the blurred backdrop — near-invisible in dark mode,
  translucent grey in light. Both now use the solid surface other dialogs use,
  and a new design-token integrity test fails the build if any surface/accent
  class references an undefined token.
- **A question-targeted answer no longer appears twice** (inline under its
  question and again in the general comments).

### Docs
- **The README shows what the prose promises.** Refreshed screenshots at 2×,
  including the surfaces that had none: region-anchored diagram comments (the
  hero), the project-wide decisions view (re-shot after the modal fix), and
  the detail-density dial — all captured from the real rendered app by the
  CI-run spec that guards the selectors against rot.

### Internal
- **Local test runs are trustworthy again.** Test-spawned daemons now derive
  ports outside the product's 3847–3974 window (per-worker isolated spans), an
  aborted run can no longer leak fixture processes (120s TTL + forward-probe),
  hardcoded-port suites use kernel-assigned ports, and spawn budgets absorb
  measured WSL latency. The flake class that produced phantom failures on dev
  machines with live daemons is structurally closed.
- Secret-scanner test fixtures are assembled at runtime so the repo's own
  source never contains token-shaped strings (our fixtures were tripping
  GitGuardian); detection coverage unchanged.

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
