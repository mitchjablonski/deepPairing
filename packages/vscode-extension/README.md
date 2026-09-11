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
