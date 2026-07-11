# Contributing to deepPairing

Thanks for your interest in contributing. deepPairing is a collaborative human-AI development framework, and we welcome contributions of all kinds — bug reports, design feedback, docs, and code.

## Where to start

- **Good first issues** are labelled [`good-first-issue`](https://github.com/mitchjablonski/deepPairing/issues?q=is%3Aopen+label%3Agood-first-issue). They're scoped to one file or one component and don't require deep familiarity with the daemon architecture.
- **`help-wanted`** labels are larger but well-defined — pick one if you want a meaningful contribution and have ~half a day.
- **Architecture / design conversations** start in [Discussions](https://github.com/mitchjablonski/deepPairing/discussions) rather than as issues. The Philosophy Ledger trust model, the three-process daemon, and the elicitation-vs-companion-UI tension are all live questions worth thinking out loud about.
- **Don't ship a large refactor without aligning first.** A 500-line "while I was here" diff is hard to review and easy to reject. Open a draft PR with an empty diff + a written design and tag a maintainer.

## Development setup

```bash
# Clone and install
git clone https://github.com/mitchjablonski/deepPairing.git
cd deepPairing
pnpm install

# Build everything (server + web UI + shared schemas)
pnpm build

# Run the full test suite
pnpm test

# Type check
pnpm typecheck

# Iterate on tests in watch mode
cd packages/mcp-server && npx vitest

# Try the demo end-to-end
node packages/mcp-server/dist/cli/init.js demo
```

Requires Node 22+ and pnpm 10+. Cold-clone wall time is ~60-90s on `pnpm install`, ~10s on the build, ~5s on the demo.

### Regenerating the committed plugin bundle

`claude-plugin/server/` is **generated but committed** — the marketplace ships the git repo, so `pnpm build` bundles the server + web UI into that directory and CI's "Plugin bundle staleness gate" fails if the committed copy drifts from a fresh build.

A **warm** local build can produce a bundle CI cannot reproduce (turbo replaying a cache-hit `dist/` so the bundle step never re-runs; a stale vite dep-cache re-hashing `web/assets/*`). So:

> **Any PR that touches bundled source (`packages/shared/src`, `packages/mcp-server/src`, or the web UI), and EVERY release version bump, must regenerate the bundle with `pnpm build:clean` and commit the result.**

```bash
pnpm build:clean   # wipes turbo/vite/tsc caches, then runs the FULL root build
git add claude-plugin/server
```

Never regenerate the bundle with a warm `pnpm build`, and never with `pnpm --filter @deeppairing/mcp-server build` alone (that does **not** rebuild `@deeppairing/shared`; the root turbo build orders shared → mcp-server). `build:clean` is the only path guaranteed to match CI.

## Project structure

```
packages/
  shared/         # Zod schemas, types, fixtures (published as @deeppairing/shared)
  mcp-server/     # MCP server + HTTP/WS daemon + companion web UI
    src/
      mcp/        # MCP protocol handlers (13 tools + 2 prompts)
      http/       # Hono HTTP + WebSocket server
      store/      # File-based persistence (.deeppairing/)
      cli/        # init / demo / doctor / philosophy / sessions / export
      export/     # Markdown export (PR, ADR, full, replay, learnings)
      __tests__/  # Daemon + integration + lifecycle tests
    web/          # Companion React app (Vite + Tailwind 4 + Zustand)
  vscode-extension/  # VS Code sidebar webview
claude-plugin/    # Claude Code plugin (.mcp.json + slash commands + skill)
```

## Code conventions

- TypeScript strict mode, ESM (`"type": "module"`).
- Zod schemas in `packages/shared` are the single source of truth for types.
- New schema fields must be optional for backward compatibility (deepPairing reads `.deeppairing/sessions/` from prior installs).
- Frontend state in Zustand stores; no `Map` types in store state (use `Record<string, T[]>` so Zustand's shallow comparison works).
- **Fakes over mocks** for testing. Build a fake implementation that satisfies the real interface — `FileStore` is the canonical example. Mocks drift; fakes get exercised on every test that touches the boundary.
- Dark-mode-first design system with CSS custom properties.
- Error codes returned over the wire MUST come from `src/error-codes.ts` (`ERROR_CODES`). The drift-protect test in `__tests__/error-codes.test.ts` will fail if a literal sneaks in.

## Testing

- Pure functions (diff, fuzzy search, preflight matcher) get unit tests.
- FileStore changes get round-trip tests with temp directories.
- HTTP routes get Hono `.request()` tests (see `http/__tests__/routes.*.test.ts` (shared setup in `routes.harness.ts`)).
- MCP tools get integration tests via the SDK's `InMemoryTransport` (see `mcp/__tests__/server.test.ts`).
- New error codes need a docs/troubleshooting.md entry if user-facing.

## Commit messages

We don't enforce Conventional Commits, but we do prefer:

- One concept per commit. "Fix bug and refactor" is two commits.
- Subject line ≤ 72 chars, imperative mood ("Add foo" not "Added foo").
- Body explains the **why**, not the what (the diff explains the what).
- Reference the issue/PR/ADR in the trailer if applicable.

Recent commits in `git log` are good examples of the house style.

## Pull request process

1. Fork and create a feature branch.
2. Make your changes with tests.
3. Run `pnpm typecheck && pnpm test && pnpm build` to verify (this is what CI runs). If your change touches bundled source (`packages/*/src` or the web UI) or bumps a version, regenerate the committed bundle with `pnpm build:clean` and `git add claude-plugin/server` — see [Regenerating the committed plugin bundle](#regenerating-the-committed-plugin-bundle). A warm `pnpm build` can pass locally yet fail CI's staleness gate.
4. Open a PR with a clear description: what changed, why, and what you tested.
5. A maintainer aims to leave first-pass feedback within ~5 business days. If we miss that, ping the PR — we're a tiny team and stale PRs do slip occasionally.
6. Squash-merge is the default for feature branches; merge commits are reserved for release branches.

## Reporting issues

Use GitHub Issues with the provided templates. For bugs, include:

- What you expected vs. what happened.
- Steps to reproduce — ideally a minimal repro repo or a deepPairing-internal command sequence.
- Your environment: Node version, OS, Claude Code version, deepPairing commit hash.
- Relevant `.deeppairing/daemon.log` and `.deeppairing/server.log` tail (last ~50 lines).

For security issues, follow [SECURITY.md](SECURITY.md) and open a private GitHub Security Advisory — **not** a public issue.

## Code of conduct

Be kind. Disagreement is welcome; condescension isn't. We extend the same patience to first-time contributors and to people whose review notes you'd rather not hear.
