# Contributing to deepPairing

Thanks for your interest in contributing! deepPairing is a collaborative human-AI development framework, and we welcome contributions of all kinds.

## Development Setup

```bash
# Clone and install
git clone https://github.com/deeppairing/deeppairing.git
cd deeppairing
pnpm install

# Build everything
pnpm build

# Build the companion web UI
cd packages/mcp-server/web && npx vite build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Start the MCP server (for local testing)
pnpm --filter @deeppairing/mcp-server start
```

## Project Structure

```
packages/
  shared/         # Zod schemas, types, fixtures (published as @deeppairing/shared)
  mcp-server/     # MCP server + HTTP/WS server + companion web UI
    src/
      mcp/        # MCP protocol handlers (8 tools)
      http/       # Hono HTTP + WebSocket server
      store/      # File-based persistence (.deeppairing/)
      cli/        # npx deeppairing init
      export/     # Markdown export (PR, ADR, full)
    web/          # Companion React app (Vite + Tailwind 4 + Zustand)
  vscode-extension/  # VS Code sidebar webview (scaffolded)
```

## Code Conventions

- TypeScript strict mode, ESM (`"type": "module"`)
- Zod schemas in `packages/shared` are the single source of truth for types
- All new schema fields must be optional for backward compatibility
- Frontend state in Zustand stores, no `Map` types (use `Record<string, T[]>`)
- Fakes over mocks for testing — build fake implementations that satisfy real interfaces
- Dark-mode-first design system with CSS custom properties

## Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
cd packages/mcp-server && npx vitest
```

Tests use Vitest. When adding new features:
- Pure functions (diff, fuzzy search) get unit tests
- FileStore changes get round-trip tests with temp directories
- HTTP routes get Hono `.request()` tests
- MCP tools get integration tests via the SDK's InMemoryTransport

## Pull Request Process

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run `pnpm typecheck && pnpm test && pnpm build` to verify
4. Open a PR with a clear description of what and why

## Reporting Issues

Use GitHub Issues with the provided templates (bug report or feature request). Include:
- What you expected vs. what happened
- Steps to reproduce
- Your environment (Node version, OS, Claude Code version)
