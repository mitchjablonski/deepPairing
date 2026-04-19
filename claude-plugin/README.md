# deepPairing — Claude Code plugin

Turn Claude Code from a black box into a pairing partner. Structured
artifacts (findings, specs, decisions, plans), cross-session rejection
memory, a cross-project philosophy ledger, and a companion web UI at
http://localhost:3847 for inline review and commenting.

## Install

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

### From the marketplace

*(Planned. Once published:)*

```bash
claude plugin install deeppairing
```

## What you get

**Slash commands**

- `/deeppairing:start` — Opens a session with cross-project philosophy
  pulled in before you propose anything.
- `/deeppairing:review <query>` — Search past sessions for a concept,
  artifact, or pattern.
- `/deeppairing:stance <concept>` — Check your cross-project stance on a
  concept (do you avoid or prefer it?).

**Skill** (auto-invoked)

- `pairing-protocol` — Teaches Claude when to use the deepPairing MCP
  tools. Claude reads this on any project where the plugin is active.

**MCP server** (bundled via `.mcp.json`)

- 13 tools: `present_findings`, `present_spec`, `present_options`,
  `present_plan`, `present_code_change`, `log_reasoning`,
  `answer_question`, `supersede_artifact`, `retract_artifact`,
  `search_sessions`, `recall_philosophy`, `request_horizon_check`,
  `export_session`, `check_feedback`.
- MCP resources: `deeppairing://session/current`,
  `deeppairing://artifact/{id}`, `deeppairing://sessions`,
  `deeppairing://session/{id}`.
- MCP elicitation for quick approvals in-terminal.

**Companion web UI** — `http://localhost:3847`. Auto-opens on first daemon
start (unless `DEEPPAIRING_OPEN_BROWSER=0`).

## What makes this different

deepPairing is pointed at *teaching you*, not replacing you. The agent
names the pattern at play on every action (`log_reasoning.concept`), asks
you to predict outcomes on high-stakes decisions, records every rejection
with its reason, and refuses to re-propose things you've rejected — by
name OR by underlying concept. Every session compounds into a
cross-project philosophy ledger that makes the NEXT session smarter.

## See also

- Main repo: https://github.com/deeppairing/deeppairing
- `deeppairing.md` in `packages/mcp-server/` — the full collaboration
  protocol the agent follows
