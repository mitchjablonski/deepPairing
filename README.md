# deepPairing

**Claude Code paraphrases past your rejections. deepPairing remembers them across projects and refuses on your behalf.**

*MCP server + companion web UI. Runs inside Claude Code. MIT-licensed, no telemetry, no account — the ledger lives on your disk.*

> The agent proposes "let's add a global mutable ConfigStore singleton."
> You reject it: *"we tried global state for config last project — broke testability."*
> Three minutes later it tries again, paraphrased: *"add a global config cache for hot lookups."*
> deepPairing catches the concept match and refuses on the agent's behalf.
>
> 🛡 **Blocked by your taste — "global mutable state for config"**
> *You rejected this 3 days ago: "broke testability in 3 places."*

That refusal — and the cross-project taste it's drawing from — is what deepPairing exists to do.

> **Reads are global, writes are opt-in.** Every project benefits from your accumulated cross-project taste on day one. Whether *this* project's rejections get published to the global ledger is one prompt at `init` — default off — so a malicious dependency in one project can't poison the others.

> **See it for yourself in 90 seconds.** A scripted [demo command](#try-the-demo) fires the rejection-block toast against a real companion UI. Screen recordings of the live flow ship with the next tagged release.

## Try the demo

```bash
git clone https://github.com/deeppairing/deeppairing.git
cd deeppairing
pnpm install && pnpm build
node packages/mcp-server/dist/cli/init.js demo
```

> Requires Node 20+ and pnpm 10+. Cold-clone wall time is around 60-90s on `pnpm install` (Turborepo + a few hundred deps), then ~10s for the monorepo build, then ~5s for the demo. No Claude Code installation needed for this path.

The companion UI auto-opens at `http://localhost:3847`. The hero rejection-block toast fires within ~5 seconds. That's the proof. Everything below is whether you'd want this in your daily Claude Code loop.

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

## What it isn't

- **Not a code review bot** like CodeRabbit or Greptile. It pairs *with* you on the diff; the PR is a surface to share what you paired on.
- **Not an autonomous agent.** The Autonomy dial goes Full / Light / Minimal — even Minimal stops at architectural decisions.
- **Built for senior ICs and staff engineers** who context-switch across many repos and resent re-litigating the same taste decisions. The pre-flight gate assumes you already have taste; deepPairing makes that taste compound. (If you're learning the craft, the rejection-block fires on patterns you may not have opinions about yet — start with the auto-memory in Claude Code instead.)

## How it compares

| Tool | Decisions persist across projects? | Concept-match blocks paraphrase? | Human-in-loop autonomy |
| :--- | :---: | :---: | :--- |
| Cursor 3 *canvases* | No | No | Approve/reject diff |
| Continue | No | No | Inline review |
| Aider | No | No | Approve/reject diff |
| Claude Code *auto-memory* | Per-project + global, soft recall (model may consult) | No | None (autonomous by default) |
| Vanilla Claude Code | None | No | None |
| **deepPairing** | **Yes** — cross-project Philosophy Ledger | **Yes** — hard pre-flight gate | Configurable Full / Light / Minimal |

> **False positives happen.** Concept-match is fuzzy by design (it has to be, to catch paraphrases). Every block is one-click overridable from the companion UI; the override updates the ledger so the same shape doesn't trip again on similar wording.

Cursor's canvases and Claude Code's auto-memory both look like deepPairing on the surface, but neither catches the paraphrase: canvases are a presentation surface (no gate on the tool call), and auto-memory is a context the model is *encouraged* to consult, not a constraint. Reject "Railway" in either and an hour later "Fly.io for pay-per-request hosting" sails through.

deepPairing's `runPreflight` ([packages/mcp-server/src/mcp/preflight-validator.ts](packages/mcp-server/src/mcp/preflight-validator.ts)) is the hard pre-flight gate. Every `present_findings` / `present_options` / `present_plan` / `present_code_change` call gets matched against your Philosophy Ledger via concept-token + scope-glob rules. Match → tool returns `REJECTED_APPROACH_BLOCKED` and the artifact is never created. The agent has to revise or escalate; it can't paraphrase past you.

## What makes this different

The concept-match pre-flight is the moat. These are the affordances that compound on top of it:

- **Cross-project Philosophy Ledger.** Stances accumulate at `~/.deeppairing/philosophy/v1.json` across every deepPairing project you've opted in to publish from (opt-in is one prompt at `init`). Portable via `deeppairing philosophy export | import --merge`.
- **Three-layer memory model.** Filesystem-sensed guardrails (migrations, CI), team conventions (committable `.deeppairing/team.json`), personal philosophy. Surfaced separately to the agent. Never merged.
- **Calibration loop.** High-stakes decisions capture your prediction + confidence. When a similar decision comes up later, the breadcrumb shows what you predicted before. ✓ / ✗ / ◐ retrospective affordance closes the loop.
- **Concept-naming as the teaching lever.** Every `log_reasoning` call surfaces the pattern at play ("dependency inversion", "optimistic UI") so you learn the vocabulary, not just the fix.
- **Structured artifacts the human reviews, not skims.** Findings, decisions, plans, code changes land in the companion UI — but they're table stakes (Cursor canvases ship a similar surface). The reason they matter here is that they give the rejection ledger something to gate on. No artifacts → nothing for `runPreflight` to match against.
- **Pair-tempo signals.** "I see you" toast on every comment, ❓ N questions waiting badge, ledger-write toast on every stance added. The compounding is *felt*, not just stored.

## CLI

Pre-1.0: there is no npm publish yet, so the `deeppairing` command isn't in your PATH out of the box. Either invoke the built CLI by path, or one-time pnpm-link it.

**By path** (no setup, works after `pnpm build`):

```bash
node packages/mcp-server/dist/cli/init.js demo
node packages/mcp-server/dist/cli/init.js init
node packages/mcp-server/dist/cli/init.js doctor --fix
```

**Or, link once** (gets you the short `deeppairing` command everywhere):

```bash
pnpm setup                                    # one-time, adds pnpm bin dir to PATH
cd packages/mcp-server && pnpm link --global  # one-time per clone
```

After linking:

```bash
deeppairing demo                       # 5-second hook validator
deeppairing init                       # Set up in this project (interactive)
deeppairing doctor [--fix]             # Diagnose / heal install issues
deeppairing team init                  # Scaffold .deeppairing/team.json
deeppairing philosophy export          # Dump cross-project ledger
deeppairing philosophy import f --merge
deeppairing post-pr-review <pr>        # Post pair findings as PR comments (gh CLI)
deeppairing export <format>            # full | pr-comments | adr | replay | learnings
```

## How it fits together

```
Claude Code  ←stdio→  deepPairing MCP Server  ←WebSocket→  Companion UI
                          ↓
                   .deeppairing/        (session artifacts, team prefs, metrics)
                   ~/.deeppairing/      (cross-project Philosophy Ledger)
```

The MCP server runs inside Claude Code (it IS the agent — no separate orchestrator). The companion UI is read + steer; the terminal stays the primary chat surface. Sessions persist as JSON in `.deeppairing/`; the ledger persists at `~/.deeppairing/philosophy/v1.json`.

For details: see [ARCHITECTURE.md](ARCHITECTURE.md). If something isn't behaving, [TROUBLESHOOTING.md](TROUBLESHOOTING.md) is keyed on the actual error strings the daemon and wrapper return. Common questions and the cases we deliberately don't handle yet live in [FAQ.md](FAQ.md).

## What's in the box

- **`packages/mcp-server/`** — the MCP server, CLI subcommands, companion UI (React + Vite + Zustand).
- **`packages/shared/`** — Zod schemas + fixtures that both server and UI import.
- **`claude-plugin/`** — Claude Code plugin: `.mcp.json`, slash commands (`/deeppairing:start`, `/deeppairing:review`, `/deeppairing:stance`, `/deeppairing:review-pr`, `/deeppairing:post-pr`), `pairing-protocol` skill.

12 MCP tools: `present_findings`, `present_options`, `present_spec`, `present_plan`, `present_code_change`, `log_reasoning`, `recall` (mode: philosophy | sessions | any), `revise_artifact` (mode: supersede | retract), `answer_question`, `post_pr_review`, `export_session`, `check_feedback`. Plus a `recall` MCP prompt for user-invoked slash-style queries.

## Status

Pre-1.0. Installable from this repo only — no npm publish, no marketplace listing yet. The hook is proven (the `demo` command exists for that reason); the next step is earning a handful of delighted real users before broader distribution.

## License

[MIT](LICENSE)
