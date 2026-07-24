/**
 * Validate `present_*` tool input against the shared content schemas BEFORE
 * the artifact is persisted. Returns either { ok: true, data } or
 * { ok: false, error } where `error` is the agent-facing tool-result content
 * already shaped — the caller just returns it.
 *
 * Why this exists: the `present_findings` field-bug. The agent passed
 * `findings: "<a long string>"` instead of `findings: [{...}, {...}]`.
 * The handler did `Array.isArray(args?.findings) ? args.findings : []` for
 * the proposal-extraction path but then persisted the raw `args.findings`
 * string anyway. The UI later iterated the string as if it were an array
 * (1610 character "findings"), threw inside ResearchArtifact, and the
 * ErrorBoundary blanked the whole panel. The agent had no idea anything
 * was wrong because the tool returned success.
 *
 * Validation happens HERE so:
 *   - The bad shape never lands on disk.
 *   - The agent gets a structured INPUT_VALIDATION_FAILED error naming
 *     the exact path that was wrong, what was expected, and a minimal
 *     correct example to retry from.
 *   - The error format mirrors REJECTED_APPROACH_BLOCKED so the LLM's
 *     retry logic treats it the same way.
 */
import { z } from "zod";
import { ERROR_CODES, TOOL_ERROR_CODES, TOOL_ERROR_RETRYABLE } from "../error-codes.js";
import {
  ResearchContentSchema,
  SpecContentSchema,
  PlanContentSchema,
  CodeChangeContentSchema,
  ReasoningContentSchema,
  ChangesetContentSchema,
  PlanVisualSchema,
  DecisionOptionBaseSchema,
} from "@deeppairing/shared";

export type ToolErrorResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  /**
   * IV10 — structured machine-readable error metadata. MCP clients can
   * branch on `_meta.code` / `_meta.retryable` instead of string-matching
   * the prose in content[0].text. Future-proofs the protocol surface
   * without changing the existing agent-visible contract.
   */
  _meta?: {
    code?: string;
    retryable?: boolean;
  };
};

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolErrorResponse };

/**
 * Format a Zod issue list into a single agent-facing message naming each
 * bad path, what was expected, and an inline example of the correct shape.
 * Mirrors the REJECTED_APPROACH_BLOCKED tone so the LLM's "I should retry
 * with a fixed input" reflex kicks in.
 */
function formatValidationError(
  toolName: string,
  err: z.ZodError,
  example: string,
): ToolErrorResponse {
  const issues = err.issues.slice(0, 5).map((i) => {
    const path = i.path.length ? i.path.join(".") : "(root)";
    return `  • ${path}: ${i.message}`;
  });
  const more = err.issues.length > 5 ? `\n  • …and ${err.issues.length - 5} more` : "";
  const text =
    `INPUT_VALIDATION_FAILED: ${toolName} refused — your input doesn't match the schema:\n` +
    issues.join("\n") + more + "\n\n" +
    // #183 — self-label the sample so a confused agent doesn't replay it as
    // real content. The echo guard (checkExampleEcho, below) is the real net;
    // this label is the cheap first line of defense.
    `Expected shape (EXAMPLE — replace EVERY value with your real content):\n${example}\n\n` +
    `Fix the input and call ${toolName} again. The artifact was NOT created.`;
  return {
    content: [{ type: "text", text }],
    isError: true as const,
    // IV10 — machine-readable code for future MCP clients. Same string
    // INPUT_VALIDATION_FAILED that's in the text body, but lifted into
    // _meta so clients can branch without parsing prose.
    _meta: { code: "INPUT_VALIDATION_FAILED", retryable: true },
  };
}

/** #147 — Node/undici network-failure codes. A throw carrying one of these is
 *  a dead socket / unreachable daemon: retrying can genuinely succeed. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** #147 — same signal when it only survives in the message. Every term is a
 *  SPECIFIC throw shape this process can actually see: the errno codes (Node
 *  stringifies them into connection-failure messages), undici's
 *  `TypeError: fetch failed`, a word-bounded "network error", and
 *  DaemonClient's dead-daemon rethrow ("daemon connection lost" — a plain
 *  untagged Error, client.ts request()). Deliberately NO bare
 *  `socket`/`network` terms: a deterministic `TypeError: Cannot read
 *  properties of undefined (reading 'socket')` must NOT classify as
 *  transient (pinned by test). */
const NETWORK_ERROR_MSG =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|fetch failed|\bnetwork error\b|daemon connection lost/i;

/**
 * H1-6 — turn an UNEXPECTED handler throw into a clean isError tool result,
 * mirroring formatValidationError. The CallToolRequestSchema dispatch wraps the
 * tool switch in a bare IIFE with no try/catch, so any throw (classically:
 * DaemonClient.request throwing on a 413/body-cap for an oversized-but-Zod-
 * valid artifact, or a transient daemon-down 5xx) propagated to the SDK as a
 * raw JSON-RPC protocol error — the agent got no actionable, retryable
 * guidance. This maps the throw to `{content, isError:true, _meta.code}` and
 * NEVER leaks a stack (only the sanitized message).
 *
 * #147 — retryability is now computed PER ERROR instead of the blanket
 * `retryable: true` that had the agent loop-retrying deterministic handler
 * bugs (a TypeError retried with identical input fails identically forever):
 *   - daemon-tagged `{status}` 5xx, 408, 429 → retryable: true (transient)
 *   - daemon-tagged other 4xx              → retryable: false (the request
 *     is wrong; the same input can't start working)
 *   - untagged network-level errors        → retryable: true (dead socket)
 *   - any other untagged throw (TypeError, RangeError, fs errors from an
 *     in-process FileStore, …)             → retryable: false (deterministic)
 *
 * `projectRoot` (default: process.cwd(), which is the project root for both
 * the standalone wrapper and the daemon) is used to relativize absolute
 * project paths an fs error message may carry — the user's directory layout
 * is not a secret, but it's noise the agent doesn't need verbatim.
 */
export function formatHandlerError(
  toolName: string,
  err: unknown,
  projectRoot: string = process.cwd(),
): ToolErrorResponse {
  const e = err as { message?: string; code?: string; status?: number } | undefined;
  // Sanitize: use only the message (never err.stack), and strip our own
  // "[deepPairing] " prefix so the agent sees a clean sentence.
  const rawMsg = e?.message ?? String(err);
  let msg = rawMsg.replace(/^\[deepPairing\]\s*/, "");
  // #147 — relativize the project root out of the message (in-process
  // FileStore fs errors carry the user's absolute project path). Trailing-
  // separator occurrences become relative paths; a bare occurrence becomes
  // "." — but ONLY at a path boundary: a review-caught repro showed root
  // `/home/u/proj` mangling a SIBLING path `/home/u/proj-archive/x` into
  // `.-archive/x`. The bare replacement therefore requires the next char to
  // be a quote / whitespace / punctuation-after-path (or end-of-string); the
  // separator case is already consumed by the withSep split above it.
  if (projectRoot && projectRoot !== "/" && msg.includes(projectRoot)) {
    const withSep = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
    const escaped = projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    msg = msg
      .split(withSep)
      .join("")
      .replace(new RegExp(`${escaped}(?=['"\`\\s,;:)\\]}]|$)`, "g"), ".");
  }

  const isBodyCap =
    e?.code === ERROR_CODES.body_too_large ||
    e?.status === 413 ||
    /body exceeds|too large/i.test(msg);

  if (isBodyCap) {
    const code = TOOL_ERROR_CODES.PAYLOAD_TOO_LARGE;
    const text =
      `${code}: ${toolName} could not be recorded — the artifact payload is too large for the daemon (${msg}).\n\n` +
      `Trim the input and retry: shorten long before/after or code snippets, split findings/steps across ` +
      `multiple ${toolName} calls, or summarize verbose evidence. The artifact was NOT created.`;
    return {
      content: [{ type: "text", text }],
      isError: true as const,
      _meta: { code, retryable: TOOL_ERROR_RETRYABLE[code] },
    };
  }

  // #147 — split transient from deterministic (see the function doc above).
  const status = typeof e?.status === "number" ? e.status : undefined;
  const looksNetwork =
    (typeof e?.code === "string" && NETWORK_ERROR_CODES.has(e.code)) ||
    NETWORK_ERROR_MSG.test(msg);
  const retryable =
    status !== undefined
      ? status >= 500 || status === 408 || status === 429
      : looksNetwork;

  const code = TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED;
  const text = retryable
    ? `${code}: ${toolName} hit an unexpected error and did not complete: ${msg}.\n\n` +
      `This is usually transient (the daemon may be busy or restarting). The artifact may NOT have been ` +
      `created — call check_feedback to see the current state, then retry ${toolName} if needed.`
    : `${code}: ${toolName} hit an unexpected error and did not complete: ${msg}.\n\n` +
      `This looks deterministic (a handler bug or an unsupported request), not transient — retrying the ` +
      `identical input will fail the same way. The artifact may NOT have been created — call check_feedback ` +
      `to see the current state, then adjust the input or approach before calling ${toolName} again.`;
  return {
    content: [{ type: "text", text }],
    isError: true as const,
    _meta: { code, retryable },
  };
}

// Minimal correct-shape examples per tool. Kept short — the goal is to
// jog the LLM's memory, not to inline the full schema doc.
const EXAMPLE_FINDINGS = `{
  "title": "Auth audit",
  "summary": "Two issues in auth.ts",
  "findings": [
    {
      "category": "security",
      "title": "Weak password hash",
      "detail": "bcrypt rounds=4 is too low",
      "evidence": "auth.ts L23 uses bcrypt.hash(pw, 4)",
      "significance": "high",
      "recommendation": "raise to 12+"
    }
  ]
}`;

const EXAMPLE_OPTIONS = `{
  "context": "Which cache layer?",
  "options": [
    { "id": "a", "title": "Redis", "description": "...", "pros": ["fast"],
      "cons": ["another service"], "effort": "medium", "risk": "low",
      "recommendation": true,
      "concept": { "name": "external cache service",
        "oneLineExplanation": "in-process is faster but loses on multi-instance" } },
    { "id": "b", "title": "In-memory LRU", "description": "...", "pros": ["simple"],
      "cons": ["per-instance"], "effort": "low", "risk": "medium",
      "recommendation": false,
      "concept": { "name": "in-process LRU",
        "oneLineExplanation": "no network hop; each instance keeps its own copy" } }
  ]
}`;

const EXAMPLE_SPEC = `{
  "title": "Rate limit auth endpoints",
  "objective": "Block credential stuffing",
  "requirements": [
    {
      "id": "REQ-1",
      "statement": "Limit /login to 5 attempts/min per IP",
      "rationale": "Slows brute-force without harming real users",
      "acceptanceCriteria": ["6th attempt within 60s returns 429"]
    }
  ]
}`;

const EXAMPLE_PLAN = `{
  "title": "Add rate limiting",
  "estimatedChanges": 3,
  "steps": [
    { "description": "Install limiter middleware", "reasoning": "...", "files": ["packages/api/middleware/limit.ts"] }
  ]
}`;

const EXAMPLE_CODE_CHANGE = `{
  "filePath": "packages/api/auth.ts",
  "changeType": "modify",
  "before": "bcrypt.hash(pw, 4)",
  "after":  "bcrypt.hash(pw, 12)",
  "reasoning": "Raise cost factor; rounds=4 is brute-forceable in <1 day",
  "concept": { "name": "password-hash work factor tuning",
    "oneLineExplanation": "the cost should make brute-force impractical at today's hardware" }
}`;

const EXAMPLE_REASONING = `{
  "action": "extract DI for the cache",
  "reasoning": "tests need to swap Redis for an in-memory fake",
  "concept": { "name": "dependency inversion",
    "oneLineExplanation": "depend on an interface, not a concrete impl" }
}`;

const EXAMPLE_CHANGESET = `{
  "title": "Move session-TTL refresh into middleware",
  "summary": "Centralize the sliding-window refresh so every route inherits it",
  "risks": ["touches auth"],
  "files": [
    {
      "path": "auth/middleware.ts",
      "changeType": "modified",
      "stats": { "additions": 4, "deletions": 2 },
      "hunks": [
        {
          "header": "@@ -24,4 +24,6 @@",
          "lines": [
            { "kind": "ctx", "content": "  const sid = readSessionCookie(req);", "oldLine": 25, "newLine": 25 },
            { "kind": "del", "content": "  const session = await store.get(sid);", "oldLine": 26 },
            { "kind": "add", "content": "  const session = await store.getAndTouch(sid);", "newLine": 26 }
          ]
        }
      ]
    },
    { "path": "auth/session.ts", "changeType": "modified",
      "hunks": [ { "lines": [ { "kind": "add", "content": "  expiresAt: number;", "newLine": 12 } ] } ] }
  ]
}`;

// ---------------------------------------------------------------------------
// #183 — EXAMPLE-ECHO GUARD.
//
// Field bug this closes: an agent's present_options call failed schema
// validation; the INPUT_VALIDATION_FAILED message embeds the EXAMPLE_OPTIONS
// payload ("Which cache layer?" / Redis / In-memory LRU) to teach the shape.
// The confused agent echoed that example VERBATIM as a REAL call — twice —
// minting junk "Which cache layer?" draft decisions in the user's real
// session. An example realistic enough to teach the shape is realistic enough
// to be replayed as content.
//
// The guard runs AFTER schema validation passes (the shape is valid — this is
// a CONTENT problem, not a shape problem) and BEFORE the artifact is created.
// It compares the payload's DISTINCTIVE content against fingerprints derived
// straight from the example JSON (so they never drift from the teaching text).
//
// Precision over recall: the match rule is exact/trim/case only — NEVER fuzzy.
// A real artifact that merely mentions caches / Redis / "cache layer" in prose
// but carries a different context/options is ADMITTED. Each fingerprint keys
// off a field distinctive enough that no real artifact collides with it (the
// example titles/contexts/statements were chosen to be memorable, which is
// exactly why they make good — and safe — fingerprints).

/** Read a property from an unknown value without asserting `any` — returns
 *  undefined for non-objects, keeping the guard total and lint-clean. */
const prop = (v: unknown, key: string): unknown =>
  v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
/** Trim + lowercase; non-strings normalize to "" (never match). */
const normEcho = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");
/** Pluck a field off each element of a list-valued property, normalized to a
 *  sorted set of non-empty terms. */
const pluckSet = (v: unknown, listKey: string, field: string): string[] => {
  const list = prop(v, listKey);
  const items = Array.isArray(list) ? list : [];
  return items.map((x) => normEcho(prop(x, field))).filter((s) => s.length > 0).sort();
};
/** Two sets are equal (order-independent) and BOTH non-empty. An empty
 *  candidate set never matches — an artifact with no options/findings/steps
 *  can't be an echo of an example that has them. */
const echoSetEq = (a: string[], b: string[]): boolean =>
  a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i]);

// Parse the examples ONCE into objects so every fingerprint is derived from the
// same source string the error message emits. Edit an example → its fingerprint
// tracks it automatically. (JSON.parse yields untyped values read only through
// the `prop`/`normEcho` helpers above.)
const EX_OPTIONS: unknown = JSON.parse(EXAMPLE_OPTIONS);
const EX_FINDINGS: unknown = JSON.parse(EXAMPLE_FINDINGS);
const EX_SPEC: unknown = JSON.parse(EXAMPLE_SPEC);
const EX_PLAN: unknown = JSON.parse(EXAMPLE_PLAN);
const EX_CODE_CHANGE: unknown = JSON.parse(EXAMPLE_CODE_CHANGE);
const EX_REASONING: unknown = JSON.parse(EXAMPLE_REASONING);
const EX_CHANGESET: unknown = JSON.parse(EXAMPLE_CHANGESET);

// NOTE: no `optionTitles` — present_options matches on the context scalar
// alone (the option-title set was a false-positive-prone arm, removed in the
// post-review tightening; see ECHO_MATCHERS).
const findingTitles = (o: unknown): string[] => pluckSet(o, "findings", "title");
const reqStatements = (o: unknown): string[] => pluckSet(o, "requirements", "statement");
const stepDescriptions = (o: unknown): string[] => pluckSet(o, "steps", "description");

/**
 * Per-tool echo matchers. Each returns true iff `data` (already schema-valid)
 * reproduces the tool's example distinctively enough to be a verbatim replay.
 * Keyed by the SAME toolName strings the validators pass to
 * formatValidationError, so a new tool with an embedded example just adds a
 * matcher here.
 *
 * GUIDING RULE (post-review tightening): a match ALWAYS requires the
 * DISTINCTIVE SCALAR (context/summary/title) to match. Item-sets (option
 * titles, finding titles, step descriptions, requirement statements) only ever
 * NARROW a scalar match — they never suffice on their own. An adversarial
 * review executed four false positives where a lone set-arm bounced legitimate
 * real content that is byte-indistinguishable from an example (e.g. a real
 * two-option caching decision titled exactly Redis / In-memory LRU — THE
 * canonical cache card). Those arms added ~zero marginal protection: the real
 * incident (call #1 verbatim, call #2 = same context + an extra Memcached
 * option) is fully caught by the context scalar alone.
 *
 * Field choices (and why they're false-positive-safe):
 *  - options:   context ONLY. The option-title set is NOT an arm — Redis /
 *               In-memory LRU is a real human's card, and the context scalar
 *               already catches both incident calls. A real decision with a
 *               different question is admitted no matter its option titles.
 *  - findings:  summary AND the finding-title set. Reusing just the summary, or
 *               just a finding title ("Weak password hash"), is admitted; only
 *               the full replay (both) is caught.
 *  - spec:      title AND the requirement-statement set. NOT objective —
 *               "Block credential stuffing" is reused by real spec tests. A
 *               real spec reusing only the title or only a statement is admitted.
 *  - plan:      title AND the step-description set. "Add rate limiting" is an
 *               extremely common exact title, so it cannot suffice alone; a
 *               real plan with that title but different steps, or the example
 *               step under a different title, is admitted.
 *  - code_change: filePath AND before AND after must ALL match — the fully
 *               distinctive tuple (a bcrypt 4→12 fix in that exact file is the
 *               example; any single field alone is a plausible real change).
 *  - reasoning: action OR reasoning — each is a full distinctive sentence (not
 *               a set arm); a real note mentioning Redis in different words is
 *               admitted.
 *  - changeset: title ONLY — the example title is a full, highly specific
 *               sentence. A real changeset reusing the example SUMMARY with a
 *               different title is admitted (summary is not an arm).
 */
const ECHO_MATCHERS: Record<string, (data: unknown) => boolean> = {
  present_options: (d) =>
    normEcho(prop(d, "context")) === normEcho(prop(EX_OPTIONS, "context")),
  present_findings: (d) =>
    normEcho(prop(d, "summary")) === normEcho(prop(EX_FINDINGS, "summary")) &&
    echoSetEq(findingTitles(d), findingTitles(EX_FINDINGS)),
  present_spec: (d) =>
    normEcho(prop(d, "title")) === normEcho(prop(EX_SPEC, "title")) &&
    echoSetEq(reqStatements(d), reqStatements(EX_SPEC)),
  present_plan: (d) =>
    normEcho(prop(d, "title")) === normEcho(prop(EX_PLAN, "title")) &&
    echoSetEq(stepDescriptions(d), stepDescriptions(EX_PLAN)),
  present_code_change: (d) =>
    normEcho(prop(d, "filePath")) === normEcho(prop(EX_CODE_CHANGE, "filePath")) &&
    normEcho(prop(d, "before")) === normEcho(prop(EX_CODE_CHANGE, "before")) &&
    normEcho(prop(d, "after")) === normEcho(prop(EX_CODE_CHANGE, "after")),
  log_reasoning: (d) =>
    normEcho(prop(d, "action")) === normEcho(prop(EX_REASONING, "action")) ||
    normEcho(prop(d, "reasoning")) === normEcho(prop(EX_REASONING, "reasoning")),
  present_changeset: (d) => normEcho(prop(d, "title")) === normEcho(prop(EX_CHANGESET, "title")),
};

/** The pointed, second-person-to-the-agent rejection. Fail-loud, in the grain
 *  of the rejection gate: name what went wrong, name the fix, confirm no
 *  artifact was created. */
function formatExampleEchoError(toolName: string): ToolErrorResponse {
  const code = TOOL_ERROR_CODES.EXAMPLE_ECHO_REJECTED;
  const text =
    `${code}: ${toolName} refused — this is the EXAMPLE payload from the validation-error message, ` +
    `not your real content. That sample only shows the SHAPE. Replace every value with your actual ` +
    `content (your real decision/context, findings, plan, or change) and call ${toolName} again. ` +
    `The artifact was NOT created.`;
  return {
    content: [{ type: "text", text }],
    isError: true as const,
    _meta: { code, retryable: TOOL_ERROR_RETRYABLE[code] },
  };
}

/**
 * The single chokepoint. Called by every per-tool validator on the success
 * path (and therefore by revise_artifact too, which reuses these validators):
 * if the schema-valid `data` echoes the tool's teaching example, return the
 * rejection; otherwise null (admit). Tools with no registered matcher (no
 * embedded example) are always admitted.
 */
export function checkExampleEcho(toolName: string, data: unknown): ToolErrorResponse | null {
  const matcher = ECHO_MATCHERS[toolName];
  if (matcher && matcher(data)) return formatExampleEchoError(toolName);
  return null;
}

/** Success-path wrapper: run the echo guard, then admit. Every validator ends
 *  through here so the guard is applied uniformly (and impossible to forget). */
function admit<T>(toolName: string, data: T): ValidationResult<T> {
  const echo = checkExampleEcho(toolName, data);
  if (echo) return { ok: false, error: echo };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// #184 — TRUNCATED TOOL-CALL detection (the ROOT cause upstream of the echo).
//
// A #184 spike root-caused the field failure that PRECEDED the example-echo:
// no server size cap exists (contexts to ~60KB pass; only the 64KiB body cap
// trips, with a clear PAYLOAD_TOO_LARGE). The real failure was an
// UPSTREAM-TRUNCATED tool call — `context` streams before `options`, the
// model's turn was cut off mid-call, so args arrived with `context` present
// but `options` absent. The generic Zod "options: expected array, received
// undefined" mis-taught the agent (it invented a "1KB cap" AND replayed the
// embedded example → the junk artifacts this PR's echo guard also nets).
//
// Detection signature: a required ARRAY field is `undefined` while a scalar
// sibling the schema streams BEFORE it is a non-empty string. That specific
// shape is what a mid-stream cutoff produces. We return a dedicated
// TOOL_CALL_TRUNCATED error that — crucially — embeds NO example (the echo-able
// example is exactly what burned us), so this path can't seed a replay. The
// generic example-bearing error stays for every OTHER schema mismatch (e.g. a
// present-but-wrong-type field, or the earlier sibling ALSO missing → the agent
// simply malformed the call).
//
// Applied only where the signature is meaningful (justified per-tool in the PR
// body): present_options (context→options) and present_findings
// (summary→findings). Skipped for present_plan (its required array `steps` is
// the FIRST advertised field — nothing streams before it), and for
// present_spec / present_changeset (their required `title` is advertised LAST
// via .extend and validated first, so a truncation reaching the required array
// already surfaces as the title-missing path — and the echo guard still nets
// any replay from it).

function formatTruncationError(
  toolName: string,
  missingArray: string,
  presentField: string,
): ToolErrorResponse {
  const code = TOOL_ERROR_CODES.TOOL_CALL_TRUNCATED;
  const text =
    `${code}: ${toolName} refused — your tool call appears to have been TRUNCATED in transit: ` +
    `\`${missingArray}\` is missing while \`${presentField}\` is present. This usually means the ` +
    `arguments were cut off mid-message (more likely with a long ${presentField}). Retry with a ` +
    `shorter ${presentField} or split the call. Do NOT resubmit any example payload as your ` +
    `content. The artifact was NOT created.`;
  return {
    content: [{ type: "text", text }],
    isError: true as const,
    _meta: { code, retryable: TOOL_ERROR_RETRYABLE[code] },
  };
}

/** Return a TOOL_CALL_TRUNCATED error iff the truncation signature holds:
 *  `presentField` is a non-empty string AND `missingArray` is undefined.
 *  Otherwise null (let the caller fall through to the generic error). A
 *  present-but-wrong-type array (e.g. `findings: "..."`) is NOT truncation —
 *  it stays on the generic path. */
function detectTruncatedCall(
  toolName: string,
  args: unknown,
  presentField: string,
  missingArray: string,
): ToolErrorResponse | null {
  const present = prop(args, presentField);
  const missing = prop(args, missingArray);
  if (typeof present === "string" && present.length > 0 && missing === undefined) {
    return formatTruncationError(toolName, missingArray, presentField);
  }
  return null;
}

// Per-tool input adapters: pull the relevant args fields, run the matching
// content schema. The schemas live in @deeppairing/shared and are already
// the source of truth for what the daemon stores.

export function validatePresentFindingsInput(args: any): ValidationResult<z.infer<typeof ResearchContentSchema>> {
  const result = ResearchContentSchema.safeParse({
    summary: args?.summary,
    findings: args?.findings,
    openQuestions: args?.openQuestions,
  });
  if (result.success) return admit("present_findings", result.data);
  // #184 — truncation preempts the example-bearing generic error.
  const truncated = detectTruncatedCall("present_findings", args, "summary", "findings");
  if (truncated) return { ok: false, error: truncated };
  return { ok: false, error: formatValidationError("present_findings", result.error, EXAMPLE_FINDINGS) };
}

// D7 — extends the C6b single-source base instead of hand-redeclaring all
// ten fields (the last inline copy of the option shape). Wire-side deltas
// kept deliberately: id/title get .min(1) (agent input hygiene), and visuals
// stays the ID-OPTIONAL variant — a naive extend would inherit id-required
// visuals and break the C6b looseness contract (coerceOption assigns a
// stable option-scoped id when omitted).
const PresentOptionsInputSchema = z.object({
  context: z.string().min(1),
  options: z.array(DecisionOptionBaseSchema.extend({
    id: z.string().min(1).describe("Stable id — discussion threads anchor to it; KEEP IT ACROSS REVISIONS so a comment thread on an option survives a tune"),
    title: z.string().min(1),
    visuals: z.array(PlanVisualSchema.extend({ id: z.string().optional() })).optional(),
  })).min(2).max(4),
  stakes: z.enum(["low", "medium", "high"]).optional(),
});

export function validatePresentOptionsInput(args: any): ValidationResult<z.infer<typeof PresentOptionsInputSchema>> {
  const result = PresentOptionsInputSchema.safeParse(args);
  if (result.success) return admit("present_options", result.data);
  // #184 — the exact field bug: context streamed, options truncated away.
  // Return the truncation error (no embedded example) BEFORE the generic one.
  const truncated = detectTruncatedCall("present_options", args, "context", "options");
  if (truncated) return { ok: false, error: truncated };
  return { ok: false, error: formatValidationError("present_options", result.error, EXAMPLE_OPTIONS) };
}

export function validatePresentSpecInput(args: any): ValidationResult<z.infer<typeof SpecContentSchema> & { title: string }> {
  // Spec needs a title (artifact-level) plus the content fields.
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_spec", titleParse.error, EXAMPLE_SPEC) };
  }
  const contentParse = SpecContentSchema.safeParse({
    objective: args?.objective,
    context: args?.context,
    requirements: args?.requirements,
    design: args?.design,
    tasks: args?.tasks,
    openQuestions: args?.openQuestions,
    visuals: args?.visuals,
  });
  if (!contentParse.success) {
    return { ok: false, error: formatValidationError("present_spec", contentParse.error, EXAMPLE_SPEC) };
  }
  return admit("present_spec", { title: titleParse.data.title, ...contentParse.data });
}

export function validatePresentPlanInput(args: any): ValidationResult<z.infer<typeof PlanContentSchema> & { title: string }> {
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_plan", titleParse.error, EXAMPLE_PLAN) };
  }
  const contentParse = PlanContentSchema.safeParse({
    steps: args?.steps,
    estimatedChanges: args?.estimatedChanges,
    visuals: args?.visuals,
  });
  if (!contentParse.success) {
    return { ok: false, error: formatValidationError("present_plan", contentParse.error, EXAMPLE_PLAN) };
  }
  return admit("present_plan", { title: titleParse.data.title, ...contentParse.data });
}

export function validatePresentCodeChangeInput(args: any): ValidationResult<z.infer<typeof CodeChangeContentSchema>> {
  const result = CodeChangeContentSchema.safeParse({
    filePath: args?.filePath,
    changeType: args?.changeType,
    before: args?.before ?? "",
    after: args?.after ?? "",
    reasoning: args?.reasoning,
    confidence: args?.confidence,
    // Y5 — pass the agent-supplied concept through so the artifact carries it.
    concept: args?.concept,
  });
  if (result.success) return admit("present_code_change", result.data);
  return { ok: false, error: formatValidationError("present_code_change", result.error, EXAMPLE_CODE_CHANGE) };
}

export function validatePresentChangesetInput(args: any): ValidationResult<z.infer<typeof ChangesetContentSchema> & { title: string }> {
  // A changeset needs a title (artifact-level) plus the content fields.
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_changeset", titleParse.error, EXAMPLE_CHANGESET) };
  }
  const contentParse = ChangesetContentSchema.safeParse({
    summary: args?.summary,
    files: args?.files,
    risks: args?.risks,
    // reviewState is HUMAN-driven (set via the review route), never taken from
    // agent input — deliberately not read here.
  });
  if (!contentParse.success) {
    return { ok: false, error: formatValidationError("present_changeset", contentParse.error, EXAMPLE_CHANGESET) };
  }
  return admit("present_changeset", { title: titleParse.data.title, ...contentParse.data });
}

export function validateLogReasoningInput(args: any): ValidationResult<z.infer<typeof ReasoningContentSchema>> {
  const result = ReasoningContentSchema.safeParse({
    action: args?.action,
    reasoning: args?.reasoning,
    concept: args?.concept,
    evidence: args?.evidence,
    relatesTo: args?.relatesTo,
    alternativesConsidered: args?.alternativesConsidered,
    alternativeDetails: args?.alternativeDetails,
    confidence: args?.confidence,
  });
  if (result.success) return admit("log_reasoning", result.data);
  return { ok: false, error: formatValidationError("log_reasoning", result.error, EXAMPLE_REASONING) };
}

// ---------------------------------------------------------------------------
// D4 — ADVERTISED input schemas, derived from the SAME zod shapes the
// validators run. Before this, server.ts hand-wrote all six write-tool
// JSON schemas and they drifted from the validators (the C6b options-visuals
// tightening was exactly this class). The wire deltas mirror validator
// behavior precisely:
//  - findings: title optional (server defaults it); spec/plan: title
//    required (validators .min(1) it). options/code_change do NOT advertise
//    title — their handlers derive it (context / changeType+filePath) and
//    never read args.title; advertising a dead field is the drift class
//    this map exists to kill (D4 review).
//  - code_change `before` is advertised optional — the validator fills ?? "".
// z.toJSONSchema emits from the same objects, so a schema edit reaches the
// validator and the advertisement in one place. server.test's C6b contract
// pins the shape.
// ---------------------------------------------------------------------------

const ARTIFACT_TITLE = z.string().min(1)
  .describe("Descriptive title for this artifact (e.g. 'Authentication System Analysis')");

// `satisfies` (not a Record annotation) keeps the literal keys, so property
// access stays exact under noUncheckedIndexedAccess.
export const TOOL_INPUT_SCHEMAS = {
  present_findings: ResearchContentSchema.extend({
    title: ARTIFACT_TITLE.optional(),
  }),
  present_options: PresentOptionsInputSchema.extend({
    relatedFindings: z.array(z.string()).optional()
      .describe("Artifact IDs of findings that motivated this decision"),
  }),
  present_spec: SpecContentSchema.extend({ title: ARTIFACT_TITLE }),
  present_plan: PlanContentSchema.extend({
    title: ARTIFACT_TITLE,
    relatedFindings: z.array(z.string()).optional()
      .describe("Artifact IDs of findings that motivated this plan"),
  }),
  present_code_change: CodeChangeContentSchema.extend({
    before: z.string().optional()
      .describe("Code before the change — omit for created files (server defaults to empty)"),
    after: z.string().describe("Code after the change — empty string for deletions"),
    // D4 review — the handler consumes this (relatedArtifactIds) but the
    // derived schema stopped advertising it: finding→code-change links died
    // of undiscoverability.
    relatedFindings: z.array(z.string()).optional()
      .describe("Artifact IDs of findings that motivated this change"),
  }),
  log_reasoning: ReasoningContentSchema,
  // #171/#175 — multi-file changeset. `reviewState` and `reviewReasons` are
  // HUMAN-driven (set via the review route), so they're omitted from the
  // advertised input — the agent never sends them.
  present_changeset: ChangesetContentSchema.omit({ reviewState: true, reviewReasons: true }).extend({ title: ARTIFACT_TITLE }),
} satisfies Record<string, z.ZodType>;

/** JSON-Schema form of a tool input for ListTools (typed for the SDK's
 *  inputSchema slot so call sites need no cast). */
export function toMcpInputSchema(
  schema: z.ZodType,
): { type: "object"; [k: string]: unknown } {
  const js = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete js.$schema;
  return js as { type: "object"; [k: string]: unknown };
}
