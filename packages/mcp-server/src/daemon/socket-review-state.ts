/**
 * #711 gate 4 — the companion WebSocket and a standalone review's End state.
 *
 * The socket is send-only: every browser write is an HTTP route, and those
 * routes already refuse a closing / ended / unverifiable review with typed
 * 409s (`withStandaloneWrite` / `withReviewWrite`). What the socket owes the
 * companion is the End STATE: a `review_ended` frame pushed when closeout
 * completes (create-daemon's `onEnded`), and the same frame on connect after
 * End. This module derives the on-connect frame from the durable marker alone
 * — it never opens or warms a writable store.
 */
import { ERROR_CODES } from "../error-codes.js";
import { isStandaloneSessionForProject } from "../standalone-session-id.js";
import { StandaloneCloseoutError, type StandaloneCloseout } from "./standalone-closeout.js";

export interface ReviewEndedFrame {
  type: "review_ended";
  sessionId: string;
  endedAt?: string;
  code: typeof ERROR_CODES.session_ended | typeof ERROR_CODES.session_marker_invalid;
  message?: string;
}

export type SocketReviewState =
  | { state: "open" | "closing" }
  | { state: "ended"; endedAt: string }
  | { state: "marker_invalid" };

/** The session's review state from the durable marker (plus the in-memory
 *  closing flag), or null when End does not apply (wrapper session, missing
 *  directory). Read-only; never throws. */
export function readReviewState(closeout: StandaloneCloseout, projectRoot: string, sessionId: string): SocketReviewState | null {
  if (!isStandaloneSessionForProject(sessionId, projectRoot)) return null;
  try {
    return closeout.state(sessionId);
  } catch (error) {
    if (error instanceof StandaloneCloseoutError && error.code === ERROR_CODES.session_marker_invalid) {
      return { state: "marker_invalid" };
    }
    return null;
  }
}

/** The `review_ended` frame for a tab connecting now, or null while the review
 *  is open or closing — a tab connected during closing hears End from the
 *  closeout broadcast, so it is never told twice. */
export function reviewEndedOnConnect(closeout: StandaloneCloseout, projectRoot: string, sessionId: string): ReviewEndedFrame | null {
  const state = readReviewState(closeout, projectRoot, sessionId);
  if (state?.state === "ended") return { type: "review_ended", sessionId, endedAt: state.endedAt, code: ERROR_CODES.session_ended };
  if (state?.state === "marker_invalid") {
    return {
      type: "review_ended", sessionId, code: ERROR_CODES.session_marker_invalid,
      message: "The standalone review's End marker cannot be verified. Review its session files before retrying.",
    };
  }
  return null;
}
