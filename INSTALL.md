# Installing deepPairing

Three ways in, all giving you the same MCP tools + companion UI. They differ
only in what's set up for you. The [README](README.md#install-in-claude-code)
has the short version; this page is the detail, the caveats, and the
`init`-vs-plugin comparison.

> **Just want to watch it first?** The
> [seeded demo](README.md#watch-the-seeded-demo-source-build) runs the hero
> flow against a real companion UI without Claude Code. It needs a source build
> (about 14–18 s measured end to end; see
> [How long it takes](README.md#how-long-it-takes)). The plugin path below
> needs no build.

All the "from a clone" paths need the build first — that requires **Node 20.19+, 22.13+, or 24+** (pnpm 10+), the floor set by the locked toolchain: `pnpm build` alone only needs Vite 8/rolldown's `^20.19.0 || >=22.12.0`, but `pnpm install` also pulls in eslint (run by `pnpm lint`, which CI runs on every PR), whose locked `^20.19.0 || ^22.13.0 || >=24` is tighter on the 22.x line — so Node 22.12.x and all of Node 23.x are *not* supported by the contributor toolchain even though they'd satisfy Vite alone. This is stricter than the runtime the *prebuilt* plugin below needs (Node 20.11+, see [option 1](#1-marketplace-plugin-recommended)) — building from source and running the shipped bundle have different Node requirements. See [Node.js support policy](#nodejs-support-policy) below for the full recommended/tested/legacy breakdown:

```bash
git clone https://github.com/mitchjablonski/deepPairing.git
cd deepPairing && pnpm install && pnpm build
```

## Node.js support policy

Node 20 reached end-of-life on 2026-04-30; Node 22 ("Jod") and Node 24
("Krypton") are the current LTS lines. This is a lifecycle refresh, not a
reaction to a known deepPairing incompatibility — nothing here has been
observed to fail on Node 20.

| | Prebuilt plugin (marketplace / `claude-plugin/`) | Source build (contributors) |
|---|---|---|
| **Recommended** | Node 22 or 24 | Node 22 or 24 |
| **Maintained / tested in CI** | Node 22, Node 24 (`plugin-boot` matrix in CI runs the actual shipped `claude-plugin/server/` bundle, no `dist` fallback, on both) | Node 22 (main CI jobs) and the exact floor, Node 20.19.0 (`node-floor` CI job: install + build + lint) |
| **Legacy-compatible, untested in CI** | Node 20.11+ — unchanged `engines.node` floor. `esbuild` targets `node20` for this bundle and it uses no Node API newer than 20.11 (checked against `node:fs/path/http/net/crypto/events/child_process/os/url/perf_hooks/readline/stream`, `fetch`, `structuredClone`), so there's no technical reason it wouldn't keep working — CI simply no longer exercises it, because Node 20 has no more upstream security fixes. | Node 20.19+ still satisfies the locked toolchain's `engines` field and builds cleanly (verified for #409/#414); it's listed here rather than above because CI only pins the exact floor, not a general Node-20 job. |
| **Exact `engines.node`** | `>=20.11.0` (`packages/mcp-server/package.json`, unchanged) | `^20.19.0 \|\| ^22.13.0 \|\| >=24` (root `package.json`, unchanged) |

**Decision needed from Mitch** (flagged in the PR, not resolved here): whether
Node 20 should stay **legacy-compatible, untested in CI** (the status quo this
PR keeps) or move to **deprecated, with a removal plan** (an announced
version + date after which the `>=20.11.0` floor is dropped). This PR does not
make that call — it only stops silently implying Node 20 is as well-supported
as 22/24, and makes sure nothing breaks for Node 20 users today.

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
     server, the pairing-protocol skill, the 5 slash commands, and the
     plugin hooks. -->

This adds the slash commands (`/deeppairing:start`, `:review`, `:stance`,
`:share`, `:review-pr`, `:post-pr`), the proactively-loaded `pairing-protocol` skill, and
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
installs all three hooks into `.claude/settings.local.json` — the PreToolUse
**rejection-gate**, the PostToolUse **checkpoint**, and the **Stop checkpoint** —
and drops the protocol preamble into `CLAUDE.md`. Installing the rejection-gate
at `init` time (not waiting for the first daemon start) means the gate is live
from your very first session.

> Run this inside **your** project, not inside the deepPairing clone itself:
> the repo already ships a dev `.mcp.json`, so `init` there is a no-op on that
> file (it detects deeppairing is already configured and leaves it alone).

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
node packages/mcp-server/dist/cli/init.js doctor --fix
```

## After install

Either way you get the tools, the companion UI, and an always-on first-call
protocol preamble. Then just work normally — *"Let's analyze the auth module"* —
and Claude routes findings, decisions, plans, and changes through the companion
UI with structured evidence. You comment, pick options, ask "why", and request
revisions; every rejection becomes a hard gate in this project — and (if you've
opted into publishing) an advisory flag on your other projects.

**VS Code extension — experimental preview.** Open the companion in your
browser. The extension in `packages/vscode-extension/` is an experimental
preview with no parity commitment and no date, and it is not part of a supported
install. What it does not do is listed in
[packages/vscode-extension/README.md](packages/vscode-extension/README.md).

If something misbehaves, [docs/troubleshooting.md](docs/troubleshooting.md) is
keyed on the actual error strings, and `deeppairing doctor` diagnoses common
install issues.

**If the plugin loads but no daemon ever comes up** — the companion UI stays on
*Waiting for Claude* and never shows an artifact — that's the
[“Waiting for Claude” stays forever](docs/troubleshooting.md#waiting-for-claude-stays-forever)
entry: most often Claude Code is running in a different folder than the daemon,
or the MCP server hasn't loaded. On WSL `/mnt/c` first starts, also see
[Claude Code's MCP startup times out](docs/troubleshooting.md#claude-codes-mcp-startup-times-out-on-mntc).
