# Troubleshooting

If something isn't behaving, start with:

```bash
node packages/mcp-server/dist/cli/init.js doctor --fix
```

> Once you've run `pnpm link --global` (or installed the package), this is just
> `deeppairing doctor --fix` — the same command the README links to.

That covers ~80% of first-time install issues. Below are the specific error
codes the daemon and wrapper return — paste one into your search bar and it
should land here.

---

## `daemon_auth_required` — 401 on every internal call

You'll see this in the MCP wrapper's stderr panel as a `[deepPairing]` error
like `Authorization required` or `Missing or invalid Authorization header`.

**What it means:** the daemon expected a `Bearer <token>` header on
`/api/internal/*` and didn't get one. The token lives in
`.deeppairing/daemon.json` (mode 0600) and the wrapper reads it on startup.

**Most likely causes**, in order:

1. **`.deeppairing/daemon.json` was deleted or zeroed** while the daemon was
   running. The daemon's heartbeat rewrites it every 30s — wait a moment,
   then re-run your command. If the file doesn't re-appear, the daemon
   isn't actually running; run `doctor --fix`.
2. **Two daemons collided on the same port** and the wrong one wrote
   `daemon.json`. Run `doctor --fix` — it will evict the squatter.
3. **The filesystem doesn't honor POSIX permission bits** (NFS-mounted
   home, some SMB shares). The daemon refuses to start in this case
   (the token would be world-readable) and surfaces a FATAL line in
   `.deeppairing/daemon.log`. Move the project to a local filesystem,
   or set `DEEPPAIRING_PROJECT_ROOT` to a local path.

## `project_hash_mismatch` — 403 from the companion UI

You'll see a red toast in the companion UI: *"Project hash mismatch —
your tab is pointed at a daemon serving a different project. Reload the
page to re-bind."*

**What it means:** the daemon's `projectHash` (sha256 of `projectRoot`,
sliced 8 chars) doesn't match the one your browser tab is sending. This
usually means a daemon restart claimed a different `projectRoot` than the
one your tab was bound to — typically because two daemons competed for the
same deterministic port slot (a project-hash collision in `3847-3974`, or a
recycled port after a restart) and the wrong one won.

**Fix:**

1. **Reload the page.** The browser will pick up the new daemon's hash
   from `/api/daemon-info` and re-bind. This works 9 times out of 10.
2. **If reload still fails:** the daemon you want isn't actually
   listening on the port your browser is hitting. Run `doctor --fix`
   from the directory you actually want to pair on; it will evict the
   squatter and start the right daemon.
3. **If the companion UI fails to load at all:** the daemon is not
   running. Either start it (run any deepPairing tool from Claude Code
   in this project) or run `doctor` to diagnose.

## `session_not_registered` — 404 on internal calls

You'll see this in the wrapper's logs after a daemon restart or eviction.

**What it means:** the wrapper sent a request scoped to a sessionId the
daemon doesn't know about. The daemon's in-memory session map is empty
for that id (most often because the daemon restarted).

**Self-heal:** the wrapper automatically re-registers and retries the
call once on this error (Z1 auto-recover). If you're seeing it
*repeatedly*, the wrapper's `expectedProjectRoot` doesn't match the
daemon's `projectRoot` — the wrapper refuses to silently rebind to a
different project. Restart Claude Code from the right directory.

## "Waiting for Claude" stays forever

The companion UI shows the *Waiting for Claude* panel and never advances
to a real artifact. The page **is** correctly connected to the daemon
(otherwise you'd see the red *Disconnected* banner).

**What it means:** the daemon is running, but no MCP wrapper has
registered a session yet. That means Claude Code hasn't successfully
loaded deepPairing's MCP server.

**Most likely causes:**

1. **Claude Code isn't running in this project.** The *Waiting* panel
   shows the daemon's `projectRoot` — confirm it matches the folder you
   ran `claude` in. If you opened Claude Code in a *different* folder,
   start it again in the right one.
2. **deepPairing isn't installed in this project's `.mcp.json`.** Run
   `init` (or the plugin install path) and restart Claude Code.
3. **The MCP server crashed on startup.** Check Claude Code's MCP
   stderr panel — the wrapper logs to `.deeppairing/server.log` and
   the daemon logs to `.deeppairing/daemon.log`. Doctor's `--fix` mode
   handles common spawn failures.

## Build / install fails on a fresh clone

* **`pnpm install` fails with peer dependency warnings:** harmless on
  Node 22+/pnpm 10+. The build still produces a working dist.
* **`pnpm build` succeeds but `node packages/mcp-server/dist/cli/init.js`
  errors:** check that `pnpm build` actually ran for the
  `@deeppairing/mcp-server` workspace. `pnpm --filter @deeppairing/mcp-server build`
  forces a rebuild.
* **Port already in use:** the daemon prefers its deterministic per-project
  port (derived from the project hash, in the `3847-3974` range) and sweeps
  for the next free slot if that one is busy. If it can't bind, doctor will
  tell you what's holding the ports.

## Still stuck?

Open an issue with:

* The output of `doctor --fix` (it's verbose on purpose).
* The last ~30 lines of `.deeppairing/daemon.log`.
* The error string from Claude Code's MCP panel.
