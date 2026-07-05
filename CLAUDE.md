# deepPairing

Collaborative human-AI development framework. MCP server + companion web UI that works within Claude Code natively.

## Architecture

```
Claude Code ←stdio→ deepPairing MCP Server ←WebSocket→ Companion Web UI (localhost, per-project port)
                     ↕ file store (.deeppairing/)        ↕ HTTP REST API
```

Turborepo + pnpm monorepo:

```
packages/
  shared/         # Zod schemas, types, fixtures
  mcp-server/     # Standalone MCP server + HTTP server + companion web UI
    src/
      mcp/        # MCP server (stdio transport, 12 tools)
      http/       # Hono HTTP + WebSocket server
      store/      # File-based persistence (.deeppairing/)
    web/          # Companion React app (Vite build → dist/web/)
  vscode-extension/ # VS Code webview that embeds the companion UI
```

### Key Architecture Decisions

- **MCP server running inside Claude Code** — not a separate agent harness. Claude Code IS the agent.
- **Non-blocking MCP tools** — `present_options` and `present_plan` record and return immediately. Human responds via companion UI or terminal. Agent calls `check_feedback` to get responses.
- **File-based persistence** — `.deeppairing/sessions/{id}/` stores artifacts, comments, decisions as JSON.
- **Dual transport** — stdio for MCP protocol; HTTP on a deterministic per-project port in `3847-3974`, derived from a hash of the project path (not first-come — check `.deeppairing/daemon.json` for the actual bound port), for the companion web UI + WebSocket.
- **Fakes not mocks** for testing.

### Data Flow

```
1. User talks to Claude Code normally
2. Claude calls deepPairing MCP tools (present_findings, present_options, etc.)
3. MCP tool records artifact in file store + pushes via WebSocket
4. Companion web UI renders artifact with rich evidence, inline commenting
5. Human comments/selects in web UI → POST to HTTP API → stored
6. Claude calls check_feedback → reads human responses → continues
```

## Development

```bash
pnpm install
pnpm --filter @deeppairing/mcp-server build        # Build server + companion UI (vite + plugin bundle)
pnpm --filter @deeppairing/mcp-server start         # Start MCP server
```

## Testing with Claude Code

**From within the deepPairing repo** — add `.mcp.json` to project root:
```json
{
  "mcpServers": {
    "deeppairing": {
      "command": "npx",
      "args": ["tsx", "packages/mcp-server/src/standalone.ts"]
    }
  }
}
```

**From another project** — use `node` with the built dist and absolute path:
```json
{
  "mcpServers": {
    "deeppairing": {
      "command": "node",
      "args": ["/absolute/path/to/deeppairing/packages/mcp-server/dist/standalone.js"]
    }
  }
}
```
Make sure you've run `pnpm install && pnpm build` in the deepPairing repo first.

Open the companion UI at the daemon's port — a deterministic per-project port in `3847-3974`, derived from the project path and recorded in `.deeppairing/daemon.json`.

## Code Conventions

- TypeScript strict mode, ESM (`"type": "module"`).
- Zod schemas in `packages/shared` are the single source of truth for types.
- All new fields in schemas must be optional for backward compatibility.
- Frontend state in Zustand stores. No `Map` types (use `Record<string, T[]>`).
- `CommentableCode` component for any code block with inline commenting.
- `scrollIntoView?.()` (optional chain) for jsdom compatibility.

## Key Schemas

- `Evidence` — filePath, lineStart, lineEnd, snippet, explanation, relatedPaths
- `Finding` — category, title, detail, evidence (string | Evidence[]), impact, recommendation
- `Artifact` — id, type, version, parentId, status, content (type-specific)
- `Comment` — target (artifactId + optional line/finding/evidence/step), codeReferences[]
