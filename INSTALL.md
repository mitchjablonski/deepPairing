# Installing deepPairing

Three ways in, all giving you the same MCP tools + companion UI. They differ
only in what's set up for you. The [README](README.md#install-in-claude-code)
has the short version; this page is the detail, the caveats, and the
`init`-vs-plugin comparison.

> **Just want to watch it first?** The
> [demo command](README.md#see-it-in-90-seconds) fires
> the hero flow against a real companion UI in ~90 seconds, no Claude Code
> install needed.

All the "from a clone" paths need the build first (Node 22+, pnpm 10+):

```bash
git clone https://github.com/mitchjablonski/deepPairing.git
cd deepPairing && pnpm install && pnpm build
```

## 1. Marketplace plugin (recommended)

Inside Claude Code, no build step — this installs the committed, self-contained
server bundle:

```bash
/plugin marketplace add https://github.com/mitchjablonski/deepPairing
/plugin install deeppairing@deeppairing
```

Run the two commands separately. **Use the HTTPS URL form** — it works without
GitHub SSH keys. The `owner/repo` shorthand can resolve to SSH and fail with
`Permission denied (publickey)` on machines without a configured key.

<!-- Marketplace install VERIFIED end-to-end in a real Claude Code client
     (2026-07-04): marketplace add + install + reload registered the MCP
     server, 5 skills, and 6 agents. -->

This adds the slash commands (`/deeppairing:start`, `:review`, `:stance`,
`:review-pr`, `:post-pr`), the proactively-loaded `pairing-protocol` skill, and
— as of v0.1.1 — the **PreToolUse rejection-gate + Stop checkpoint hooks
natively** (declared in `claude-plugin/hooks/hooks.json`, active the moment the
plugin loads — no `init`, no `.mcp.json`, no session restart).

## 2. Local plugin from a clone

Same as the marketplace plugin, loaded from a local checkout for the current
session only (needs the `--plugin-dir` flag on each launch):

```bash
claude --plugin-dir ./claude-plugin
```

If the marketplace install ever fails to resolve, this path always works.

## 3. From source (`init`) — no plugin

`init` sets up a single project end-to-end, without the plugin:

```bash
node packages/mcp-server/dist/cli/init.js init   # run inside your project
```

It writes `.mcp.json` (so Claude Code auto-loads deepPairing — no launch flag),
installs the PreToolUse **rejection-gate hook** + the checkpoint hooks into
`.claude/settings.local.json`, and drops the protocol preamble into `CLAUDE.md`.

## `init` vs. the plugin — what differs

Under the plugin, the per-project `.mcp.json` is unnecessary (the plugin
auto-loads the MCP server) and the hooks already ship with the plugin. The one
thing `init` still does that the plugin does **not** is append the protocol
block to your repo's **`CLAUDE.md`** — so the collaboration protocol survives
even outside the plugin's skill context (e.g. a teammate on the same repo who
hasn't installed the plugin).

### If you run *both* `init` and the plugin

The daemon detects plugin mode and skips writing the Stop/preflight hooks to
`settings.local.json`, to avoid a double-fire. But a manual `init` in a terminal
can't detect the plugin, so running `init` explicitly **will** double-install
those two hooks. Clean up the redundant `settings.local.json` rows with:

```bash
npx deeppairing doctor --fix
```

## After install

Either way you get the tools, the companion UI, and an always-on first-call
protocol preamble. Then just work normally — *"Let's analyze the auth module"* —
and Claude routes findings, decisions, plans, and changes through the companion
UI with structured evidence. You comment, pick options, ask "why", and request
revisions; every rejection becomes a hard gate in this project — and (if you've
opted into publishing) an advisory flag on your other projects.

If something misbehaves, [docs/troubleshooting.md](docs/troubleshooting.md) is
keyed on the actual error strings, and `deeppairing doctor` diagnoses common
install issues.
