# README assets

Real screenshots of the running companion UI (not mockups):

- `review-surface.png` — the artifact review surface: a finding with structured
  evidence and the syntax-highlighted code at issue.
- `reasoning-card.png` — a reasoning artifact with the concept named ("the
  pattern at play"), the roads not taken, and an "Ask why" on each.
- `ledger.png` — the "Your Taste" cross-project Philosophy Ledger drawer.

## Regenerating them

They're captured by a gated Playwright spec against a real daemon (with `HOME`
isolated so the global ledger never touches `~/.deeppairing`):

```bash
cd packages/mcp-server
pnpm build
pnpm test:e2e:install                 # one-time: downloads Chromium
CAPTURE_README=1 npx playwright test capture-readme.e2e.ts
```

The spec is skipped in the normal `pnpm test:e2e` run (it writes into this
directory). Seed content + framing live in `e2e/capture-readme.e2e.ts`.
