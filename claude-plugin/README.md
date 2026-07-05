# deepPairing — Claude Code plugin

Turn Claude Code from a black box into a pairing partner. Structured
artifacts (findings, specs, decisions, plans), cross-session rejection
memory, a cross-project philosophy ledger, and a companion web UI (on a
deterministic per-project port in `3847-3974`, derived from the project path —
check `.deeppairing/daemon.json` for the actual one) for inline review and
commenting.

## Install

### From the marketplace (recommended)

The plugin ships a self-contained, zero-dependency server bundle in
`server/`, so a marketplace install needs no `pnpm install` or build step:

```bash
# Inside Claude Code:
/plugin marketplace add https://github.com/mitchjablonski/deepPairing
/plugin install deeppairing@deeppairing
```

<!-- Marketplace structure validated against the Claude Code plugin-marketplace
     docs; live end-to-end verification in a real Claude Code client still
     pending. If the marketplace path fails, --plugin-dir below always works. -->

The first command registers this repo's `.claude-plugin/marketplace.json`
catalog; the second installs the `deeppairing` plugin from it. `deeppairing@deeppairing`
is `plugin-name@marketplace-name` — both happen to be `deeppairing`.

### From a local checkout (development / self-host)

```bash
# Build once
pnpm install
pnpm --filter @deeppairing/mcp-server build

# Load the plugin for this Claude Code session only
claude --plugin-dir ./claude-plugin

# Or install it for every session in this workspace
claude plugin install ./claude-plugin --scope project
```

### How the plugin finds the MCP server

The plugin's `.mcp.json` invokes a small launcher (`server.mjs`) that
resolves the MCP server entry point across three install layouts:

1. **Bundled** — `${CLAUDE_PLUGIN_ROOT}/server/standalone.js`. This is
   what the marketplace pack will ship: the compiled server lives inside
   the plugin so it has zero external dependencies.
2. **Monorepo dev checkout** —
   `${CLAUDE_PLUGIN_ROOT}/../packages/mcp-server/dist/standalone.js`.
   What you're using when you `claude --plugin-dir ./claude-plugin` from
   this repo after `pnpm build`.
3. **npm-installed package** — `require.resolve("@deeppairing/mcp-server")`.
   Use `npm i -g @deeppairing/mcp-server` once the package is published.

If none resolve, the launcher prints a clear message naming each path it
tried and the recovery command, so install failures don't show up as
opaque "module not found" errors.

## What you get

**Slash commands**

- `/deeppairing:start` — Opens a session with cross-project philosophy
  pulled in before you propose anything.
- `/deeppairing:review <query>` — Search past sessions for a concept,
  artifact, or pattern.
- `/deeppairing:stance <concept>` — Check your cross-project stance on a
  concept (do you avoid or prefer it?).
- `/deeppairing:review-pr <pr>` — Pair-review a pull request and stage
  findings for inline PR comments.
- `/deeppairing:post-pr <pr>` — Post the approved pair findings as inline
  comments on the pull request (via the `gh` CLI).

**Skill** (auto-invoked)

- `pairing-protocol` — Teaches Claude when to use the deepPairing MCP
  tools. Claude reads this on any project where the plugin is active.

**MCP server** (bundled via `.mcp.json`)

- 12 tools: `present_findings`, `present_spec`, `present_options`,
  `present_plan`, `present_code_change`, `log_reasoning`,
  `answer_question`, `revise_artifact` (mode: supersede | retract),
  `recall` (mode: philosophy | sessions | ledger | any),
  `post_pr_review`, `export_session`, `check_feedback`.
- MCP resources: `deeppairing://session/current`,
  `deeppairing://artifact/{id}`, `deeppairing://sessions`,
  `deeppairing://session/{id}`.
- MCP elicitation for quick approvals in-terminal.

**Companion web UI** — a deterministic per-project port in `3847-3974`,
derived from a hash of the project path (check `.deeppairing/daemon.json`
for this project's actual bound port). Auto-opens on first daemon start
(unless `DEEPPAIRING_OPEN_BROWSER=0`).

## What the plugin sets up automatically

When the deepPairing daemon spawns in a project for the first time, it
runs an idempotent setup pass:

- Creates `.deeppairing/` for session data.
- Adds `.deeppairing/` to `.gitignore` (only if `.gitignore` already exists).
- Adds a Claude Code Stop hook to `.claude/settings.local.json` so the
  agent can't declare "done" while artifacts still need human review.

It does **not** touch `CLAUDE.md` — silently rewriting your repo-level
agent instructions from a backgrounded MCP server would surprise people.
For that, run:

```bash
npx deeppairing init
```

That appends a deepPairing protocol block to `CLAUDE.md` so the agent
follows the collaboration protocol even outside the plugin's skill
context. The plugin's `pairing-protocol` skill already covers most of
the same ground, so this is optional.

## What makes this different

deepPairing is pointed at *teaching you*, not replacing you. The agent
names the pattern at play on every action (`log_reasoning.concept`), asks
you to predict outcomes on high-stakes decisions, records every rejection
with its reason, and refuses to re-propose things you've rejected — by
name OR by underlying concept. Every session compounds into a
cross-project philosophy ledger that makes the NEXT session smarter.

## See also

- Main repo: https://github.com/mitchjablonski/deepPairing
- `deeppairing.md` in `packages/mcp-server/` — the full collaboration
  protocol the agent follows
