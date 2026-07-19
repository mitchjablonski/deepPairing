# deepPairing Architecture

> Last updated: 2026-07. For day-to-day project conventions see
> [CLAUDE.md](../CLAUDE.md). For research notes from project inception see
> [research-brief.md](research-brief.md) (historical, not current).

## One-paragraph summary

deepPairing is an **MCP server + companion web UI** that runs inside
Claude Code. Claude Code IS the agent — deepPairing is the *protocol +
review surface* that turns one-shot tool calls into pair-programming.
Findings, decisions, plans, and code changes go through structured
artifacts that the human reviews in a local web UI; every rejection
becomes a typed entry that this project's pre-flight gate hard-blocks
before the agent can paraphrase past you. If the project has opted in
to publish (one prompt at `init`, default OFF), the rejection also
mirrors into a cross-project Philosophy Ledger — which other projects
surface as an **advisory** nudge, never a hard block.

## Process model

```
┌──────────────────┐       stdio (MCP)        ┌──────────────────────┐
│   Claude Code    │ ◄──────────────────────► │  MCP server wrapper  │
│  (IS the agent)  │                          │   (per-session,      │
└──────────────────┘                          │    src/standalone.ts)│
                                              └──────────┬───────────┘
                                                         │ HTTP
                                                         ▼
┌──────────────────┐    HTTP+WS    ┌────────────────────────────────┐
│ Companion web UI │ ◄───────────► │   deepPairing daemon           │
│ localhost:<port> │ deterministic │   (one per project, on a       │
│ (React + Vite)   │  per-project  │    deterministic port —        │
└──────────────────┘   port        │    multi-session)              │
                                   │   src/daemon/index.ts + http/        │
                                   └────────────────────────────────┘
                                                         │
                                                         ▼ FileStore
                                            ┌────────────────────────┐
                                            │  <project>/.deeppairing/│
                                            │  ~/.deeppairing/        │
                                            │  (JSON files)           │
                                            └────────────────────────┘
```

Three processes:

- **Claude Code** is the LLM client. It speaks the Model Context
  Protocol over stdio.
- **MCP server wrapper** (`src/standalone.ts`) — one per Claude Code
  session. Implements the 14 MCP tools (see below). Talks to the
  daemon over HTTP for state read/write so multiple sessions share a
  single source of truth.
- **deepPairing daemon** (`src/daemon/index.ts`) — one per project, bound to
  a deterministic per-project port in the `3847-3974` range (hash of the
  project path, mod the span — not allocation-ordered; the actual bound
  port is recorded in `.deeppairing/daemon.json`). Owns the
  HTTP+WebSocket server, the per-session FileStores, and the global
  Philosophy Ledger. Auto-shuts down ~60s after the last session
  unregisters and the last UI client disconnects.

This split was the X-series refactor. Pre-X, every wrapper ran its own
HTTP server and the companion UI couldn't see other sessions. Post-X,
one daemon per project is the single owner; wrappers register sessions
with it and DaemonClient (`src/daemon/client.ts`) implements `IStore`
over HTTP so the same code paths work in standalone or daemon mode. The
companion UI can aggregate across several projects' daemons.

## The MCP tool surface (14 tools)

Tools live in `packages/mcp-server/src/mcp/tools/` and are registered
in `src/mcp/server.ts`. The split:

**Present-* tools** (creates a draft artifact, broadcasts to UI):
- `present_findings` — research artifact with structured evidence
- `present_options` — decision artifact, prompts human to pick
- `present_spec` — requirements/acceptance criteria
- `present_plan` — multi-step implementation plan
- `present_code_change` — before/after diff with reasoning

**Polling**:
- `check_feedback` — long-poll up to 30s, returns new comments,
  decision picks, plan verdicts. Optional `waitFor` enum scopes the
  wake condition.

**Execution**:
- `update_plan_progress` — mark plan steps in_progress / done / skipped
  while executing an approved plan (live checklist in the UI)

**Memory + memory queries**:
- `recall` — search `mode='philosophy' | 'sessions' | 'ledger' | 'any'`
  with optional `stance` and `source` filters
- `log_reasoning` — record agent reasoning (low-stakes journal entry)
- `revise_artifact` — supersede, retract, or obsolete a prior artifact

**Side-channel**:
- `answer_question` — agent reply to a human question on an artifact
- `post_pr_review` — push approved findings as inline comments to a PR
- `export_session` — markdown export (`pr-description` / `pr-comments` /
  `adr` / `full` / `replay` / `learnings`)
- `get_companion_url` — read-only: report this project's companion UI
  port + URL so the agent can hand the human the exact review-surface
  URL (shares the CLI's `deeppairing port` / `status` resolver)

Tool calls return prose `content`; `check_feedback` additionally ships a
machine-readable mirror (`outputSchema` + `structuredContent`) so clients
can branch on `status` / `suggestedAction` instead of prose-parsing. The
companion UI subscribes to WebSocket broadcasts for
artifact_created / comment_added / decision_resolved / etc. so the
review surface stays live without HTTP polling.

## Pre-flight as the protocol gate

The defensible primitive. Every `present_*` call goes through
`runPreflight` (`src/mcp/preflight-validator.ts`) BEFORE the artifact
is created. The matcher reads:

- This session's `rejectedApproaches` (from `getSessionMemory`)
- Team rules from `<project>/.deeppairing/team.json` (via
  `getTeamPreferences`, with optional path-glob scope)

A match returns `REJECTED_APPROACH_BLOCKED` from the tool — the
artifact is never created. These two local sources are the only
hard-block authority: cross-project 'avoid' stances from the global
ledger enter `runPreflight` as advisory-only input and surface as
near-miss nudges ("you avoided this in `<project>` — still want it
here?"), never a block. Near-misses (≥50% token coverage, short of a
full match) get recorded in a sidecar trace so the breadcrumb in the UI can render
"Almost flagged this — your past stance on X is adjacent."

This used to be voluntary: the gate only fired when the agent
*announced* intent through a `present_*` tool, so a direct `Edit`/`Write`
sailed past it. A **PreToolUse hook** (`src/cli/preflight-hook-core.ts`,
installed into `.claude/settings.local.json` by `src/cli/setup-tasks.ts`)
now runs the *same* `runPreflight` matcher against the actual tool call
and surfaces a match for the human's decision — so skipping the protocol
no longer skips the gate. The hook fails open (a broken hook never blocks
an edit) and short-circuits cheaply when there are no rejections seeded.

## Persistence layout

```
<project>/.deeppairing/
  sessions/
    <session_id>/
      artifacts.json              # Findings, decisions, plans, code-changes
      comments.json               # Human ↔ agent inline comments
      decisions.json              # Resolved + pending decision records
      plan-reviews.json           # Plan approval verdicts
      preflight-traces.json       # Sidecar: what stances were considered
      annotations.json            # Per-artifact UI annotations
      session.json                # Session metadata + autonomy level
      retrospectives.json         # P2 calibration outcomes
  team.json                       # Team-shared rules (commit to git)
  metrics.json                    # Local engagement counters
  hooks-state.json                # Stop-hook fire log
  daemon.json                     # Per-project daemon liveness (pid, port, projectRoot)

~/.deeppairing/
  philosophy/v1.json              # Cross-project Philosophy Ledger

$XDG_RUNTIME_DIR/deeppairing/     # (POSIX hosts where .deeppairing can't hold 0600)
  <projectHash>.json              # Bearer-token sidecar, mode 0600 — see daemon/token.ts
```

All writes go through `writeJsonAtomic` (`.tmp.PID.TS.RAND` +
`renameSync`) so a SIGKILL mid-write cannot corrupt the JSON store.

## The Philosophy Ledger (the moat)

`~/.deeppairing/philosophy/v1.json` is the single cross-project file.
Schema is an append-only log of `PhilosophyInstance` entries keyed by
normalized concept (lowercased, whitespace-collapsed). Stance
(`avoid` / `prefer` / `mixed`) is *derived* from the rejection vs
approval count, not stored — so a concept's stance can flip as the user
re-evaluates without losing history.

Manually-seeded entries (via `POST /api/philosophy/seed` or the UI's
SeedAffordance) carry `project: "manual"` so they're distinguishable
from session-driven entries. Caps: ≤50 lines, ≤16 KiB UTF-8 per POST.
Re-seeding an identical (concept, verdict) is permanently idempotent —
the deterministic `("manual", "seed")` shape dedupes without the II6
time window.

Stances are removable first-class (`POST /api/philosophy/remove`, the
✕ on a stance row in the Ledger drawer, or
`deeppairing philosophy remove <concept>`): the whole concept entry is
deleted, after the ledger is snapshotted to a fresh `.removed-<ts>`
backup (one per removal) so the surgery is reversible.

Demo sessions (`demo_` prefix, minted by `POST /api/demo/run`) never
write the ledger — or the project's `preferences.json` — at all; the
demo's example stance is served to the drawer/digest from the demo
session's in-memory state.

The ledger is the only structurally cross-project surface. Every
session can query it via `recall(mode='philosophy' | 'ledger')` and
the daemon's `/api/ledger/digest` aggregates it for the UI.

Writes are **opt-in per project** (`globalLedgerPublish` in
`.deeppairing/preferences.json`, default OFF — one prompt at `init`,
flip later via `deeppairing philosophy publish on|off`); reads are
always on. Cross-project matches are advisory nudges in preflight,
never hard blocks — only the local project's rejections and team
rules block.

## Companion UI

```
packages/mcp-server/web/
  src/
    App.tsx
    components/         # ArtifactPanel, DecisionCard, LedgerPanel, etc.
    stores/             # Zustand: artifact, connection, ledger, toast, ...
    lib/                # connection-adapter, api, comment-anchor
    hooks/              # useFocusTrap, useHighlightedCode, ...
```

React + Vite + Tailwind + Zustand. WebSocket connects on mount; HTTP
goes through `safeFetch` in `lib/api.ts` with structured `ApiError`
typing. Project-hash binding (`X-Project-Hash` header + `?projectHash=`
WS query) defends against stale-tab routing across daemon restarts.

The drawer (`YourTasteDrawer.tsx`) carries the four ledger surfaces:
Stances, Ledger digest, This week (digest), Team. The cold-start home
(`IdleHome.tsx`) defaults to the Ledger view + a SeedAffordance when
no artifacts exist yet.

## Security model

See [SECURITY.md](../SECURITY.md). Short version: the daemon binds
`127.0.0.1` only, the WS upgrade enforces Origin + project-hash, and
all HTTP routes go through the AA4 X-Project-Hash middleware. The
threat model assumes the host machine is trusted — malicious npm
packages in your project's dep tree can read `.deeppairing/sessions/`
directly off disk.

## Testing posture

- **Fakes not mocks** (per CLAUDE.md). FileStore in `:memory:` mode
  for fast tests; full HTTP integration tests for the daemon-routes
  surface.
- **Atomic suite**: `pnpm --filter @deeppairing/mcp-server test`
  (1,800+ tests).
- **Component tests** in `web/src/components/__tests__/` use happy-dom
  via the workspace vitest config; pure tests run in node.

## Where to look first

| Task                              | Start here                                              |
|-----------------------------------|---------------------------------------------------------|
| Add a new MCP tool                | `src/mcp/tools/` (mirror the `present-*.ts` pattern)    |
| Change the preflight matcher      | `src/mcp/preflight-validator.ts`                        |
| Wire a new HTTP route             | `src/http/routes.ts` or `src/daemon/routes.ts`          |
| Add a UI surface                  | `web/src/components/` + a Zustand store in `web/src/stores/` |
| Change the global ledger          | `src/store/global-store.ts` + `routes.ts:/api/ledger/*` |
| Surface a WS event to the UI      | `src/daemon/index.ts` broadcast + `web/src/stores/connection.ts` switch |

## Schemas live in `packages/shared`

Zod schemas in `packages/shared/src/schemas/` are the single source of
truth for `Artifact`, `Comment`, `Evidence`, `Finding`, etc. Both the
MCP server and the companion UI import from `@deeppairing/shared`. New
fields must be optional for back-compat (per CLAUDE.md).

## Roadmap notes

- **MCP SDK v2** — the spike verdict is **GO** for a ~2-4 day legacy-parity
  port once v2 stabilizes. Details, adoptions needed, and the refuted
  upstream-issue candidates are recorded in
  [docs/sdk-v2-spike.md](sdk-v2-spike.md).
