# deepPairing Architecture

> Last updated: 2026-05. For day-to-day project conventions see
> [CLAUDE.md](CLAUDE.md). For research notes from project inception see
> [RESEARCH.md](RESEARCH.md) (historical, not current).

## One-paragraph summary

deepPairing is an **MCP server + companion web UI** that runs inside
Claude Code. Claude Code IS the agent — deepPairing is the *protocol +
review surface* that turns one-shot tool calls into pair-programming.
Findings, decisions, plans, and code changes go through structured
artifacts that the human reviews in a local web UI; every rejection
becomes a typed entry in a cross-project Philosophy Ledger that future
sessions match against before the agent can paraphrase past you.

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
│ localhost:3847   │  port 3847    │   (one per host, not per       │
│ (React + Vite)   │               │    project — multi-session)    │
└──────────────────┘               │   src/daemon.ts + http/        │
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
  session. Implements the 13 MCP tools (see below). Talks to the
  daemon over HTTP for state read/write so multiple sessions share a
  single source of truth.
- **deepPairing daemon** (`src/daemon.ts`) — one per host. Owns the
  HTTP+WebSocket server on port 3847, the per-session FileStores, and
  the global Philosophy Ledger. Auto-shuts down when no clients have
  been connected for ~5 minutes.

This split was the X-series refactor. Pre-X, every wrapper ran its own
HTTP server and the companion UI couldn't see other projects. Post-X,
the daemon is the single owner; wrappers register sessions with it and
DaemonClient (`src/daemon-client.ts`) implements `IStore` over HTTP so
the same code paths work in standalone or daemon mode.

## The MCP tool surface (13 tools)

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

**Memory + memory queries**:
- `recall` — search `mode='philosophy' | 'sessions' | 'ledger' | 'any'`
  with optional `stance` and `source` filters
- `log_reasoning` — record agent reasoning (low-stakes journal entry)
- `revise_artifact` — supersede or retract a prior artifact

**Side-channel**:
- `request_horizon_check` — flag a decision for retrospective review at
  3mo/1y/2y
- `answer_question` — agent reply to a human question on an artifact
- `post_pr_review` — push approved findings as inline comments to a PR
- `export_session` — markdown / pr-comments / json dump

Tool calls return text-only `content` (no `structuredContent` yet —
deferred). The companion UI subscribes to WebSocket broadcasts for
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
artifact is never created. Near-misses (50%-100% token coverage) get
recorded in a sidecar trace so the breadcrumb in the UI can render
"Almost flagged this — your past stance on X is adjacent."

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

~/.deeppairing/
  philosophy/v1.json              # Cross-project Philosophy Ledger
  daemon.json                     # Daemon liveness info (pid, port, project)
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

The ledger is the only structurally cross-project surface. Every
session can query it via `recall(mode='philosophy' | 'ledger')` and
the daemon's `/api/ledger/digest` aggregates it for the UI.

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

See [SECURITY.md](SECURITY.md). Short version: the daemon binds
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
  (~1000 tests, ~70s on a modern laptop).
- **Component tests** in `web/src/components/__tests__/` use happy-dom
  via the workspace vitest config; pure tests run in node.

## Where to look first

| Task                              | Start here                                              |
|-----------------------------------|---------------------------------------------------------|
| Add a new MCP tool                | `src/mcp/tools/` (mirror the `present-*.ts` pattern)    |
| Change the preflight matcher      | `src/mcp/preflight-validator.ts`                        |
| Wire a new HTTP route             | `src/http/routes.ts` or `src/daemon-routes.ts`          |
| Add a UI surface                  | `web/src/components/` + a Zustand store in `web/src/stores/` |
| Change the global ledger          | `src/store/global-store.ts` + `routes.ts:/api/ledger/*` |
| Surface a WS event to the UI      | `src/daemon.ts` broadcast + `web/src/stores/connection.ts` switch |

## Schemas live in `packages/shared`

Zod schemas in `packages/shared/src/schemas/` are the single source of
truth for `Artifact`, `Comment`, `Evidence`, `Finding`, etc. Both the
MCP server and the companion UI import from `@deeppairing/shared`. New
fields must be optional for back-compat (per CLAUDE.md).
