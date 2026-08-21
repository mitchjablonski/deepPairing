import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ERROR_CODES } from "../error-codes.js";

/**
 * R1 (#279) — the ceiling for the artifact-CREATE route only (see
 * applyTopLevelGuards). 512 KiB fits a large multi-file pull request's unified
 * diff with room to spare; the 85 KB PR that round 13 could not present is a
 * sixth of it. Still a bound, deliberately: a review surface that has to render
 * a megabyte of diff is not a review surface, and the honest answer there is to
 * split the change, which the 413 message says.
 */
export const ARTIFACT_CREATE_MAX_BODY_BYTES = 512 * 1024;

/**
 * R1 (#279) — is this the ONE route that mints an artifact?
 *
 * `POST /api/internal/sessions/:sessionId/artifacts`, exactly — not its
 * children (`…/artifacts/status-changes/acknowledge`,
 * `…/artifacts/:id/status`, …), which are small control messages and keep the
 * ordinary cap. Deliberately a path test rather than a body sniff: the guard
 * runs BEFORE the body is read (that is the point of a stream limiter), so
 * "does this body contain a changeset?" is not a question it can ask.
 */
export function isArtifactCreateRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return /^\/api\/internal\/sessions\/[^/]+\/artifacts$/.test(pathname);
}

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
  // R1 (#279) — THE ARTIFACT-CREATION LANE GETS A HIGHER CEILING.
  //
  // The 64 KiB cap (III6) is right for the surfaces it was written for:
  // comments, prompts, preferences — a normal one is under 4 KiB, and the cap
  // is what stops one hostile script or one frame-stamped 50 MB browser comment
  // from filling the disk. It is NOT right for a changeset. Round 13 put a real
  // 10-file pull request on the review surface and the create call died at
  // 85 KB with a 413: the effective ceiling was ~500 diff lines, which rules out
  // most PRs worth reviewing together — the flagship flow gated by a constant
  // chosen for comment bodies.
  //
  // MECHANISM — ONE catch-all middleware that picks its ceiling by route,
  // rather than a second `app.use(path, …)` registration. Hono runs EVERY
  // matching middleware, not just the most specific one, so a narrow 512 KiB
  // limiter registered beside the `"*"` 64 KiB limiter would leave the 64 KiB
  // one still rejecting — the raise would silently do nothing. Dispatching
  // inside the single catch-all makes the two limits mutually exclusive by
  // construction. What it buys:
  //   • the cap the flood-guard exists for is UNCHANGED on every other route,
  //     including every public/browser-reachable one;
  //   • the raised lane is `/api/internal/*`, which is bearer-gated (II1) — the
  //     caller already holds a 0600 secret out of daemon.json, so this is not
  //     new attack surface, it is headroom for the agent that is already
  //     trusted to write artifacts;
  //   • nothing about it weakens the authorization gate: what CAN be posted is
  //     decided by human verdicts in review-authorization.ts, never by size.
  //     (Splitting a PR across changesets to dodge the old cap no longer weakens
  //     the APPROVE gate either — R1's one-of-N fix requires ALL of them
  //     approved — but one changeset per PR remains the right default.)
  const artifactCreateLimit = bodyLimit({
    maxSize: ARTIFACT_CREATE_MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          error:
            `Request body exceeds the ${ARTIFACT_CREATE_MAX_BODY_BYTES}-byte artifact cap. ` +
            `A diff this large is past what one review surface can hold — split it by area (and keep each part a changeset your pair approves).`,
          code: ERROR_CODES.body_too_large,
        },
        413,
      ),
  });
  const defaultLimit = bodyLimit({
    maxSize: opts.maxBodyBytes,
    onError: (c) =>
      c.json(
        { error: `Request body exceeds ${opts.maxBodyBytes}-byte cap.`, code: ERROR_CODES.body_too_large },
        413,
      ),
  });
  app.use("*", (c, next) =>
    (isArtifactCreateRoute(c.req.method, c.req.path) ? artifactCreateLimit : defaultLimit)(c, next),
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
