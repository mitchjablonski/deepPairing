/**
 * #157 / #136 — REAL old-version daemon fixture.
 *
 * Spawned under tsx by ensure-daemon-version-gate.test.ts. A genuinely old
 * build can't be spawned from current source (SERVER_VERSION is a compile-time
 * literal), so this entry composes a REAL daemon through the production
 * `createDaemon` factory with the factory's version seam overridden — every
 * route, guard, and daemon.json write is the production code path; only the
 * advertised version differs. The bind + daemon.json-on-listen duties below
 * mirror index.ts's entry role (the factory never listens by design).
 *
 * Config via env:
 *   DEEPPAIRING_PROJECT_ROOT      — the (scratch) project this daemon serves
 *   DEEPPAIRING_FIXTURE_VERSION   — the version to advertise (default 0.0.9)
 */
import { serve } from "@hono/node-server";
import crypto from "node:crypto";
import { createDaemon } from "../../daemon/create-daemon.js";
import { preferredPortFor } from "../../project-root.js";

const projectRoot = process.env.DEEPPAIRING_PROJECT_ROOT;
if (!projectRoot) {
  process.stderr.write("old-version-daemon.fixture: DEEPPAIRING_PROJECT_ROOT is required\n");
  process.exit(1);
}
const version = process.env.DEEPPAIRING_FIXTURE_VERSION ?? "0.0.9";

let httpServer: ReturnType<typeof serve> | null = null;

const daemon = createDaemon({
  projectRoot,
  authToken: crypto.randomBytes(32).toString("hex"),
  log: () => {},
  exitProcess: (code) => process.exit(code),
  releaseListenSocket: () => {
    try { httpServer?.close?.(); } catch { /* already closed */ }
  },
  env: { DEEPPAIRING_NO_OPEN: "1" },
  version,
});

const port = preferredPortFor(projectRoot);
httpServer = serve({ fetch: daemon.app.fetch, port, hostname: "127.0.0.1" });
const s = httpServer as unknown as {
  once(ev: string, cb: (err?: unknown) => void): void;
  address(): { port: number } | null;
};
s.once("error", (err) => {
  process.stderr.write(`old-version-daemon.fixture: bind failed on :${port} — ${err}\n`);
  process.exit(2);
});
s.once("listening", () => {
  daemon.attachUpgradeHandler(httpServer as NonNullable<unknown>);
  // Real discovery write — daemon.json carries pid/port/version exactly as a
  // production daemon of that version would have written it.
  daemon.writeDaemonInfo(port);
});

// Mirror index.ts's graceful path so resolveStaleDaemon's SIGTERM produces a
// prompt port release + clean exit (what waitForPortRelease polls for).
process.on("SIGTERM", () => {
  try { httpServer?.close?.(); } catch { /* already closed */ }
  daemon.cleanup();
  process.exit(0);
});
