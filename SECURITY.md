# Security Policy

## Reporting a vulnerability

**Open a private GitHub security advisory:**
https://github.com/mitchjablonski/deepPairing/security/advisories/new

We aim to respond within 5 business days. Please do not file public
issues for vulnerability reports.

We do not maintain a security email mailbox; GitHub Advisories are
the only intake channel. They give us free triage, private patch
coordination, and a real CVE pipeline if one ends up warranted.

## Supported versions

deepPairing is pre-1.0. We support and accept security fixes only on
the `main` branch. Once 1.0 ships we will publish a versioned
support policy here.

## Threat model

deepPairing runs as a local-only MCP server and HTTP daemon. It is
**not** designed for multi-tenant or networked deployment. The threat
model assumes:

- The host machine is trusted (your dev laptop).
- The MCP client (Claude Code) is trusted.
- Other processes on the same machine — including npm packages in
  your project's dependency tree — are **not** trusted.
- Other devices on the same network are **not** trusted.

### What deepPairing protects against

- **Cross-LAN access**: the daemon binds explicitly to `127.0.0.1`
  (`src/daemon/index.ts`, the `serve({ hostname: "127.0.0.1" })` call; the
  loopback predicates live in `src/http/guards.ts` and
  `src/http/origin-policy.ts`). Sibling devices on the same wifi cannot reach
  it. (This bullet used to cite `src/http/server.ts`, a file that has not
  existed for several releases — the routes live in `src/http/routes.ts`.)
- **Cross-Origin browser attacks** (tightened in D5): CORS allows
  cross-origin reads ONLY from `vscode-webview://` origins — a page on
  any other origin (including a different localhost port, e.g. a dev
  server) gets no `Access-Control-Allow-Origin` and cannot read any
  response, including the served HTML that carries the bearer token.
  The WebSocket upgrade requires the Origin to be absent (non-browser),
  the daemon's OWN host:port on a loopback hostname (same-origin +
  loopback — the loopback requirement also defeats DNS rebinding, where
  Origin and Host agree on a non-loopback name), or `vscode-webview://`.
  A malicious page — local or remote — can neither read HTTP responses
  nor subscribe to the event stream.
  **Breaking change note:** external browser tools built against the old
  any-loopback CORS policy will no longer receive CORS headers; use a
  non-browser client (the token file grants local-process access) or the
  companion UI itself.
- **Cross-project session bleed**: every HTTP route that touches a session
  store or mutates anything — and every WebSocket upgrade — requires the
  browser to send `X-Project-Hash` (or `?projectHash=` for WS). The daemon
  refuses requests for a different project's hash even from `localhost`.
  Five exemptions, all of which the middleware in `src/http/routes.ts`
  documents at its own definition:
  - `OPTIONS` (CORS preflight — browsers do not send custom headers on it);
  - any non-`/api` `GET` — the SPA document and `/assets/*`, fetched by plain
    navigation, which cannot carry a custom header;
  - `GET /api/daemon-info` — read-only discovery. The hash gate is
    chicken-and-egg here: the SPA asks this route *for* the hash;
  - `GET /api/projects` — read-only cross-daemon discovery for the project
    switcher, which queries peers whose hash it does not hold yet;
  - `POST /api/demo/run` — the scripted cold-clone demo entry point. Unlike
    the four above it DOES write: it creates a throwaway `demo_<ts>` session.
    It never targets an existing store, which is why the wrong-store threat
    model does not apply, and it is also the one mutation route deliberately
    exempt from the bearer-token gate.
- **Stale-tab routing**: a tab pinned to a daemon that has restarted
  on the same port (different project) gets a 403 on mutations
  rather than silently routing into the wrong store.
- **Atomic writes**: session and ledger writes go through `writeJsonAtomic`
  (`.tmp.PID.TS.RAND` + `renameSync`, `src/store/atomic-write.ts`) so a
  SIGKILL mid-write cannot corrupt the JSON store. This now also covers
  `deeppairing sessions merge` (which had a hand-rolled fixed-name `.tmp`) and
  `.deeppairing/hooks-state.json`, which the hooks write from separate
  short-lived processes. A hooks-state file that is nonetheless found
  unparseable is copied to `hooks-state.json.corrupt-<timestamp>` before the
  log is reset, so a torn write can never silently erase hook history.

### What deepPairing does NOT protect against

- **Malicious npm packages in your dependency tree** can read
  `.deeppairing/sessions/*` directly from disk. Treat any package
  in your `node_modules` as having access to your full
  pair-programming transcript for that project. There is no
  encryption-at-rest.
- **Malicious processes running as your user** can hit the daemon's
  unauthenticated HTTP routes and read or write session state. The
  Origin/hash gates only protect against browser callers; a local
  curl can bypass them with the right headers.
- **Information leakage to LLM providers**: deepPairing hands tool
  results to your MCP client (Claude Code) which forwards them to
  Anthropic's API. Anything in an artifact, comment, or recall
  response leaves your machine. This is the standard cost of using
  an LLM at all; deepPairing does not exfiltrate independently.
- **Global Philosophy Ledger blast radius**: the cross-project ledger
  at `~/.deeppairing/philosophy/v1.json` is shared by every project
  on the host. A malicious package that POSTs to
  `/api/philosophy/seed` could plant `approved: use eval() everywhere`
  as a stance that surfaces in every future deepPairing session
  across every project. Mitigations:
  - The seed route enforces a per-POST size cap — at most 50 lines and 16 KiB
    of UTF-8 per request. It is **not** rate-limited: there is no per-IP or
    per-window limiter, and `routes.ts` says so explicitly ("without needing a
    per-IP rate limiter, which is overkill for a localhost-only daemon"). The
    cap bounds the amplification of a single request, not the number of
    requests a local process can make.
  - Manual seeds are tagged `project="manual"` and visually distinct
    in the LedgerPanel.
  - The ledger file is plain JSON — inspect with
    `cat ~/.deeppairing/philosophy/v1.json` or use the
    `deeppairing doctor --fix` command (`pnpm link --global`'d after
    `pnpm build`; pre-1.0 the package is not on npm yet).

## Sensitive surfaces to be aware of

- `~/.deeppairing/philosophy/v1.json` — global cross-project ledger.
- `<project>/.deeppairing/sessions/<id>/` — full session transcript,
  comments, preflight traces. Add to your project's `.gitignore` if
  you don't want sessions committed.
- `<project>/.deeppairing/team.json` — team-shared rules. Intended to
  be committed; review changes in PRs.
- HTTP daemon port (deterministic per-project, in `3847-3974`) —
  localhost-only; per-port one daemon at a time, eviction requires the
  daemon's own pid in `X-DeepPairing-Confirm-Pid`.

### Hooks (what the plugin runs on your machine)

deepPairing installs two Claude Code hooks, both local-only, network-free, and fail-open:

- **PreToolUse (`server/preflight.mjs`)** runs before Edit/Write/MultiEdit and
  can raise a prompt for **two** distinct reasons. Both return
  `permissionDecision: "ask"` — a prompt you can approve or decline. Neither
  ever emits `deny` or silently blocks. Any error, a missing ledger, or a
  non-matching edit exits 0 (allow), so a hook fault can never stop your work.
  - **Rejected approach.** The proposed change matches an approach you
    previously rejected in this project.
  - **Guardrail backstop.** The edit targets a guardrail path — a migration
    directory, CI config (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`,
    `.circleci/`), infrastructure (`Dockerfile*`, compose files, `terraform/`,
    `k8s/`, `*.tfvars`), or a secret file (`.env*` other than checked-in
    templates such as `.env.example`/`.env.sample`, `config/secrets*`,
    `config/credentials*`, `config/master.key`) — at a moment when the agent has
    presented no findings, options, spec, or plan in this project's recent
    sessions. Those paths match at **any depth**, not only at the repository
    root, so `packages/api/migrations/002_drop_users.sql` in a
    monorepo is guarded like a root-level one; a file whose name merely
    contains a guardrail directory's name (`src/migrations.js`,
    `docs/migrations.md`) is not, though an extension-less file whose entire
    name is `migrations` is indistinguishable from the directory and does
    match. Depth matching explicitly stops at trees nobody edits deliberately:
    nothing under `node_modules/`, `bower_components/`, `vendor/`,
    `third_party/`, `.venv/`, `venv/`, `site-packages/`, `dist/`, `build/`,
    `out/`, `target/`, `coverage/`, `.next/`, `.nuxt/`, `.output/`, `.turbo/`,
    `__pycache__/`, `fixtures/`, `__fixtures__/`, `testdata/`, `test-data/`,
    `__snapshots__/`, `__mocks__/`, `examples/` or `example/` ever prompts. **The trade-off is deliberate:** a genuine
    migration or secret file that lives under one of those paths goes
    unguarded. Spurious prompts are the failure mode that gets a gate like this
    switched off, and this is a protocol backstop rather than a security
    boundary, so the exclusion is scoped for quiet rather than for coverage.
    It asks at most once per guardrail class per 30 minutes (per file for
    migrations and secrets). If the session store is missing, unreadable, or
    every session store present is unparseable, it stays silent (fail-open) —
    a single corrupt session alongside a readable one is skipped, and the
    readable one still decides. It can be switched off entirely with the
    environment variable
    `DEEPPAIRING_GUARDRAIL_BACKSTOP=off`, which leaves the rejected-approach
    prompt untouched. It is a protocol backstop, **not a security boundary** —
    it cannot stop a determined agent or a direct shell write.

    **Declining is not remembered.** A `PreToolUse` hook is never told how you
    answered — allow and decline both come back to it as silence — so the
    30-minute dedup stamp is written when the prompt is *raised*, not when it is
    resolved. If you decline, tell the agent why in the same breath: the hook
    will not ask again for that class (or that file) for 30 minutes, so an
    immediate retry of the same edit goes through without a prompt. The
    rejected-approach gate is the durable half of the mechanism — record the
    rejection there and it sticks across sessions.
- **Stop (`server/stop.mjs`)** runs when the agent finishes a turn. It only
  writes an advisory nudge to stderr (e.g. "pending artifacts need review") and
  always exits 0 — it can never trap the agent in a loop or block a stop.

Both hooks read only local JSON under `.deeppairing/`. Their only write is
`.deeppairing/hooks-state.json` — the small advisory log of hook fires the
companion UI reads, which also carries the guardrail backstop's
"already asked about this" timestamps — written temp-file-plus-rename under a
short-lived `hooks-state.json.lock` (so two hooks firing at once cannot lose
each other's records), with a `hooks-state.json.corrupt-<timestamp>` salvage
copy on the (rare) unparseable read. A lock older than five seconds is broken
automatically, and a hook that cannot take it within half a second writes
anyway rather than dropping the record — the hook never fails the tool call it
is gating. Timestamps in that file and in the session store are bounded on both
sides: a stamp more than five minutes in the future is treated as invalid and
pruned, so a skewed clock or a hand-edited date cannot disarm either gate
indefinitely. The hooks make no network calls and write no files outside the
project's `.deeppairing/` directory.

### The committed server bundle (`claude-plugin/server/`)

The plugin ships a self-contained JS bundle so it installs with no build step.
That bundle is generated, not hand-written, from `packages/mcp-server/src/` by
`packages/mcp-server/scripts/bundle-plugin.mjs`, and is reproducible:
`pnpm build:clean` wipes all caches and rebuilds it, and CI's "Plugin bundle
staleness gate" fails any PR whose committed bundle differs from a cold build.
You can diff the committed bundle against a fresh `pnpm build:clean` to verify it
matches the published source — there is no opaque binary and no post-install
download.

## Disclosure timeline (template)

For accepted reports we'll confirm within 5 business days, fix on
main within 14 days where feasible, publish a fix advisory at the
same time, and credit the reporter (unless they prefer anonymity).
