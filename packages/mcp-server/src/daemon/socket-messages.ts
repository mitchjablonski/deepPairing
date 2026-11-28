/**
 * #711 gate 4 — the companion WebSocket and a standalone review's End state.
 *
 * The socket has always been daemon → companion; every browser write goes over
 * HTTP, where `withStandaloneWrite` / `withReviewWrite` admit it. This module is
 * the socket's inbound side: read-only requests are answered, and any other
 * message is a write candidate that must pass the SAME synchronous exact-session
 * admission (`StandaloneCloseout.admitWrite`) before a handler runs — so a
 * future socket write can never skip End. A refusal carries the HTTP codes
 * (`session_closing` / `session_ended` / `session_marker_invalid`), goes only
 * to the sending socket, and writes, broadcasts and stamps nothing.
 *
 * It also derives the `review_ended` frame a tab gets when End completes, or
 * on connect after End. That read is the marker check alone: it never opens a
 * writable store.
 */
import { ERROR_CODES } from "../error-codes.js";
import { isStandaloneSessionForProject } from "../standalone-session-id.js";
import { StandaloneCloseoutError, type StandaloneCloseout } from "./standalone-closeout.js";

type RefusalCode =
  | typeof ERROR_CODES.session_closing
  | typeof ERROR_CODES.session_ended
  | typeof ERROR_CODES.session_marker_invalid
  | typeof ERROR_CODES.session_not_found;

export interface SocketWriteRefusal {
  code: RefusalCode;
  message: string;
}

export type SocketAdmission = { release: () => void } | { refusal: SocketWriteRefusal };

const ENDED_MESSAGE = "This standalone review has ended.";
const CLOSING_MESSAGE = "This standalone review is closing. Retry after closeout settles.";

/** The synchronous admission HTTP writes take. A wrapper (non-standalone)
 *  session has no End and is admitted with a no-op release. */
export function admitSocketWrite(closeout: StandaloneCloseout, projectRoot: string, sessionId: string): SocketAdmission {
  if (!isStandaloneSessionForProject(sessionId, projectRoot)) return { release: () => {} };
  try {
    const release = closeout.admitWrite(sessionId);
    if (release) return { release };
    return closeout.state(sessionId).state === "ended"
      ? { refusal: { code: ERROR_CODES.session_ended, message: ENDED_MESSAGE } }
      : { refusal: { code: ERROR_CODES.session_closing, message: CLOSING_MESSAGE } };
  } catch (error) {
    if (error instanceof StandaloneCloseoutError && error.code === ERROR_CODES.session_marker_invalid) {
      return { refusal: { code: error.code, message: error.message } };
    }
    // The session directory is gone (or unreadable): nothing to write to.
    return { refusal: { code: ERROR_CODES.session_not_found, message: "Standalone review not found." } };
  }
}

export interface ReviewEndedFrame {
  type: "review_ended";
  sessionId: string;
  endedAt?: string;
  code: typeof ERROR_CODES.session_ended | typeof ERROR_CODES.session_marker_invalid;
  message?: string;
}

export interface ReviewStateFrame {
  type: "review_state";
  sessionId: string;
  state: "open" | "closing" | "ended" | "marker_invalid";
  endedAt?: string;
  code?: typeof ERROR_CODES.session_closing | typeof ERROR_CODES.session_ended | typeof ERROR_CODES.session_marker_invalid;
}

/** The session's review state from the durable marker (plus the in-memory
 *  closing flag), or null when End does not apply (wrapper session, missing
 *  directory). Read-only. */
export function readReviewState(closeout: StandaloneCloseout, projectRoot: string, sessionId: string): ReviewStateFrame | null {
  if (!isStandaloneSessionForProject(sessionId, projectRoot)) return null;
  try {
    const state = closeout.state(sessionId);
    if (state.state === "ended") return { type: "review_state", sessionId, state: "ended", endedAt: state.endedAt, code: ERROR_CODES.session_ended };
    if (state.state === "closing") return { type: "review_state", sessionId, state: "closing", code: ERROR_CODES.session_closing };
    return { type: "review_state", sessionId, state: "open" };
  } catch (error) {
    if (error instanceof StandaloneCloseoutError && error.code === ERROR_CODES.session_marker_invalid) {
      return { type: "review_state", sessionId, state: "marker_invalid", code: ERROR_CODES.session_marker_invalid };
    }
    return null;
  }
}

/** The `review_ended` frame for a tab connecting now, or null while the
 *  review is open/closing (a closing tab hears End through the broadcast). */
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

/** Inbound message types that never write. Everything else must be admitted. */
export const READ_ONLY_SOCKET_MESSAGES: ReadonlySet<string> = new Set(["ping", "review_state"]);

export interface SocketMessageContext {
  /** The session this socket subscribed to; null for a global (all-sessions) tab. */
  sessionId: string | null;
  admit: (sessionId: string) => SocketAdmission;
  reviewState: (sessionId: string) => ReviewStateFrame | null;
  /** Reply to THIS socket only. */
  reply: (frame: Record<string, unknown>) => void;
  /** Mutating handlers by message type. The daemon registers none today — every
   *  browser write is an HTTP route — so an admitted message with no handler is
   *  refused `unsupported`. A handler only ever runs after admission, and owns
   *  its own locks (e.g. withDecisionResolveLock) inside that admission. */
  mutations?: Readonly<Record<string, (message: Record<string, unknown>, sessionId: string) => void | Promise<void>>>;
  log?: (message: string) => void;
}

/** Handle one inbound frame. Never throws; never broadcasts. */
export async function handleSocketMessage(raw: string, ctx: SocketMessageContext): Promise<void> {
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== "string") {
      throw new Error("not a typed object");
    }
    message = parsed as Record<string, unknown>;
  } catch {
    ctx.reply({ type: "message_refused", code: ERROR_CODES.validation_error, message: "Socket messages must be JSON objects with a string `type`." });
    return;
  }
  const type = message.type as string;
  const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
  const { sessionId } = ctx;
  const refuse = (code: string, text: string) => ctx.reply({
    type: "message_refused", ...(sessionId ? { sessionId } : {}), ...(requestId ? { requestId } : {}),
    messageType: type, code, message: text,
  });

  if (READ_ONLY_SOCKET_MESSAGES.has(type)) {
    if (type === "ping") {
      ctx.reply({ type: "pong", ...(requestId ? { requestId } : {}) });
      return;
    }
    if (!sessionId) {
      refuse(ERROR_CODES.validation_error, "review_state needs a session-scoped socket.");
      return;
    }
    const state = ctx.reviewState(sessionId) ?? { type: "review_state", sessionId, state: "open" };
    ctx.reply({ ...state, ...(requestId ? { requestId } : {}) });
    return;
  }

  // A write needs an exact session: a global tab names none.
  if (!sessionId) {
    refuse(ERROR_CODES.unsupported, "Socket writes need a session-scoped socket.");
    return;
  }
  // Admission FIRST — synchronous, exact-session, before any handler or lock.
  const admission = ctx.admit(sessionId);
  if ("refusal" in admission) {
    refuse(admission.refusal.code, admission.refusal.message);
    return;
  }
  try {
    const handler = ctx.mutations?.[type];
    if (!handler) {
      refuse(ERROR_CODES.unsupported, "The companion socket accepts no writes; use the HTTP API.");
      return;
    }
    await handler(message, sessionId);
  } catch (error) {
    ctx.log?.(`[ws] socket message ${type} failed (session=${sessionId}): ${error instanceof Error ? error.message : String(error)}`);
    refuse("internal_error", "The socket message could not be applied.");
  } finally {
    admission.release();
  }
}
