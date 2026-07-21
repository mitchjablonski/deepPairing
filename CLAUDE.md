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
      mcp/        # MCP server (stdio transport, 15 tools)
      http/       # Hono HTTP + WebSocket server
      store/      # File-based persistence (.deeppairing/)
    web/          # Companion React app (Vite build → dist/web/)
  vscode-extension/ # VS Code webview that embeds the companion UI
```

### Key Architecture Decisions

- **MCP server running inside Claude Code** — not a separate agent harness. Claude Code IS the agent.
- **Non-blocking MCP tools** — `present_options` and `present_plan` record and return immediately. The companion UI is the review surface — the human responds there, not in the terminal. Agent calls `check_feedback` to get responses.
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
pnpm build                                          # Full turbo build (shared → mcp-server); iterating-only
pnpm --filter @deeppairing/mcp-server start         # Start MCP server
```

> `pnpm --filter @deeppairing/mcp-server build` alone does **not** rebuild `@deeppairing/shared` — if `packages/shared/dist` is missing the server build fails module resolution. Use the root `pnpm build` (turbo orders shared → mcp-server).

> Full local vitest runs on WSL `/mnt/c` can hit 9P filesystem latency (slow tsx cold-starts, transform contention) — a native-ext4 checkout (e.g. under `~`) erases the class. Test isolation: `DEEPPAIRING_PORT_BASE` / `DEEPPAIRING_PORT_SPAN` relocate the daemon port window (see `src/project-root.ts`); the vitest setup sets a per-worker window at ~20000-32000 automatically so test-spawned daemons never touch the canonical 3847-3974 window.

### Regenerating the committed plugin bundle — use `pnpm build:clean`

`claude-plugin/server/` is generated-but-committed; CI's "Plugin bundle staleness gate" fails if the committed bundle drifts from a cold build. A **warm** `pnpm build` can produce a bundle CI can't reproduce (turbo replays a cache-hit `dist/` and skips the bundle step → stale version stamp; a stale vite dep-cache re-hashes `web/assets/*`). So:

> **ANY PR touching bundled source (`packages/*/src`, web UI) and EVERY release version bump must run `pnpm build:clean` and commit `claude-plugin/server/`** — never a warm `pnpm build`, never `--filter @deeppairing/mcp-server build` alone.

`pnpm build:clean` wipes the turbo/vite/tsc caches (`.turbo`, `node_modules/.vite`, `dist/`) then runs the full root build — the only path guaranteed to match CI.

Release version bumps must update all four version sources in one commit — `src/version.ts` (`SERVER_VERSION`), `packages/mcp-server/package.json`, `packages/shared/package.json`, `claude-plugin/.claude-plugin/plugin.json` — enforced by `packages/mcp-server/src/__tests__/version-lockstep.test.ts`.

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
- `Finding` — required: category, detail, `significance` (`low`|`medium`|`high`); optional: title, evidence (string | Evidence[]), severity, confidence, impact, recommendation, relatedFindings. (`significance` is the required note-worthiness enum; `impact`/`severity` are the distinct optional risk fields — don't confuse them.)
- `Artifact` — id, type, version, parentId, status, content (type-specific)
- `Comment` — target (artifactId + optional line/finding/evidence/step/`region` (diagram rect)/`optionId`/`visualId`/`requirementId`/`questionIndex`/`sectionId`), codeReferences[]
