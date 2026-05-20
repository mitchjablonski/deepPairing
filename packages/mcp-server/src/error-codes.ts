/**
 * IV7 — single source of truth for the error `code` field returned by
 * deepPairing's HTTP routes and surfaced in TROUBLESHOOTING.md.
 *
 * Failure mode this closes: the same code string was previously
 * hand-typed at every emission site (`routes.ts`, `daemon-routes.ts`,
 * `daemon.ts`) AND referenced as an H2 in TROUBLESHOOTING.md. A typo
 * at any site or in the doc silently drifted the contract — a user
 * who pasted the daemon's "code: session_not_registereed" string into
 * their search bar would not find the troubleshooting entry.
 *
 * Now: every site imports from this module, and a regression test
 * (`error-codes.test.ts`) asserts that every TROUBLESHOOTING.md H2
 * matches a key here. A typo at any of those four surfaces fails the
 * test before it can ship.
 *
 * The `Code` type is exported so route handlers can be typed against
 * the union and tools that branch on the code (DaemonClient retry
 * logic, future MCP clients reading `_meta.code` from IV10) get
 * compile-time exhaustiveness instead of string-matching.
 */
export const ERROR_CODES = {
  /** /api/internal/* received a missing or invalid Authorization header. */
  daemon_auth_required: "daemon_auth_required",
  /** Wrapper called an internal route for a session the daemon doesn't know about. */
  session_not_registered: "session_not_registered",
  /** Wrapper registered with expectedProjectRoot != daemon's projectRoot. */
  project_mismatch: "project_mismatch",
  /** X-Project-Hash header missing or mismatched on a public route. */
  project_hash_mismatch: "project_hash_mismatch",
  /** /api/evict received the wrong X-DeepPairing-Confirm-Pid. */
  evict_pid_mismatch: "evict_pid_mismatch",
  /** III6 — request body exceeded the 64 KiB cap. */
  body_too_large: "body_too_large",
  /** Browser sent X-Session-Id but the daemon has no active session. */
  no_active_session: "no_active_session",
  /** Zod (or hand-rolled) validation failed on a request body. */
  validation_error: "validation_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Subset of ERROR_CODES that's documented in TROUBLESHOOTING.md. The
 * regression test asserts every key here has a matching `## <code>` H2
 * in the doc AND every H2 in the doc that looks like a code appears
 * here. Codes not in this set are internal — they may be returned over
 * the wire but a typical user shouldn't have to debug them directly.
 */
export const USER_FACING_ERROR_CODES: readonly ErrorCode[] = [
  ERROR_CODES.daemon_auth_required,
  ERROR_CODES.project_hash_mismatch,
  ERROR_CODES.session_not_registered,
];

/**
 * IV10 — MCP tool-level error codes. Distinct from the HTTP wire codes
 * above (which the daemon emits in JSON bodies). These get attached to
 * tool results via `_meta.code` so future MCP clients can branch on
 * retryability without string-matching the prose in content[0].text.
 *
 * `retryable: true` = the agent can fix the call and try again (bad
 * args, missing required field, transient state). `retryable: false` =
 * the call will fail the same way on retry (rejected concept, the
 * user has explicitly refused this kind of proposal, missing
 * dependency like `gh` CLI).
 */
export const TOOL_ERROR_CODES = {
  /** Zod validation failed on tool input — agent should fix the shape and retry. */
  INPUT_VALIDATION_FAILED: "INPUT_VALIDATION_FAILED",
  /** Preflight matched a stance the user has rejected — agent must revise approach, not retry. */
  REJECTED_APPROACH_BLOCKED: "REJECTED_APPROACH_BLOCKED",
} as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

/** Retryability hint per tool error code. Used by `_meta.retryable`. */
export const TOOL_ERROR_RETRYABLE: Record<ToolErrorCode, boolean> = {
  [TOOL_ERROR_CODES.INPUT_VALIDATION_FAILED]: true,
  [TOOL_ERROR_CODES.REJECTED_APPROACH_BLOCKED]: false,
};
