# deepPairing

Collaborative human-AI development framework built on Claude Code's Agent SDK.

## Architecture

Turborepo + pnpm monorepo with 5 packages:

```
apps/
  api/          # TypeScript + Hono API server
  web/          # React + Vite + Tailwind frontend
packages/
  shared/       # Zod schemas, types, fixtures
  mcp-server/   # In-process MCP tools for Claude collaboration
  ui/           # Component library (placeholder)
```

### Key Architecture Decisions

- **Agent SDK only** — no CLI fallback. Requires `ANTHROPIC_API_KEY`. Max plan OAuth is not supported.
- **MCP tools for collaboration** — 5 in-process tools (`present_findings`, `present_options`, `present_plan`, `log_reasoning`, `check_feedback`) registered via `createSdkMcpServer`. Must be in `allowedTools` with `mcp__deeppairing__*` wildcard.
- **Fakes not mocks** for testing — `FakeAgentService`, `FakeWorktreeManager`, fake repositories all implement the same interfaces as real implementations.
- **Event-sourced streaming** — agent events flow through EventEmitter → SSE → frontend Zustand stores.
- **Artifact model** — named, versioned, commentable outputs (research, plan, decision, code_change, reasoning) with lifecycle (draft → approved/revised/rejected).

### Data Flow

```
ClaudeAgentService → query() with MCP server
  → Agent calls deepPairing MCP tools
  → MCP tools create artifacts + block for human input
  → Events emit on session EventEmitter
  → SSE streams to frontend
  → Zustand stores update React components
  → Human interacts (comments, approves, selects options)
  → REST API resolves pending decisions/plan reviews
  → MCP tool unblocks and returns human's response to agent
```

### Critical Integration Points

- `apps/api/src/services/claude-agent.ts` — wires MCP server, system prompt, allowed tools, and hooks into `query()`
- `packages/mcp-server/src/index.ts` — `createDeepPairingMcpServer()` factory
- `apps/api/src/prompts/system.ts` — collaboration protocol prompt (BAD/GOOD evidence examples)
- `apps/api/src/services/artifact-store.ts` — artifact lifecycle management
- `apps/api/src/services/decision-manager.ts` — deferred Promise pattern for blocking MCP tools

## Development

```bash
pnpm install
USE_FAKE_AGENT=true pnpm turbo dev     # Dev mode with fake agent (no API key needed)
ANTHROPIC_API_KEY=... pnpm turbo dev   # Real Claude mode
pnpm turbo test                        # Run all tests
pnpm turbo build                       # Type-check and build all packages
```

Frontend at http://localhost:5173 (Vite proxy forwards /api to :3001).

## Testing Conventions

- **Fakes over mocks.** Build fake implementations that satisfy the same interface (`FakeAgentService`, `FakeArtifactRepository`, etc.).
- Fakes live in `__fakes__/` directories adjacent to the real implementations.
- Shared test data in `packages/shared/src/__fixtures__/`.
- `USE_FAKE_AGENT=true` runs the full app with deterministic fake scenarios.
- Tests use `vitest`. Frontend tests use `@testing-library/react` with `jsdom`.

## Code Conventions

- TypeScript strict mode, ESM (`"type": "module"`).
- Zod schemas in `packages/shared` are the single source of truth for types.
- All new fields in schemas must be optional for backward compatibility.
- Backend services use constructor injection for dependencies (not import mocking).
- Frontend state in Zustand stores. No `Map` types in Zustand (causes infinite re-render with `useSyncExternalStore`). Use plain `Record<string, T[]>` instead.
- `CommentableCode` component for any code block that should support inline commenting.
- `scrollIntoView?.()` (optional chain) in components to handle jsdom test environment.

## Key Schemas

- `Evidence` — filePath, lineStart, lineEnd, snippet, explanation, relatedPaths
- `Finding` — category, title, detail, evidence (string | Evidence[]), impact, recommendation
- `Artifact` — id, type, version, parentId, status, content (type-specific)
- `Comment` — target (artifactId + optional line/finding/evidence/step), codeReferences[]
- `AgentEvent` — discriminated union of 15 event types
