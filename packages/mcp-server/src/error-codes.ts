/**
 * IV7 — single source of truth for the error `code` field returned by
 * deepPairing's HTTP routes and surfaced in docs/troubleshooting.md.
 *
 * Failure mode this closes: the same code string was previously
 * hand-typed at every emission site (`http/routes.ts`, `daemon/routes.ts`,
 * `daemon/index.ts`) AND referenced as an H2 in docs/troubleshooting.md. A typo
 * at any site or in the doc silently drifted the contract — a user
 * who pasted the daemon's "code: session_not_registereed" string into
 * their search bar would not find the troubleshooting entry.
 *
 * Now: every site imports from this module, and a regression test
 * (`error-codes.test.ts`) asserts that every docs/troubleshooting.md H2
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
  /** C-4 — request arrived with a non-loopback Host header (DNS-rebinding guard). */
  forbidden_host: "forbidden_host",
  /** F6 — mutation targeted an artifact the bound session doesn't own (merged cross-session view). */
  artifact_not_in_session: "artifact_not_in_session",
  /** F6 — decision resolve for a decision the bound session doesn't know. */
  decision_not_in_session: "decision_not_in_session",
  /** F6 — mark-resolved for a comment the bound session doesn't own. */
  comment_not_in_session: "comment_not_in_session",
  /** #172 — take-counter/insist targeted a suggestion the agent hasn't countered. */
  suggestion_not_countered: "suggestion_not_countered",
  /** #172 — agent tried to counter a suggestion the human INSISTED on (their
   *  version is authoritative — apply verbatim, don't re-argue). */
  suggestion_insisted_authoritative: "suggestion_insisted_authoritative",
  /** #172 — a transition on a suggestion already shipped in a version (counter
   *  after apply, or a second apply stamping a different version). */
  suggestion_already_applied: "suggestion_already_applied",
  /** #172 — answer_question hit a pending/insisted suggestion without a valid
   *  suggestionState (the MUST-respond contract). */
  suggestion_response_required: "suggestion_response_required",
  /** POST /api/philosophy/remove targeted a concept the ledger doesn't hold. */
  stance_not_found: "stance_not_found",
  /** A ledger mutation was refused because the on-disk ledger is corrupt/frozen
   *  (H1-5 write-refusal surfaced as a structured route error). */
  ledger_frozen: "ledger_frozen",
  /** #171 — a changeset-review write targeted an artifact that isn't a
   *  changeset, or a file path that isn't part of it. */
  not_a_changeset_file: "not_a_changeset_file",
  /** #171 — the store can't persist changeset review state (a read-only /
   *  non-FileStore implementation lacks setChangesetFileReview). */
  unsupported: "unsupported",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Subset of ERROR_CODES that's documented in docs/troubleshooting.md. The
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
  /** #183 — the agent replayed a validation-error EXAMPLE payload verbatim as
   *  real content (the "Which cache layer?" field bug: a confused agent echoed
   *  the minimal example embedded in an INPUT_VALIDATION_FAILED message back as
   *  a real present_options call, twice, minting junk draft decisions). This is
   *  NOT a schema failure — the shape is valid; the CONTENT is the teaching
   *  sample. Agent should replace every value with real content and retry. */
  EXAMPLE_ECHO_REJECTED: "EXAMPLE_ECHO_REJECTED",
  /** #184 — the ROOT cause that preceded the echo: a tool call truncated in
   *  transit. `context`/`summary` streams before the required array
   *  (`options`/`findings`), the model's turn was cut off mid-call, so the
   *  args arrived with the earlier field present but the required array
   *  absent. A generic Zod "expected array, received undefined" mis-taught the
   *  agent (it invented a "1KB cap" AND echoed the embedded example). This code
   *  names the real failure so the agent retries with a shorter/split call
   *  instead of resubmitting an example. */
  TOOL_CALL_TRUNCATED: "TOOL_CALL_TRUNCATED",
  /** Preflight matched a stance the user has rejected — agent must revise approach, not retry. */
  REJECTED_APPROACH_BLOCKED: "REJECTED_APPROACH_BLOCKED",
  /** H1-6 — the artifact payload exceeded the daemon's body cap (413). Agent
   *  should trim/split the input and retry. */
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  /** H1-6 — a tool handler threw (e.g. daemon down/restarting). Usually
   *  transient; the agent can re-check state and retry. Distinct from a clean
   *  validation refusal — this is an unexpected error mapped to a clean
   *  isError result instead of a raw JSON-RPC protocol error. */
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
} as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

/** Retryability hint per tool error code. Used by `_meta.retryable`.
 *
 * #147 — TOOL_EXECUTION_FAILED's entry here is only the TRANSIENT-case
 * default: formatHandlerError (validate-tool-input.ts) computes the actual
 * `_meta.retryable` per error — daemon-tagged 5xx/408/429 and network-level
 * failures are retryable; other 4xx and untagged deterministic throws
 * (TypeError et al.) are NOT, so the agent doesn't loop-retry a bug. */
export const TOOL_ERROR_RETRYABLE: Record<ToolErrorCode, boolean> = {
  [TOOL_ERROR_CODES.INPUT_VALIDATION_FAILED]: true,
  // #183 — retryable: the agent can fix the call by substituting real content
  // for the echoed example, so its retry reflex should fire (same grain as
  // INPUT_VALIDATION_FAILED).
  [TOOL_ERROR_CODES.EXAMPLE_ECHO_REJECTED]: true,
  // #184 — retryable: a truncated call can succeed on a shorter/split retry.
  [TOOL_ERROR_CODES.TOOL_CALL_TRUNCATED]: true,
  [TOOL_ERROR_CODES.REJECTED_APPROACH_BLOCKED]: false,
  [TOOL_ERROR_CODES.PAYLOAD_TOO_LARGE]: true,
  [TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED]: true,
};
