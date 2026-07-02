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
  (see `daemon.ts` and `http/server.ts`). Sibling devices on the same
  wifi cannot reach it.
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
- **Cross-project session bleed**: every HTTP route + WebSocket
  upgrade requires the browser to send `X-Project-Hash` (or
  `?projectHash=` for WS). The daemon refuses requests for a
  different project's hash even from `localhost`.
- **Stale-tab routing**: a tab pinned to a daemon that has restarted
  on the same port (different project) gets a 403 on mutations
  rather than silently routing into the wrong store.
- **Atomic writes**: all session and ledger writes go through
  `writeJsonAtomic` (`.tmp.PID.TS.RAND` + `renameSync`) so a SIGKILL
  mid-write cannot corrupt the JSON store.

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
  - The seed route is rate-limited (≤50 lines + ≤16 KiB UTF-8 per POST).
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

## Disclosure timeline (template)

For accepted reports we'll confirm within 5 business days, fix on
main within 14 days where feasible, publish a fix advisory at the
same time, and credit the reporter (unless they prefer anonymity).
