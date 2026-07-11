/**
 * II5 — pin the WS error handlers in daemon.ts.
 *
 * Failure mode this closes: the daemon's wss.on("connection") path
 * registers a `close` listener but had no `error` listener. Real-world
 * triggers — RSV1 framing errors from a buggy proxy, EPIPE on a half-open
 * client, a slow-consumer backpressure abort — emit an `error` event on
 * the ws BEFORE `close`. With no listener, EventEmitter rethrows; the
 * daemon process dies, the wrapper has no auto-respawn, and the user's
 * companion UI silently stops updating until they notice.
 *
 * Council reviewer (engineering) flagged this as "the most likely
 * 'daemon mysteriously died overnight' report" at the pre-launch review.
 *
 * Two-part pin:
 *   1. Source-level assertion that daemon.ts wires error handlers on
 *      every ws path + on wss itself (regression for "a future PR
 *      removes the handler thinking it's redundant").
 *   2. Behavioral: an EventEmitter with no error listener throws when
 *      'error' is emitted; with our handler shape it does not. The
 *      assertion is on the Node-level invariant. (#157 — the wiring now
 *      lives in the importable daemon/create-daemon.ts factory, and
 *      create-daemon.test.ts exercises the real handlers; these source
 *      pins stay as the cheap belt.)
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// #157 — the WS connection/upgrade wiring moved from daemon/index.ts (an
// unimportable entry script) into the create-daemon.ts factory; pin the
// source that actually contains the handlers.
const daemonSrc = fs.readFileSync(path.resolve(here, "../daemon/create-daemon.ts"), "utf-8");

describe("II5 — WS error handler wiring", () => {
  it("daemon.ts registers ws.on('error') on the session-client path", () => {
    // The session-client block (sessionId branch) MUST register an error
    // handler before the close handler. Pin via a multiline match.
    expect(daemonSrc).toMatch(/ws\.on\(["']error["']/);
    // At least two occurrences — one per session/global branch — plus the wss-level handler.
    const occurrences = daemonSrc.match(/ws\.on\(["']error["']/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("daemon.ts registers wss.on('error') for listening-side errors", () => {
    // The server-level handler catches malformed upgrade frames the
    // per-client handler never sees (no ws object exists yet).
    expect(daemonSrc).toMatch(/wss\.on\(["']error["']/);
  });

  it("the error-handler pattern actually prevents an unhandled throw (Node-level invariant)", () => {
    // Sanity that the invariant we're relying on still holds in this
    // Node version: an EventEmitter with no 'error' listener throws,
    // with a listener it doesn't. If Node ever changed this we'd want
    // the test to fail loudly.
    const unhandled = new EventEmitter();
    expect(() => unhandled.emit("error", new Error("no listener"))).toThrow();

    const handled = new EventEmitter();
    let captured: Error | null = null;
    handled.on("error", (err) => { captured = err; });
    expect(() => handled.emit("error", new Error("handled"))).not.toThrow();
    expect(captured).toBeInstanceOf(Error);
  });
});
