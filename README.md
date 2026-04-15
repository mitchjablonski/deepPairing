# deepPairing

**Structured human-AI collaboration for software development.**

deepPairing is an MCP server that runs inside Claude Code, turning AI-assisted coding from "AI does everything, you review after" into a structured collaboration where you understand, decide, and steer at every step.

## Quick Start

```bash
# Initialize in your project
npx @deeppairing/mcp-server init

# Restart Claude Code to activate the MCP server
# Open the companion UI
open http://localhost:3847
```

Or add manually to `.mcp.json`:

```json
{
  "mcpServers": {
    "deeppairing": {
      "command": "npx",
      "args": ["@deeppairing/mcp-server"]
    }
  }
}
```

## What It Does

When you work with Claude Code, deepPairing provides structured collaboration tools:

- **Research Findings** -- The agent presents what it discovered with actual code snippets, explanations, and impact analysis. You review and comment inline.
- **Decision Gates** -- At architectural decision points, the agent presents 2-4 options with pros/cons/effort/risk. You choose.
- **Implementation Plans** -- Before multi-file changes, the agent presents a step-by-step plan with before/after previews. You approve, modify, or reject.
- **Code Changes** -- Every change comes with reasoning, unified diffs, and inline commenting.
- **Session Memory** -- Rejected approaches are never proposed again. Approved patterns are preferred in future sessions.

## Companion UI

The companion web UI at `localhost:3847` provides:

- Sidebar layout with artifacts grouped by type (findings, decisions, plans, code changes)
- Inline code commenting with syntax highlighting
- Semantic line-level diffs (unified/split/result views)
- Decision cards with keyboard navigation
- Command palette (Cmd+K)
- Autonomy slider (supervised / balanced / autonomous)
- Auto-approve countdown for high-confidence items
- Partial plan acceptance (check/uncheck individual steps)
- Inline code suggestions
- Session metrics and engagement tracking
- Desktop notifications when it's your turn
- Editor deep links (VS Code, Cursor, JetBrains, Zed)

Also available as a **VS Code sidebar extension**.

## How It Works

```
Claude Code <--stdio--> deepPairing MCP Server <--WebSocket--> Companion UI
                              |
                        .deeppairing/
                        (session persistence)
```

The agent calls MCP tools (`present_findings`, `present_options`, `present_plan`, etc.) which record artifacts and push them to the companion UI via WebSocket. You review, comment, and decide in the UI. The agent picks up your feedback via `check_feedback`.

## Development

```bash
pnpm install
pnpm build                                              # Build all packages
pnpm test                                               # Run tests
cd packages/mcp-server/web && npx vite build            # Build companion UI
pnpm --filter @deeppairing/mcp-server start             # Start MCP server
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed system design.

## License

[MIT](LICENSE)
