# deepPairing

**Pair with Claude Code instead of reviewing its output after the fact.**

deepPairing turns Claude Code from a fire-and-forget agent into a thinking
partner. Before it writes code, it shows you what it found, the options it's
weighing, and the plan it wants to follow — as structured artifacts you review
and shape in a local companion UI, not a wall of terminal text. And on every
move it names the *concept* behind the choice ("dependency inversion",
"optimistic UI"), so two things happen at once: **your taste shapes its work,
and its reasoning sharpens yours.**

The calls you make don't evaporate when the session ends. Reject an approach
once — with your reason — and deepPairing remembers it across every project, so
your standards hold even when the agent later paraphrases the same idea in
different words.

*An MCP server + companion web UI that runs inside Claude Code. MIT-licensed,
no account, no telemetry — everything lives on your disk.*

![The companion UI — a finding with structured evidence reviewed inline, the syntax-highlighted code at issue, and the agent's turn up top.](docs/assets/review-surface.png)

## Why this exists

Today's AI coding tools push you to two unhappy ends: full autonomy (review 500
lines after the fact and hope) or autocomplete (you do all the thinking). The
collaborative middle — where you stay in the loop at the *decision* level, not
the keystroke level — is where good engineers actually want to work, and almost
nothing is built for it. Every tool starts autonomous and bolts human review on
afterward.

deepPairing starts from collaboration. The agent gathers context, then pauses
at the decisions that matter and asks you. You answer once; it learns. Over
weeks it stops re-litigating taste you've already settled and starts sounding
like *your* pair, on *every* repo.

**The aha:** the loop isn't "AI writes → you approve." It's "AI thinks out loud
→ you steer → you both get better." Quality and taste compound instead of
resetting every session.

## How it works

Talk to Claude Code the way you already do. When the work involves
investigating, deciding, planning, or changing code, deepPairing routes it
through structured MCP tools instead of a plain-text dump:

```
GATHER   → the agent investigates and presents findings with real evidence
PRESENT  → options, specs, and plans land in the companion UI for you to read
DECIDE   → you comment inline, pick options, ask "why", request revisions
BUILD    → only after you've shaped the direction; changes show as diffs
```

The companion UI is where you review and steer; the terminal stays your primary
chat surface. The MCP server runs *inside* Claude Code (it IS the agent — no
separate orchestrator) and serves the UI on a deterministic per-project port.

## What makes it feel collaborative

- **Structured artifacts you shape, not skim.** Findings, specs, options,
  plans, and code diffs render with evidence (file\:line, snippets, the
  reasoning) and inline commenting — so you engage with the *thinking*, not just
  a final patch.
- **Concept-naming as a teaching lever.** Every `log_reasoning` surfaces the
  pattern at play, so you pick up the vocabulary and the agent's reasoning is
  legible — learning flows both directions.
- **It writes *to* you.** Second person, like a pair ("which of these fits how
  we handle auth?"), not a third-person audit log narrating what "the user"
  asked.
- **Pair-tempo signals.** An "I see you" toast on every comment, a
  questions-waiting badge, a turn indicator that's honest about whose move it
  is. The collaboration is *felt*, not just logged.

![A reasoning artifact — the concept named for learning ("the pattern at play: single-flight / request coalescing"), the roads not taken, and an "Ask why" on each.](docs/assets/reasoning-card.png)

## Your taste compounds

So you never have to make the same call twice. This is the safety net *under*
the collaboration, not the headline:

- **Cross-project Philosophy Ledger.** Reject something with a reason and the
  stance is remembered — across every project, at
  `~/.deeppairing/philosophy/v1.json`. Reads are global (every repo benefits on
  day one); writes are **opt-in** per project (one prompt at `init`, default
  off), so a dependency in one project can't poison the others. Portable via
  `deeppairing philosophy export | import --merge`.
- **You're not silently paraphrased past.** When the agent proposes something
  that matches a rejected approach, the `present_*` tool refuses
  (`REJECTED_APPROACH_BLOCKED`) and a **PreToolUse hook** catches a *direct*
  edit that tries to skip the protocol — surfacing it to you to decide. So
  "reject Railway" still catches "Fly.io for pay-per-request hosting" an hour
  later. **False positives are one click away:** "Not my taste" in the UI
  scopes the stance down and records the correction. (Blocks from a committed
  **team rule** point you to `.deeppairing/team.json` instead.)
- **Three-layer memory, never merged.** Filesystem-sensed guardrails
  (migrations, CI), committable team conventions, and personal philosophy are
  surfaced to the agent separately.
- **A calibration loop.** High-stakes decisions capture your prediction +
  confidence; later a breadcrumb shows what you predicted before, with a ✓/✗/◐
  retrospective to close the loop.

![The "Your Taste" drawer — cross-project stances, each with the reason you gave when you rejected it.](docs/assets/ledger.png)

> **See it in ~90 seconds.** The [demo command](#try-the-demo) fires the live
> flow against a real companion UI.

## What it isn't

- **Not a code-review bot** (CodeRabbit, Greptile). It pairs *with* you while
  the code is being written; a PR is just a surface to share what you paired on.
- **Not an autonomous agent.** The Autonomy dial goes Full / Light / Minimal —
  and even Minimal stops at the architectural decisions.
- **Good whether you're senior or still sharpening your taste.** If you have
  strong opinions, deepPairing makes them compound across repos. If you're
  building them, the concept-naming + reasoning are a craft-learning surface —
  you watch a strong pair think, and the vocabulary sticks.

## Try the demo

```bash
git clone https://github.com/mitchjablonski/deepPairing.git
cd deepPairing
pnpm install && pnpm build
node packages/mcp-server/dist/cli/init.js demo
```

> Requires Node 20+ and pnpm 10+. Cold-clone wall time is ~60-90s for
> `pnpm install`, ~10s to build, ~5s for the demo. No Claude Code install needed
> for this path.

The demo auto-opens the companion UI (the daemon binds a deterministic
per-project port in `3847-3974` — the first project gets `3847`). The hero flow
fires within a few seconds. Everything else is whether you'd want this in your
daily Claude Code loop.

## Use it in Claude Code

All paths run the same MCP server + companion UI (build the clone first:
`pnpm install && pnpm build`). They differ in what's set up for you.

**Recommended — `init` sets up this project end-to-end:**

```bash
node packages/mcp-server/dist/cli/init.js init   # run inside your project
```

Writes `.mcp.json` (so Claude Code auto-loads deepPairing — no launch flag),
installs the PreToolUse **rejection-gate hook** + the checkpoint hooks, and drops
the protocol preamble. It's the only path that turns the rejection gate on.

**Prefer the plugin (slash commands + the up-front skill)?**

```bash
claude --plugin-dir ./claude-plugin
```

Adds `/deeppairing:start`, `/deeppairing:review`, etc. and the proactively-loaded
`pairing-protocol` skill. (Needs `--plugin-dir` each launch. A one-command
`/plugin marketplace add` install is planned once the server bundle ships /
`@deeppairing/mcp-server` is on npm — it doesn't work yet.)

Either way you get the tools, the companion UI, and an always-on first-call
protocol preamble. Then just work normally — *"Let's analyze the auth module"* — and Claude routes
findings, decisions, plans, and changes through the companion UI with structured
evidence. You comment, pick, ask "why", request revisions; every rejection (if
you publish) joins your cross-project ledger.

## How it fits together

```
Claude Code  ←stdio→  deepPairing MCP Server  ←WebSocket→  Companion UI
                          ↓
                   .deeppairing/        (session artifacts, team prefs, metrics)
                   ~/.deeppairing/      (cross-project Philosophy Ledger)
```

Sessions persist as JSON in `.deeppairing/`; the ledger lives at
`~/.deeppairing/philosophy/v1.json`. For the full picture see
[docs/architecture.md](docs/architecture.md). If something misbehaves,
[docs/troubleshooting.md](docs/troubleshooting.md) is keyed on the actual error
strings; common questions live in [docs/faq.md](docs/faq.md); the origin-story
research brief is [docs/research-brief.md](docs/research-brief.md) (historical).

## What's in the box

- **`packages/mcp-server/`** — the MCP server, CLI subcommands, companion UI
  (React + Vite + Zustand).
- **`packages/shared/`** — Zod schemas + fixtures both server and UI import.
- **`claude-plugin/`** — the Claude Code plugin: `.mcp.json`, slash commands
  (`/deeppairing:start`, `:review`, `:stance`, `:review-pr`, `:post-pr`), and
  the `pairing-protocol` skill.

12 MCP tools: `present_findings`, `present_options`, `present_spec`,
`present_plan`, `present_code_change`, `log_reasoning`, `recall`,
`revise_artifact`, `answer_question`, `post_pr_review`, `export_session`,
`check_feedback` — plus a `recall` MCP prompt for slash-style queries.

### CLI

Pre-1.0, no npm publish yet — invoke the built CLI by path, or `pnpm link
--global` once for the short `deeppairing` command:

```bash
deeppairing demo                          # fire the hero flow
deeppairing init                          # set up in this project (interactive)
deeppairing doctor [--fix]                # diagnose / heal install issues
deeppairing team init                     # scaffold .deeppairing/team.json
deeppairing philosophy export | import f --merge
deeppairing post-pr-review <pr>           # post pair findings as PR comments
deeppairing export <full|pr-comments|adr|replay|learnings>
```

## How it compares

Cursor's canvases and Claude Code's auto-memory look similar on the surface, but
neither catches the *paraphrase*: canvases are a presentation surface with no
gate on the tool call, and auto-memory is context the model is *encouraged* to
consult, not a constraint. deepPairing is the only one where a past decision
becomes a hard, cross-project constraint *and* the collaboration is the point,
not a bolt-on. (More detail in [docs/faq.md](docs/faq.md).)

## Status

Pre-1.0. Installable from this repo only — no npm publish or marketplace listing
yet (~1,300 tests, an explicit threat model, real hardening). The next step is
earning a handful of delighted real users before broader distribution.

## License

[MIT](LICENSE)
