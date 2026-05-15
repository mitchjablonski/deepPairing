# deepPairing

**An MCP server + companion web UI that turns Claude Code into a pair-programming partner — and remembers your "no" across every project so the agent can't paraphrase past you.**

![hero — rejection-block toast](docs/assets/hero.png)
*The hero moment: the agent paraphrases a stance you rejected last week, deepPairing intercepts before the artifact is created. Replace this image by recording your own session — see [`docs/assets/README.md`](docs/assets/README.md).*

---

> The agent proposes "let's add a global mutable ConfigStore singleton."
> You reject it: *"we tried global state for config last project — broke testability."*
> Three minutes later it tries again, paraphrased: *"add a global config cache for hot lookups."*
> deepPairing catches the concept match and refuses on the agent's behalf.
>
> 🛡 **Blocked by your taste — "global mutable state for config"**
> *You rejected this 3 days ago: "broke testability in 3 places."*

That refusal — and the cross-project taste it's drawing from — is what deepPairing exists to do.

![Your taste drawer — Philosophy Ledger](docs/assets/ledger.png)
*The Ledger view inside the companion UI: every stance you've accumulated, with citation counts here and across projects.*

## Try it in two minutes (no Claude Code yet)

```bash
git clone https://github.com/deeppairing/deeppairing.git
cd deeppairing && pnpm install && pnpm build
node packages/mcp-server/dist/cli/init.js demo
```

> Requires Node 20+ and pnpm 10+. The full build takes ~6 seconds on a fresh clone.

The companion UI auto-opens at `http://localhost:3847`. The hero rejection-block toast fires within ~5 seconds. That's the demo — the rest of the project is whether you'd want this in your daily Claude Code loop.

## Use it in Claude Code

```bash
# from the cloned repo
claude --plugin-dir ./claude-plugin
```

Then in any project:

```
You: Let's analyze the auth module.
```

Claude calls deepPairing's MCP tools instead of dumping findings as plain text. Findings, decisions, plans, and code changes land in the companion UI with structured evidence. You comment, approve, reject, ask "why" — and every rejection becomes part of your **cross-project Philosophy Ledger** that future sessions remember.

## Why other tools can't catch this

Cursor 3 (April 2026) shipped *canvases* — durable artifacts with approve/reject diff review.
Claude Code (Feb 2026, v2.1.59) shipped *auto-memory* — learns from your corrections, hierarchical project + global.
Both look like deepPairing on the surface. **Neither catches the paraphrase.**

Auto-memory is a text dump the model is *encouraged* to consult. Canvases are presentation, not constraint. Reject "Railway" in either, and an hour later "Fly.io for pay-per-request hosting" sails through — because nothing intercepts the call before it's made.

deepPairing's `runPreflight` ([packages/mcp-server/src/mcp/preflight-validator.ts](packages/mcp-server/src/mcp/preflight-validator.ts)) is a hard pre-flight gate. Every `present_findings` / `present_options` / `present_plan` / `present_code_change` call gets matched against your Philosophy Ledger via concept-token + scope-glob rules. Match → tool returns `REJECTED_APPROACH_BLOCKED` and the artifact is never created. The agent has to revise or escalate; it can't paraphrase past you.

That's the moat. Everything below is the surface that makes it usable.

## What makes this different

Concept-aware blocking is the moat. These are the affordances that compound on top of it:

- **Cross-project Philosophy Ledger.** Stances accumulate at `~/.deeppairing/philosophy/v1.json` across every deepPairing project you touch. Portable via `npx deeppairing philosophy export | import --merge`.
- **Three-layer memory model.** Filesystem-sensed guardrails (migrations, CI), team conventions (committable `.deeppairing/team.json`), personal philosophy. Surfaced separately to the agent. Never merged.
- **Calibration loop.** High-stakes decisions capture your prediction + confidence. When a similar decision comes up later, the breadcrumb shows what you predicted before. ✓ / ✗ / ◐ retrospective affordance closes the loop.
- **Concept-naming as the teaching lever.** Every `log_reasoning` call surfaces the pattern at play ("dependency inversion", "optimistic UI") so you learn the vocabulary, not just the fix.
- **Structured artifacts the human reviews, not skims.** Findings, decisions, plans, code changes land in the companion UI — but they're table stakes (Cursor canvases ship a similar surface). The reason they matter here is that they give the rejection ledger something to gate on. No artifacts → nothing for `runPreflight` to match against.
- **Pair-tempo signals.** "I see you" toast on every comment, ❓ N questions waiting badge, ledger-write toast on every stance added. The compounding is *felt*, not just stored.

## What it isn't

- **Not a code review bot** like CodeRabbit or Greptile. It pairs *with* you on the diff; the PR is a surface to share what you paired on.
- **Not an autonomous agent.** The Ceremony dial goes Full / Light / Minimal — even Minimal stops at architectural decisions.
- **Not for junior education.** It assumes you already have taste; it makes that taste compound across projects and sessions.

## Working with deepPairing

```bash
npx deeppairing demo                  # 5-second hook validator
npx deeppairing init                  # Set up in this project (interactive)
npx deeppairing doctor [--fix]        # Diagnose / heal install issues
npx deeppairing team init             # Scaffold .deeppairing/team.json
npx deeppairing philosophy export     # Dump cross-project ledger
npx deeppairing philosophy import f --merge
npx deeppairing post-pr-review <pr>   # Post pair findings as PR comments (gh CLI)
npx deeppairing export <format>       # full | pr-comments | adr | replay | learnings
```

> **Why `npx deeppairing` works without an npm publish:** the package isn't on
> npm yet. To get the short `deeppairing` command in your PATH, link the cloned
> package globally one time:
>
> ```bash
> # one-time setup (creates ~/.local/share/pnpm and adds it to your PATH)
> pnpm setup
> # then, from the deepPairing repo
> cd packages/mcp-server && pnpm link --global
> ```
>
> Now `deeppairing demo` and friends resolve to your local checkout. If you'd
> rather not globally link, just call the CLI by path:
> `node /path/to/deepPairing/packages/mcp-server/dist/cli/init.js demo`.

## How it fits together

```
Claude Code  ←stdio→  deepPairing MCP Server  ←WebSocket→  Companion UI
                          ↓
                   .deeppairing/        (session artifacts, team prefs, metrics)
                   ~/.deeppairing/      (cross-project Philosophy Ledger)
```

The MCP server runs inside Claude Code (it IS the agent — no separate orchestrator). The companion UI is read + steer; the terminal stays the primary chat surface. Sessions persist as JSON in `.deeppairing/`; the ledger persists at `~/.deeppairing/philosophy/v1.json`.

For details: see [ARCHITECTURE.md](ARCHITECTURE.md).

## What's in the box

- **`packages/mcp-server/`** — the MCP server, CLI subcommands, companion UI (React + Vite + Zustand).
- **`packages/shared/`** — Zod schemas + fixtures that both server and UI import.
- **`claude-plugin/`** — Claude Code plugin: `.mcp.json`, slash commands (`/deeppairing:start`, `/deeppairing:review`, `/deeppairing:stance`, `/deeppairing:review-pr`, `/deeppairing:post-pr`), `pairing-protocol` skill.

13 MCP tools: `present_findings`, `present_options`, `present_spec`, `present_plan`, `present_code_change`, `log_reasoning`, `recall` (mode: philosophy | sessions | any), `revise_artifact` (mode: supersede | retract), `request_horizon_check`, `answer_question`, `post_pr_review`, `export_session`, `check_feedback`.

## Status

Pre-1.0. Installable from this repo only — no npm publish, no marketplace listing yet. The hook is proven (the `demo` command exists for that reason); the next step is earning a handful of delighted real users before broader distribution.

## License

[MIT](LICENSE)
