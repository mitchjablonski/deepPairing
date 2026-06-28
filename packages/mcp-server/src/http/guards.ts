import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ERROR_CODES } from "../error-codes.js";

/**
 * S1 — X-Project-Hash gate for ROOT-app routes that bypass the publicRoutes
 * hash middleware (sub-app middleware only covers sub-app routes). A stale tab
 * pointed at a daemon serving a DIFFERENT project would otherwise read this
 * project's data; the SPA seeds its hash from the served HTML, so a correctly-
 * bound tab always passes and a wrong-daemon tab 403s → BB10 "reload to re-bind".
 * No-op when daemonHash is undefined (test fixtures without a projectRoot).
 */
export function projectHashGate(daemonHash: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const sent = c.req.header("X-Project-Hash");
    if (daemonHash && sent !== daemonHash) {
      return c.json(
        { error: "Project hash mismatch — reload to re-bind.", code: ERROR_CODES.project_hash_mismatch, expected: daemonHash },
        403,
      );
    }
    return next();
  };
}

/**
 * Is the request's Host header a loopback name? The Host header is the
 * DNS-rebinding tell: a rebinding page still carries the ATTACKER's domain as
 * Host (the browser sends the name it navigated to), never a loopback name. A
 * MISSING Host (non-browser CLI / WS / Hono test requests) isn't the rebinding
 * vector, so it's allowed through to the downstream hash/bearer gates.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Apply the daemon's top-level guards to the ROOT app, BEFORE any sub-app is
 * mounted — so their coverage doesn't depend on registration order.
 *
 * Why this exists: the DNS-rebinding Host guard and the body cap used to live
 * as `app.use("*")` middleware INSIDE the public sub-app (createHttpRoutes).
 * Hono only runs sub-app middleware for routes registered AFTER the mount, so
 * the top-level daemon routes (/api/daemon-info, /api/active-sessions,
 * /api/live-session, …) and the internal routes were covered only by the luck
 * of mount-first ordering — a future refactor could silently un-guard them with
 * no test catching it. Hoisting the guards here makes coverage explicit and
 * order-independent (defense-in-depth; the sub-app keeps its own copies).
 *
 * Two guards:
 *   - bodyLimit MEASURES the request stream, so a chunked-transfer-encoding
 *     request with no Content-Length can't slip past (the old header-only check
 *     could — it skipped entirely when Content-Length was absent).
 *   - host guard rejects non-loopback Host headers.
 */
export function applyTopLevelGuards(app: Hono, opts: { maxBodyBytes: number }): void {
  app.use(
    "*",
    bodyLimit({
      maxSize: opts.maxBodyBytes,
      onError: (c) =>
        c.json(
          { error: `Request body exceeds ${opts.maxBodyBytes}-byte cap.`, code: ERROR_CODES.body_too_large },
          413,
        ),
    }),
  );
  app.use("*", async (c, next) => {
    if (!isLoopbackHost(c.req.header("host"))) {
      return c.json(
        { error: "Forbidden host — the daemon only serves loopback origins.", code: ERROR_CODES.forbidden_host },
        403,
      );
    }
    return next();
  });
}
