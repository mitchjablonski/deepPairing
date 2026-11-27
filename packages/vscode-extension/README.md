# deepPairing VS Code extension — experimental preview

This extension is an experimental preview. There is no parity commitment with
the browser companion, and no date for one.

**The supported workflow is Claude Code plus the browser companion.** Install
deepPairing the normal way ([INSTALL.md](../../INSTALL.md)) and open the
companion UI at the daemon's port. That surface is the one the project supports.

## Known limitations

These come from reading the extension source. This assessment did not perform a
live VS Code smoke test.

- **Session selection is ignored.** Neither `src/extension.ts` nor
  `src/webview-provider.ts` carries a session id. The webview opens a WebSocket
  with a project hash and nothing else, so it gets whatever the daemon sends for
  the project. You cannot pick a session, and you cannot switch between two.
- **No authenticated REST bridge.** The provider reads a port out of
  `.deeppairing/daemon.json` and opens a raw WebSocket to `localhost`. There is
  no token and no authenticated HTTP path from the webview to the daemon.
- **No reconnect or disposal parity.** The provider has its own reconnect
  backoff and its own disposal path. This assessment did not compare either
  against the browser client. Daemon restarts, changed ports, repeated
  reconnects, and replay exit may behave differently here.
- **Page diagrams need a discovered daemon.** Mermaid blocks in page
  artifacts render in the daemon's sandboxed renderer frame
  (`/mermaid-renderer.html`). The webview CSP allows exactly
  `frame-src http://localhost:<port>` for the port read from
  `.deeppairing/daemon.json`, and the webview tells the companion that origin
  through a `deeppairing-daemon-origin` meta tag. With no `daemon.json` the
  webview allows no frames and diagrams show as source with a note
  ([#727](https://github.com/mitchjablonski/deepPairing/issues/727)). A
  daemon too old to serve the renderer page also falls back to source, after
  the renderer's load timeout.
- **Multi-root workspaces follow one daemon.** The webview starts on the
  freshest `daemon.json` and stays on that daemon while its file keeps being
  rewritten (the ~30 s heartbeat). It switches only when that file is removed,
  names another port, or goes stale (90 s) while another daemon is fresh.
  Each switch reloads the webview.
- **Remote workspaces are untested.** The webview's WebSocket runs in the
  extension host, so it reaches a daemon on the remote side. The renderer
  frame loads inside the webview, so the provider sets `portMapping` for the
  daemon port, which VS Code resolves on the extension host's side. Nobody
  has exercised this over SSH, WSL or Codespaces.
- **VS Code for Web is unsupported.** The extension needs Node (`fs` to read
  `daemon.json`, `ws` for the socket), so it doesn't run in a browser-hosted
  VS Code. The companion still prefers a valid daemon-origin meta over its
  own `https:` location, so diagrams wouldn't be the blocker there.
- **No live smoke test.** The package has no test script, and there is no
  documented smoke test that runs the extension inside VS Code. This assessment
  read the source and did not exercise the running extension.

## Package status

The package stays at version `0.0.1`. It is `private: true` and not configured
for publication. It stays in the tree as a preview you can build and try, not as
a finished surface.

## Building it

Build from the repository root:

```bash
pnpm install
pnpm build
```

`pnpm --filter deeppairing-vscode build` on its own is not enough: that script
runs `tsc && node build.mjs`, and `build.mjs` copies the companion web UI only
when `packages/mcp-server/dist/web` already exists, so on a clean clone the
webview renders "Web UI not found". The root build orders shared, then
mcp-server, then the extension, so the web UI exists by the time the extension
step copies it.

[Issue #345](https://github.com/mitchjablonski/deepPairing/issues/345) records
the support decision behind this preview. Full session binding and an
authenticated transport would need separate prioritisation.
