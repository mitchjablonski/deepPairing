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
 * Leak-proofing (test-infra port-flake fix):
 *   - EADDRINUSE forward-probes onward within [BASE_PORT, BASE_PORT+PORT_SPAN)
 *     — mirroring the real entry's bind loop — instead of the old
 *     `process.exit(2)`, so a busy preferred slot degrades instead of failing
 *     the suite.
 *   - A TTL self-destruct (default 120s) guarantees an ABORTED test run can
 *     never leak this process: four zombie fixtures from exactly that were
 *     found squatting the product's canonical port window on a dev machine.
 *     The timer is deliberately NOT unref'd: unref'd timers still fire while
 *     the server handle holds the loop, but a ref'd timer additionally rules
 *     out any early natural exit in the handle-free gaps of the async bind
 *     loop — and it can never overstay, because every exit path here
 *     (TTL, SIGTERM, bind-exhaustion, the daemon's exitProcess seam) is an
 *     explicit process.exit, never a "loop drained" natural exit.
 *
 * Config via env:
 *   DEEPPAIRING_PROJECT_ROOT      — the (scratch) project this daemon serves
 *   DEEPPAIRING_FIXTURE_VERSION   — the version to advertise (default 0.0.9)
 *   DEEPPAIRING_FIXTURE_TTL_MS    — self-destruct TTL (default 120000; the
 *                                   fixture-ttl test uses a short one)
 */
import { serve } from "@hono/node-server";
import crypto from "node:crypto";
import { createDaemon } from "../../daemon/create-daemon.js";
import { preferredPortFor, BASE_PORT, PORT_SPAN } from "../../project-root.js";

const projectRoot = process.env.DEEPPAIRING_PROJECT_ROOT;
if (!projectRoot) {
  process.stderr.write("old-version-daemon.fixture: DEEPPAIRING_PROJECT_ROOT is required\n");
  process.exit(1);
}
const version = process.env.DEEPPAIRING_FIXTURE_VERSION ?? "0.0.9";

// TTL self-destruct — armed from process start (before the bind loop) so even
// a fixture stuck probing ports expires. See the header note on why no unref.
const rawTtl = Number(process.env.DEEPPAIRING_FIXTURE_TTL_MS ?? "");
const ttlMs = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 120_000;
setTimeout(() => {
  process.stderr.write(`old-version-daemon.fixture: TTL (${ttlMs}ms) expired — self-destructing\n`);
  process.exit(0);
}, ttlMs);

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

type MinimalServer = {
  once(ev: string, cb: (err?: unknown) => void): void;
  off?(ev: string, cb: (err?: unknown) => void): void;
  close?(): void;
};

/** Bind one candidate port; resolve ok/err instead of throwing. Mirrors index.ts. */
function tryBind(candidate: number): Promise<{ ok: true; server: ReturnType<typeof serve> } | { ok: false; err: unknown }> {
  const candidateServer = serve({ fetch: daemon.app.fetch, port: candidate, hostname: "127.0.0.1" });
  return new Promise((resolve) => {
    const s = candidateServer as unknown as MinimalServer;
    const onError = (err: unknown) => {
      s.off?.("listening", onListening);
      resolve({ ok: false, err });
    };
    const onListening = () => {
      s.off?.("error", onError);
      resolve({ ok: true, server: candidateServer });
    };
    s.once("error", onError);
    s.once("listening", onListening);
  });
}

// Forward-probe on EADDRINUSE within the deterministic window, wrapping —
// the same walk the real entry (daemon/index.ts) does. Pre-fix the fixture
// process.exit(2)'d on the first busy slot, failing the suite whenever the
// preferred port happened to be taken.
const MAX_BIND_ATTEMPTS = 10; // mirrors lifecycle.ts MAX_PORT_ATTEMPTS
const preferred = preferredPortFor(projectRoot);
let boundPort = 0;
let lastBindErr: unknown = null;
for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS && !boundPort; attempt++) {
  const candidate = BASE_PORT + (((preferred - BASE_PORT) + attempt) % PORT_SPAN);
  const result = await tryBind(candidate);
  if (result.ok) {
    httpServer = result.server;
    boundPort = candidate;
    break;
  }
  lastBindErr = result.err;
  if ((result.err as NodeJS.ErrnoException | null)?.code !== "EADDRINUSE") {
    process.stderr.write(`old-version-daemon.fixture: bind failed on :${candidate} — ${result.err}\n`);
    process.exit(2);
  }
}
if (!boundPort || !httpServer) {
  process.stderr.write(
    `old-version-daemon.fixture: no free port in ${MAX_BIND_ATTEMPTS} slots from preferred ${preferred} — ${lastBindErr}\n`,
  );
  process.exit(2);
}

daemon.attachUpgradeHandler(httpServer as NonNullable<unknown>);
// Real discovery write — daemon.json carries pid/port/version exactly as a
// production daemon of that version would have written it.
daemon.writeDaemonInfo(boundPort);

// Mirror index.ts's graceful path so resolveStaleDaemon's SIGTERM produces a
// prompt port release + clean exit (what waitForPortRelease polls for).
process.on("SIGTERM", () => {
  try { httpServer?.close?.(); } catch { /* already closed */ }
  daemon.cleanup();
  process.exit(0);
});
