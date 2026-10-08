# deepPairing

**Hand Claude Code the implementation without handing it the decisions that
matter. It shows you the evidence, you make the call in a local review UI, and
what you turn down is checked against what the agent proposes next in that
repo.**

**Who it's for:** engineers who let Claude Code write most of the code but want
to own the architecture — the calls that are expensive to reverse.

**The expensive problem:** an agent working alone quietly makes the
load-bearing choices (a global singleton for config, a new queue, a schema
change). You meet them in a 500-line diff, after the code is built on top of
them. Or you reject an idea on Tuesday, and on Thursday a fresh session
proposes it again.

**What you get instead:** before it builds, Claude Code shows you what it found
(with file:line evidence), the options it weighed, and the plan. You comment,
pick, or reject in the companion UI. When you reject an approach with a reason,
this project's gate checks later proposals against it and refuses a match,
quoting your reason back. The run ends with a debrief of what changed and what
still needs your eyes.

**What the gate does, and what it doesn't** (the details are in
[Your taste compounds](#your-taste-compounds)):

- **In-protocol (`present_*` tools) — refused.** Reject *"global mutable state
  for config"*, and *"keep config in global mutable states"* is refused before
  the artifact is recorded.
- **Matching is on words, not meaning.** It uses stemmed words plus a small,
  hand-audited synonym list (*delete*↔*remove*, *directory*↔*folder*). *"A
  module-level mutable settings object"* shares too few words with that
  concept, so it gets through. False positives happen too: *"remove global
  mutable state from config"* is refused, because it contains every word of
  the concept. One click on "Retire this stance" clears it.
- **Direct `Edit`/`Write`/`MultiEdit` — you're asked, not refused.** A `PreToolUse`
  hook pauses a matching edit with a permission prompt, and you decide. It does
  not see `Bash` or notebook edits, and if it breaks, it lets the edit
  through.
- **Other projects — a nudge only.** It's off until you turn on cross-project
  publishing, and it never blocks.

*MIT · no account · no telemetry · 3,000+ tests · everything stays on your disk.*

![The enforcement moment — the agent re-proposes a concept you rejected ("global mutable state for config"), and a "Blocked by your taste" card stops it before the edit lands, showing the reason you gave and a one-click override.](docs/assets/enforcement.png)

**Poor fit:** one-line fixes and throwaway scripts (the review is heavier than
the change). Fully unattended runs where nobody will look at the UI. Teams that
need a hard policy engine: the gate is a local word matcher, not a security
boundary. Editors other than Claude Code.

### Get started

Install the plugin inside Claude Code. It needs no clone and no build: the
plugin ships a prebuilt server. Node 22 or 24 (current LTS) is recommended and
what CI tests; Node 20.11+ still works but is deprecated — Node 20 is EOL and
support is planned for removal no earlier than v0.2.0 (not before January
2027; see [INSTALL.md](INSTALL.md#nodejs-support-policy)).

```bash
/plugin marketplace add https://github.com/mitchjablonski/deepPairing
/plugin install deeppairing@deeppairing
```

Then open Claude Code in your own project and ask for real work, for example
*"Analyze the auth module and propose options."* The first steps are in
**[Your first review ↓](#your-first-review)**. To look around before
installing, the **[sample demo ↓](#try-the-sample-demo-no-build)** runs with
plain Node. It needs no build and no Claude Code.

## What you get

- **The rejection gate.** Reject an approach with a reason, and in this
  project a `present_*` call that matches it is refused, with your reason
  quoted back. A direct `Edit`/`Write` that matches is paused for your approval
  by a `PreToolUse` hook rather than refused. Once you enable cross-project
  publishing, your other projects get an advisory nudge about the same stance,
  never a block. Matching is on words and a short synonym list, not meaning
  ([limits](#your-taste-compounds)).
- **Decision cards.** Options arrive as cards you pick in the UI — pros, cons,
  effort, and risk laid out side by side. Hard-to-reverse calls are flagged
  "high stakes" so you see at a glance which choices are load-bearing.
- **A closing debrief.** Every feature or autonomous run ends with one debrief
  artifact: the narrative of what changed and why, the calls the agent made
  without you, what still needs your eyes, and an ask-anything thread — so you
  understand the change, not just approve it. For code archaeology ("how does
  auth work here?") the agent narrates a read-only explainer walk-through.
- **Live plan checklists.** Plans render as checklists that tick off as the
  work lands, so "what's left" never lies.
- **Comment on the diagram itself.** Drag a rectangle on a plan or spec's
  Mermaid diagram and your comment anchors to the nodes it covers — and
  survives the agent redrawing the diagram.

![Select a region of a plan's Mermaid diagram and comment on it — the comment anchors to the nodes it covers (here, the AuthGate node) and survives the agent redrawing the diagram.](docs/assets/region-comment.png)
- **Every decision, one place.** A project-wide decisions view lists what was
  chosen and why across all your sessions, searchable, with a jump back into
  the session where you made the call.
- **A Detail dial.** Rich or Terse — how much text rides inside each artifact.
  Terse trims the prose; the artifacts and evidence stay.
- **Session replay.** Reopen any past session from the command palette →
  **Browse past sessions (replay)** and step back through its artifacts,
  comments, and decisions in order.
- **Multi-project switcher.** One companion UI aggregates every project you're
  pairing on, with a "waiting on you" badge when it's your move.
- **Share the session.** Export any session as a single self-contained web page
  — the narrative, decisions, debrief, and the diffs by default — from the
  companion UI's **Share as page (.html)** menu or `/deeppairing:share`. It
  travels to teammates who never install deepPairing, and it warns before it
  ships anything that looks like a secret. Pass `--redact-code` (or
  `includeCode: false`) to strip every code body and diff when the code
  shouldn't leave the building.
  <!-- user-field: a `docs/assets/share-page.png` crop of the rendered page header would go here -->
- **Review a PR in tandem.** `/deeppairing:review-pr <N>` pulls a colleague's
  GitHub PR onto the review surface — the diff per hunk, walk-me-through, and
  findings anchored to real lines. Your verdict stays local until you send it:
  `/deeppairing:post-pr` posts it back as a PR review only when you say so.
  <!-- user-field: a short GIF of a PR landing on the review surface would go here -->
- **Keyboard-first review.** Navigate artifacts, comment, pick options, and ask
  "why" without leaving the keyboard.

![Drag a rectangle over a diagram to select the nodes it covers — the marquee mid-drag, over the same auth flow.](docs/assets/region-drag.png)

![The project-wide decisions view — every choice made across every session of this project, what was chosen and why, searchable, with a jump back into the session where you made the call.](docs/assets/decisions-view.png)

![The Autonomy dial with the Detail (Rich / Terse) toggle and the Cross-project memory switch — how much prose rides inside each artifact, orthogonal to how much structured review the pair does, plus whether stances you record here are published to your other projects (off by default).](docs/assets/detail-density.png)

![The end-of-run debrief — the narrative of what changed, the calls the agent made on its own (with the alternative it weighed), what needs your eyes, what was deferred, and an ask-anything thread.](docs/assets/debrief.png)

![The read-only explainer — a numbered walk-through of how a flow works, each section anchored to the real code, for onboarding and code archaeology.](docs/assets/explainer.png)

## Why this exists

Today's AI coding tools push you to two unhappy ends: full autonomy (review 500
lines after the fact and hope) or autocomplete (you do all the thinking). The
collaborative middle — where you stay in the loop at the *decision* level, not
the keystroke level — is where good engineers actually want to work, and almost
nothing is built for it. Every tool starts autonomous and bolts human review on
afterward.

deepPairing starts from collaboration. The agent gathers context, then pauses
at the decisions that matter and asks you. You answer once; it remembers. Over
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
DEBRIEF  → the run ends with the story: what changed, why, what needs your eyes
```

![The companion UI — a finding with structured evidence reviewed inline, the syntax-highlighted code at issue, and the agent's turn up top.](docs/assets/review-surface.png)

The companion UI is where you review and steer; the terminal stays your primary
chat surface. The MCP server runs *inside* Claude Code (it IS the agent — no
separate orchestrator) and serves the UI on a deterministic per-project port in
`3847-3974`, derived from the project path (recorded in `.deeppairing/daemon.json`).

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

So you never have to make the same call twice:

- **You're not silently re-proposed past.** Four surfaces, four different
  guarantees:
  - **`present_*` tools, this project: refused.** A matching proposal gets a
    `REJECTED_APPROACH_BLOCKED` error, the artifact is not recorded, and your
    reason is quoted back. `revise_artifact` runs the same check. For
    `present_debrief` and an external-PR `present_changeset`, a match is
    reported as advice instead, because those describe work that already
    exists.
  - **Direct `Edit`/`Write`/`MultiEdit`, this project: asked.** The
    `PreToolUse` hook runs the same matcher on the new text and file path,
    and a match becomes a Claude Code permission prompt (`ask`). It never
    returns `deny`, so you can allow the edit. It doesn't see `Bash` or
    `NotebookEdit`. It only reads this project's stances, and it fails open:
    if it errors, or the stance file can't be parsed, the edit proceeds.
  - **Other projects: a nudge, never a block.** Turn on **cross-project
    publishing** (off by default; see below) and a matching proposal elsewhere
    gets an advisory note ("you avoided this in `<project>` — still want it
    here?"). Reject it there as well to make it block there. If the
    cross-project ledger can't be read, the note is skipped.
  - **What counts as a match.** Every word of the concept (after light
    stemming, so *state*/*states* match) must appear in the proposal, or the
    rejected phrase itself must. A small, hand-audited **synonym list** widens
    that: *delete*↔*remove*, *directory*↔*folder*, *cache*↔*memoize*,
    *env*↔*environment*, *authentication*↔*login*↔*signin*, and
    *authorization*↔*authz*. Authentication and authorization are kept
    apart on purpose. That's the whole list. It is not semantic understanding.
    Reject *"global mutable state for config"*, and *"keep config in global
    mutable states"* is caught, while *"a module-level mutable settings
    object"* is not. A partial overlap, such as *"global state for config"*,
    goes through, with a near-miss note in the trace. So name the concept in
    the words the agent will reuse. Word matching needs a named concept: if
    you reject a finding, plan, or spec without typing one, the stance is
    just its title, and only that phrase (word-bounded) is matched. None of
    the rewordings above would be caught.
  - **False positives and overrides.** A proposal to *remove* global mutable
    state from config is refused too, because it contains every word of the
    concept. **"Retire this stance"** on the block card deletes the stance
    from this project and lets the proposal through. (Blocks from a committed
    **team rule** point you to `.deeppairing/team.json` instead.) Tests:
    [preflight-validator](packages/mcp-server/src/mcp/__tests__/preflight-validator.test.ts),
    [paraphrase-alias](packages/mcp-server/src/mcp/__tests__/paraphrase-alias.test.ts),
    [preflight-hook-core](packages/mcp-server/src/cli/__tests__/preflight-hook-core.test.ts),
    [tool-helpers-global-advisory](packages/mcp-server/src/mcp/__tests__/tool-helpers-global-advisory.test.ts).
- **A backstop on the paths you can't undo.** The same PreToolUse hook also
  watches your guardrail paths — migrations, CI config, infrastructure, `.env`
  and other secret files. If the agent starts writing to one of them without
  having presented *any* findings, options, spec, or plan first, you get a
  prompt naming the path and the class before the edit lands. Do the pairing and
  it never fires; it never hard-blocks, it fails open, and
  `DEEPPAIRING_GUARDRAIL_BACKSTOP=off` turns it off.
- **The ledger underneath.** Reject something with a reason and the stance is
  remembered. It's remembered **in this project** always; it reaches your
  *other* projects — `~/.deeppairing/philosophy/v1.json` — only once you enable
  cross-project publishing. Reads are global (every repo sees whatever ledger
  you've accumulated); writes are **opt-in per project**, default off, so a
  dependency in one project can't poison the others. Turn it on from
  **Autonomy → Cross-project memory** in the companion UI (you're also offered
  it once, right after your first "Reject & remember"), at `init`, or with
  `deeppairing philosophy publish on`. Portable via
  `deeppairing philosophy export | import --merge`; drop a stance you no
  longer hold (whole entry, ledger backed up first) with
  `deeppairing philosophy remove <concept>` or the ✕ in the Ledger drawer.
- **Three-layer memory, never merged.** Filesystem-sensed guardrails
  (migrations, CI), committable team conventions, and personal philosophy are
  surfaced to the agent separately.

![The Ledger drawer — cross-project stances, each with the reason you gave when you rejected it.](docs/assets/ledger.png)

## What it isn't

- **Not a code-review bot** (CodeRabbit, Greptile). It pairs *with* you while
  the code is being written; a PR is just a surface to share what you paired on.
- **Not an autonomous agent.** The Autonomy dial goes Full / Light / Minimal —
  and even Minimal stops at the architectural decisions.
- **Not just a memory file.** Claude Code's CLAUDE.md and auto memory are
  context the model is asked to follow, and its docs point you to a
  `PreToolUse` hook when you need a hard stop
  ([memory docs](https://code.claude.com/docs/en/memory), checked 2026-09-27).
  deepPairing ties the rejection to the decision you made in the review UI and
  checks every later proposal in that repo against it. The check is a word
  matcher, so it's a strong default, not a guarantee.
- **Not a skin over MCP elicitation.** The async review loop is standard
  protocol now — server-initiated requests went non-blocking in the
  [2026-07-28 spec](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
  ([SEP-2322 MRTR](https://modelcontextprotocol.io/seps/2322-MRTR)), and
  deepPairing speaks it, native elicitation supported (opt-in) for the
  trivial approve-here case. But elicitation, as clients render it today, is a
  flat approve/decline form ("flat objects with primitive properties only …
  nested structures, arrays of objects … intentionally not supported" —
  [Final spec](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation))
  — the right shape for a yes/no, not for the review that is deepPairing's
  whole point. The differentiator isn't a protocol limit (rich in-client UI is
  now spec-possible — see the [FAQ](docs/faq.md)); it's the composed review
  *system* no one else has built: multi-file changeset review with per-line and
  cross-file comments and suggested edits the agent has to answer, the decision
  workbench with per-part comments and version carryover, region-anchored
  diagram comments, and the debrief/explainer comprehension pair with an
  answer-back question loop. The review surface is the product; the loop is
  plumbing.

## Beyond Plan Mode

Claude Code's Plan Mode is good at what it does: it drafts a plan and waits for
your go-ahead before touching code. But the plan is terminal text — you read it,
approve it or retype it, and once the session moves on it's gone. deepPairing
makes the plan a *thing you work*: it lands in the companion UI as a checklist
you comment on line by line, pick between options on, and reject approaches in —
and the same review surface extends past the plan to the findings, the
decisions, and the diffs. Your calls don't evaporate when the session ends:
reject an approach with a reason and it's remembered per-repo. A matching
`present_*` proposal is refused, and a matching direct edit is paused for your
approval, before the change lands rather than in the diff after. (Plan Mode in
other tools has grown too: Cursor saves plans as editable Markdown files —
[docs](https://cursor.com/docs/agent/plan-mode), checked 2026-09-27.) Plan Mode gets you one gate at the
start; deepPairing keeps you in the loop at every decision that matters and
remembers where you stood.

|                                | Plan Mode          | deepPairing                          |
| ------------------------------ | ------------------ | ------------------------------------ |
| Where the plan lives           | Terminal text      | Commentable artifact in a local UI   |
| You respond by                 | Approving/retyping | Inline comments, option picks, "why" |
| Covers                         | The initial plan   | Findings, options, plans, diffs      |
| Remembers your calls next time | No                 | Per-repo, with a word-matched gate   |

## Install in Claude Code

**Supported path: the prebuilt plugin.** Inside Claude Code:

```bash
/plugin marketplace add https://github.com/mitchjablonski/deepPairing
/plugin install deeppairing@deeppairing
```

- **What you need:** Claude Code and Node on your `PATH` — 22 or 24
  recommended (what CI tests), 20.11+ still works but is deprecated
  (Node 20 is EOL; support planned for removal no earlier than v0.2.0,
  not before January 2027 — see
  [INSTALL.md](INSTALL.md#nodejs-support-policy)). You don't need
  pnpm, a clone or a build.
- **What you get:** the plugin runs the server bundle committed in
  `claude-plugin/server/`. It also installs the MCP tools, the slash commands
  (`/deeppairing:start`, `:review`, `:stance`, `:share`, `:review-pr`,
  `:post-pr`) and
  the rejection-gate and checkpoint hooks.
- **What it is not:** there is no npm package. deepPairing is distributed only
  as this plugin and this repository.

To load the same plugin from a clone for one session, use
`claude --plugin-dir ./claude-plugin`. That also needs no build: the committed
bundle is used when `packages/mcp-server/dist` is absent. Setup details, the SSH
note and the `init`-vs-plugin comparison are in **[INSTALL.md](INSTALL.md)**.

### Your first review

Each step names where it happens and what to do next.

1. **Terminal: start Claude Code in your project.** When the plugin's MCP
   server starts, it starts a local daemon for the project. On the daemon's
   first start it opens the companion in your browser. The companion runs on a per-project port in `3847-3974`. If no
   tab opens, run `/deeppairing:start` and Claude gives you the URL. The daemon
   records its port in `.deeppairing/daemon.json`.
2. **Companion: wait for the first artifact.** Until Claude presents something,
   the companion shows *Waiting for Claude*. **Next:** go back to the terminal
   and ask for real work, such as an analysis, a set of options or a plan.
3. **Companion: review.** Findings, options, plans and changes arrive as
   artifacts. **Next:** comment on a line, pick an option, ask "why", approve,
   or reject with a reason. A rejection becomes a gate in this project.
4. **Terminal: Claude picks up your feedback.** Claude doesn't block while you
   review. It reads your comments and decisions with `check_feedback`, which it
   calls after presenting and whenever it next pauses. If you answered while
   it was busy, your feedback waits in the session. **Next:** if Claude
   hasn't responded, tell it in the terminal to *"check feedback"*.

**Where each part goes.**

- **Terminal chat:** direction and quick questions.
- **Companion:** anything tied to an artifact, such as line comments, option
  picks and verdicts.
- **Late feedback:** you don't need to re-type it in the terminal. It stays
  queued in the session until Claude next checks.

**If something is stuck,** run the checks in
[docs/troubleshooting.md](docs/troubleshooting.md). It covers the companion
staying on *Waiting for Claude*, a daemon that won't start, and MCP startup
timeouts on WSL `/mnt/c`.

### Try the sample demo (no build)

The demo plays a **scripted sample**. No AI agent or model runs; a script plays
the agent's part on synthetic content. In the companion you'll see:

- an agent's proposal, which you reject with a reason;
- the remembered consequence: the same approach, re-proposed in new words, is
  refused by the gate;
- an explainer and a closing debrief that summarise the run.

It runs straight from the shipped plugin bundle with plain Node 20.11+. You
don't need a clone build, pnpm or Claude Code:

```bash
# From a download of this repo (git clone or a ZIP) — no install, no build:
node claude-plugin/server/demo.mjs

# Or from an installed plugin — find the bundle once, then run it:
find ~/.claude/plugins -name demo.mjs -path '*deeppairing*'
node "<that path>"
```

It opens the companion in your browser, or prints the URL when
`DEEPPAIRING_NO_OPEN=1` is set. **Press Enter (or Ctrl+C) to end it.**

The demo runs in a sandbox:

- **Storage:** a temporary HOME and a synthetic sample project, created under
  your system temp directory and **deleted when the demo ends**.
- **Daemon:** its own daemon on its own port range (`41000-41063`). It never
  starts or contacts the daemon for your projects, and never uses their
  `3847-3974` range.
- **Your data:** it never writes to your projects, their preferences or your
  `~/.deeppairing` cross-project ledger. It sends no telemetry and calls no
  external model.

`node packages/mcp-server/dist/cli/init.js demo` from a source build runs the
same sandboxed demo.

### From source (developer path)

Use this path to work on deepPairing itself or to run it without the plugin.
`init` writes `.mcp.json` and the hooks into the current project:

```bash
pnpm install && pnpm build
node packages/mcp-server/dist/cli/init.js init
```

### How long it takes

**Indicative only.** Once the plugin is installed, its server, the daemon and
the companion are ready in about half a second on Linux and in under 2 s on
Windows. Times vary by machine: an independent re-run on the same kind of setup
was 20–40% slower.

The ranges below are exactly what three runs measured on 2026-09-27, using
throwaway `HOME` and project directories. Your times depend on your network,
disk and machine.

| Step | Linux (WSL2 ext4, Node 20.20) | Windows (Node 24.18, project on a `\\wsl.localhost` share) |
|---|---|---|
| Fetch the repo (what `/plugin marketplace add` downloads) | 1.1–1.4 s | not measured |
| Plugin server and daemon up, MCP `initialize` answered | 406–428 ms | 1047–1113 ms |
| Companion page served | 467–489 ms | 1234–1307 ms |
| First artifact visible in the companion | 487–514 ms | 1349–1482 ms |
| A companion comment reaches Claude's `check_feedback` | 509–538 ms | 1644–1741 ms |
| Sample demo from the shipped bundle (`node claude-plugin/server/demo.mjs`) until the companion is ready | 0.76–1.14 s | 2.8–4.5 s, one 48 s outlier (sandbox temp dir on the `\\wsl.localhost` share) |
| Source build, cold pnpm store: clone, install, build, demo | 1.4 + 6.0 + 8.3 + 1.9 ≈ 18 s | not measured |
| Source build, warm pnpm store | 1.3 + 2.1 + 8.3 + 1.9 ≈ 14 s | not measured |

How these were measured:

- **Plugin rows:** the times are from launching the plugin's `server.mjs` with
  plain `node`. A scripted MCP client stood in for Claude Code and an HTTP
  client stood in for the browser. A separate headless-browser check confirmed
  that the companion renders the artifact.
- **What they leave out:** installing the plugin inside Claude Code, Claude
  Code's own start-up, and the model's thinking time.
- **Cold install:** it downloaded 506 packages on a fast connection. A slow
  network adds to it.
- **WSL `/mnt/c`:** a first start there is much slower; see
  [troubleshooting](docs/troubleshooting.md#claude-codes-mcp-startup-times-out-on-mntc).

**VS Code extension (experimental preview).** The supported workflow is Claude
Code plus the browser companion. The extension in
`packages/vscode-extension/` is an experimental preview, with no parity
commitment and no date for one. Its known limitations are listed in
[packages/vscode-extension/README.md](packages/vscode-extension/README.md).

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
  (`/deeppairing:start`, `:review`, `:stance`, `:share`, `:review-pr`, `:post-pr`), the
  `pairing-protocol` skill, and the rejection-gate + checkpoint hooks.

18 MCP tools: `present_findings`, `present_options`, `present_spec`,
`present_plan`, `present_code_change`, `present_changeset`, `present_debrief`,
`present_explainer`, `update_plan_progress`, `log_reasoning`, `recall`, `revise_artifact`,
`withdraw_artifact`, `answer_question`, `post_pr_review`, `export_session`, `check_feedback`,
`get_companion_url` — plus two MCP prompts (`recall` and `seed`) for
slash-style queries.

### CLI

Pre-1.0, no npm publish yet — invoke the built CLI by path, or `pnpm link
--global` once for the short `deeppairing` command:

```bash
deeppairing demo                          # fire the hero flow
deeppairing init                          # set up in this project (interactive)
deeppairing doctor [--fix]                # diagnose / heal install issues
deeppairing port                          # bare daemon port to stdout (scriptable; !-friendly in Claude Code)
deeppairing status                        # friendly daemon picture: port, URL, pid, version, running/alive
deeppairing team init                     # scaffold .deeppairing/team.json
deeppairing philosophy export | import f --merge | publish on|off | remove <concept>
deeppairing post-pr-review <pr> --session-id ID  # post the explicitly reviewed session
deeppairing review-posts <session-id>     # inspect / recover an unresolved review post
deeppairing export <full|pr-comments|adr|replay|learnings>
```

`review-posts` also ships whole as a standalone operator entry in the plugin
bundle (`node claude-plugin/server/review-posts.mjs --help`), because a
marketplace install has no `deeppairing` binary. Five of its verbs are offline;
`reconcile` reads GitHub and only reads — the entry carries no way to submit a
review. See
[docs/pr-posting-contract.md](docs/pr-posting-contract.md#where-the-operator-commands-live).

## How it compares

Planning, memory, and blocking each exist elsewhere already, as of 2026-09-27.
Cursor's [Plan Mode](https://cursor.com/docs/agent/plan-mode) saves editable
plans. Claude Code's [memory](https://code.claude.com/docs/en/memory) carries
your instructions across sessions, and its
[hooks](https://code.claude.com/docs/en/hooks-guide) can deterministically
block a tool call. deepPairing doesn't claim any one of those alone. What it
adds is the workflow that joins them: evidence you can comment on, then a
decision you make on a card, then a review of the change, and a rejection that
comes back as a checked stance the next time the agent reaches for the same
thing. (The honest limits of the concept match are above and in
[docs/faq.md](docs/faq.md).)

## Status

Pre-1.0. Installable from this repo — via the Claude Code plugin marketplace
(`/plugin marketplace add https://github.com/mitchjablonski/deepPairing`, which
ships the committed self-contained server bundle), `--plugin-dir`, or from
source. No npm publish or listing in a public/community marketplace yet.
**3,000+ tests, an explicit threat model, a fully-live accessibility gate (axe,
zero disabled rules), and strict TypeScript throughout** — the next step is
earning a handful of delighted real users before broader distribution.

Ships a committed, reproducible server bundle (verify via `pnpm build:clean`);
the two bundled hooks are local-only and fail-open — see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
