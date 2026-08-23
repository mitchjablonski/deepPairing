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
  DebriefContentSchema,
  ExplainerContentSchema,
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
 * A single Zod issue read through loose optional props (the Zod4 issue union
 * varies by code: `expected` on invalid_type, `origin` on too_small/too_big).
 * Kept lint-clean without asserting the full union.
 */
type LooseIssue = {
  code?: string;
  path: PropertyKey[];
  message: string;
  expected?: string;
  origin?: string;
  // IV/N2 — the actual bound on a too_small/too_big issue (Zod4 carries these).
  maximum?: number;
  minimum?: number;
};

/**
 * H2 — an ARRAY-LEVEL (cardinality) issue: too few / too many elements, or a
 * required array that arrived as the wrong type entirely. These are exactly the
 * violations a per-option field-noise slice buries ("…and 21 more"), so they
 * get hoisted to the FRONT of the message.
 */
function isArrayLevelIssue(i: LooseIssue): boolean {
  if ((i.code === "too_small" || i.code === "too_big") && i.origin === "array") return true;
  if (i.code === "invalid_type" && i.expected === "array") return true;
  return false;
}

/**
 * L1 — a TOP-LEVEL SCALAR omission/mismatch: a required string/number/enum
 * field that's missing, empty, or the wrong primitive type — path depth 1, no
 * structural (array/object/nested) component. When EVERY issue is one of these,
 * the fix is trivial and the full example dump is noise (and an echo-replay
 * temptation), so we emit a one-line targeted hint instead of the example.
 */
function isTopLevelScalarIssue(i: LooseIssue): boolean {
  if (i.path.length !== 1) return false;
  if (isArrayLevelIssue(i)) return false;
  if (i.code === "invalid_type" && (i.expected === "array" || i.expected === "object")) return false;
  return true;
}

/** Human-readable type tag for the L1 targeted-hint line. */
function scalarTypeTag(i: LooseIssue): string {
  if (i.code === "invalid_type" && i.expected) return i.expected;
  if (i.code === "invalid_value") return "enum";
  if ((i.code === "too_small" || i.code === "too_big") && i.origin) return i.origin;
  return "value";
}

/** N2 (#226 scope 2) — a scalar CONSTRAINT violation (too long / too short),
 *  as opposed to a missing / wrong-type omission. */
function isScalarBoundIssue(i: LooseIssue): boolean {
  return i.code === "too_big" || i.code === "too_small";
}

/** Resolve the received size at a top-level scalar path so we can report
 *  "got N" — string/array length, or the raw number for numeric caps. */
function receivedSize(input: unknown, path: PropertyKey[]): number | undefined {
  let cur: unknown = input;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  if (typeof cur === "string" || Array.isArray(cur)) return cur.length;
  if (typeof cur === "number") return cur;
  return undefined;
}

/**
 * N2 (#226 scope 2) — render a single top-level scalar issue.
 *
 * Pre-N2 a too_big on a scalar (a 300-char title vs a max(80) cap) was
 * flattened by scalarTypeTag into the SAME "missing or wrong type: `title`
 * (string)" line as a genuine omission — Zod's real "too big" message was
 * discarded, so the agent was told a field it DID send was absent. Now a
 * too_big/too_small renders the honest constraint: "`title`: too long (max 80
 * chars, got 300)".
 */
function scalarIssueClause(i: LooseIssue, input: unknown): string {
  const field = `\`${i.path.join(".") || "(root)"}\``;
  if (isScalarBoundIssue(i)) {
    const isString = i.origin === "string";
    const isArray = i.origin === "array";
    const unit = isString ? " chars" : isArray ? " items" : "";
    const size = receivedSize(input, i.path);
    const got = size !== undefined ? `, got ${size}` : "";
    if (i.code === "too_big") {
      return `${field}: too long (max ${i.maximum}${unit}${got})`;
    }
    return `${field}: too short (min ${i.minimum}${unit}${got})`;
  }
  // Missing / wrong primitive type — the original terse tag.
  return `${field} (${scalarTypeTag(i)})`;
}

/** Collapse numeric path indices to a wildcard so N identical per-item issues
 *  (options[0..4].pros: required) dedupe to one line: options[*].pros. */
function collapsePath(path: PropertyKey[]): string {
  return path
    .map((seg) => (typeof seg === "number" ? "[*]" : String(seg)))
    .join(".")
    .replace(/\.\[\*\]/g, "[*]");
}

/**
 * Format a Zod issue list into a single agent-facing message.
 *
 * L1 — when ALL issues are trivial top-level scalar omissions, emit a one-line
 * targeted hint and SKIP the example dump (saves ~487 tok + removes the
 * echo-replay temptation). H2 — otherwise hoist array-level/cardinality issues
 * to the FRONT (so "too few options" isn't buried behind per-option field
 * noise) and dedupe identical per-item messages before slicing. Mirrors the
 * REJECTED_APPROACH_BLOCKED tone so the LLM's "I should retry with a fixed
 * input" reflex kicks in.
 */
function formatValidationError(
  toolName: string,
  err: z.ZodError,
  example: string,
  // N2 (#226 scope 2) — the parsed input, so a too_big/too_small scalar can
  // report the received size ("got 300"). Optional: absent → the constraint
  // still renders honestly, just without the "got N" suffix.
  input?: unknown,
): ToolErrorResponse {
  const raw = err.issues as unknown as LooseIssue[];

  // L1 — trivial top-level scalar issue(s): targeted hint, no example dump.
  if (raw.length > 0 && raw.every(isTopLevelScalarIssue)) {
    const clauses = raw.map((i) => scalarIssueClause(i, input)).join(", ");
    // N2 — a scalar CONSTRAINT breach (too long/short) is not an omission, so
    // the "missing or the wrong type" lead-in would be a lie. Split the two.
    const hasBound = raw.some(isScalarBoundIssue);
    const text = hasBound
      ? `INPUT_VALIDATION_FAILED: ${toolName} refused — ${raw.length === 1 ? "a field is invalid" : "fields are invalid"}: ${clauses}. ` +
        `Fix ${raw.length === 1 ? "it" : "them"} and call ${toolName} again. The artifact was NOT created.`
      : `INPUT_VALIDATION_FAILED: ${toolName} refused — ${raw.length === 1 ? "a required field is" : "required fields are"} missing or the wrong type: ${clauses}. ` +
        `Add/fix ${raw.length === 1 ? "it" : "them"} and call ${toolName} again. The artifact was NOT created.`;
    return {
      content: [{ type: "text", text }],
      isError: true as const,
      _meta: { code: "INPUT_VALIDATION_FAILED", retryable: true },
    };
  }

  // H2 — hoist cardinality/array-level issues ahead of per-field noise.
  const cardinality = raw.filter(isArrayLevelIssue);
  const rest = raw.filter((i) => !isArrayLevelIssue(i));
  const ordered = [...cardinality, ...rest];

  // Dedupe: collapse numeric indices so options[0..4].pros: required is ONE
  // line. Singletons keep their literal path (so options.1.title stays exact).
  const groups = new Map<string, { first: LooseIssue; count: number }>();
  for (const i of ordered) {
    const key = `${collapsePath(i.path)}||${i.message}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { first: i, count: 1 });
  }
  const groupArr = [...groups.values()];
  const issues = groupArr.slice(0, 5).map((g) => {
    const path =
      g.count > 1
        ? collapsePath(g.first.path)
        : g.first.path.length
          ? g.first.path.join(".")
          : "(root)";
    const suffix = g.count > 1 ? ` (${g.count}×)` : "";
    return `  • ${path}: ${g.first.message}${suffix}`;
  });
  const more = groupArr.length > 5 ? `\n  • …and ${groupArr.length - 5} more` : "";
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
  // N2 (#226 scope 1c) — the retry advice used to say "retry" without telling
  // the agent a re-send is safe. For the present_* tools it now IS safe: the
  // short-window content-hash de-dup returns the existing artifact rather than
  // minting a twin, so an identical re-send after a transient error can't
  // duplicate. Only claim this for present_* (the tools the de-dup covers).
  const dedupSafeNote = toolName.startsWith("present_")
    ? ` If the error was transient, a re-send of identical content is safe — it will NOT create a duplicate (an identical draft presented in the last ~30s is de-duplicated to the existing artifact).`
    : "";
  const text = retryable
    ? `${code}: ${toolName} hit an unexpected error and did not complete: ${msg}.\n\n` +
      `This is usually transient (the daemon may be busy or restarting). The artifact may NOT have been ` +
      `created — call check_feedback to see the current state, then retry ${toolName} if needed.${dedupSafeNote}`
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
      "evidence": [
        { "filePath": "auth.ts", "lineStart": 23, "lineEnd": 23,
          "snippet": "const hash = bcrypt.hash(pw, 4);",
          "explanation": "Code path uses the weak cost factor." },
        { "locator": { "kind": "quote", "value": "passwords are hashed with 4 rounds" },
          "snippet": "passwords are hashed with 4 rounds",
          "explanation": "The security policy doc mandates the weak factor — anchor a doc/message passage with locator (kind: quote | heading | charRange | url) and NO file:line when it isn't code." }
      ],
      "significance": "high",
      "recommendation": "raise to 12+",
      "concept": { "name": "password-hash work factor tuning",
        "oneLineExplanation": "the cost should make brute-force impractical at today's hardware" }
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

const EXAMPLE_DEBRIEF = `{
  "title": "Debrief — rate limiting on the auth endpoints",
  "summary": "We added IP-based rate limiting to /login and /reset so credential-stuffing is throttled without hurting real users. Here is the walk of what changed, the calls I made alone, and what I'd like your eyes on.",
  "sections": [
    {
      "title": "Added a sliding-window limiter middleware",
      "body": "Requests to the auth routes now pass through a limiter keyed on client IP.",
      "concepts": [
        { "name": "sliding-window rate limiting",
          "oneLineExplanation": "counts requests in a moving time window instead of fixed buckets, so bursts at a boundary can't slip through" }
      ],
      "evidence": [
        { "filePath": "api/middleware/limit.ts", "lineStart": 12, "lineEnd": 14,
          "snippet": "if (window.count(ip) > MAX) return res.status(429).end();",
          "explanation": "The choke point every auth route inherits." }
      ],
      "changesetRef": "art_xxxxxxxxxx"
    }
  ],
  "decisionsMade": [
    { "what": "Return 429 with a Retry-After rather than a silent drop.",
      "why": "A silent drop makes the limit undebuggable for legitimate clients.",
      "alternative": "Fail open on limiter errors — rejected as too permissive for auth." }
  ],
  "needsYourEyes": [
    { "what": "The MAX threshold", "why": "Too low locks out real users; worth your call.",
      "artifactRef": "art_xxxxxxxxxx" }
  ],
  "deferred": [
    { "what": "Distributed limiter state", "why": "In-memory is fine single-instance; revisit when we scale out." }
  ],
  "openQuestions": ["Should the limit apply per-account as well as per-IP?"]
}`;

const EXAMPLE_EXPLAINER = `{
  "title": "How session authentication works here",
  "overview": "You're about to walk the request path for an authenticated route: how the cookie is read, where the session is looked up and its TTL refreshed, and what happens when it has expired. Read top to bottom — each step points at the exact code.",
  "sections": [
    {
      "heading": "1. The cookie is read at the middleware edge",
      "body": "Every authenticated route flows through requireSession, which first pulls the session id out of the signed cookie — no id, straight to 401.",
      "evidence": [
        { "filePath": "auth/middleware.ts", "lineStart": 22, "lineEnd": 24,
          "snippet": "const sid = readSessionCookie(req);\\nif (!sid) return res.status(401).end();",
          "explanation": "The gate before any lookup." }
      ]
    },
    {
      "heading": "2. The session is looked up and its TTL refreshed in one step",
      "body": "store.getAndTouch(sid) fetches the session AND slides its expiry forward, so no route has to remember to refresh."
    }
  ],
  "relatedArtifactIds": ["art_xxxxxxxxxx"],
  "suggestedQuestions": ["Where does the session get created in the first place?"]
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
const EX_DEBRIEF: unknown = JSON.parse(EXAMPLE_DEBRIEF);
const EX_EXPLAINER: unknown = JSON.parse(EXAMPLE_EXPLAINER);

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
 *  - debrief:   summary ONLY — the example summary is a full, highly specific
 *               narrative sentence (the debrief's distinctive scalar). A real
 *               debrief reusing the example TITLE with a different summary is
 *               admitted; only a verbatim summary replay is caught.
 *  - explainer: overview ONLY — the example overview is a full, highly specific
 *               paragraph (the explainer's distinctive scalar, exactly like the
 *               debrief's summary and the changeset's title). The title ("How X
 *               works here") is a common shape and is deliberately NOT an arm, so
 *               a real explainer reusing the example TITLE with a different overview
 *               is admitted; only a verbatim overview replay is caught. A title+
 *               overview AND-match was strictly WEAKER — changing either field
 *               defeated it — so it's replaced by the single distinctive scalar.
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
  present_debrief: (d) => normEcho(prop(d, "summary")) === normEcho(prop(EX_DEBRIEF, "summary")),
  present_explainer: (d) => normEcho(prop(d, "overview")) === normEcho(prop(EX_EXPLAINER, "overview")),
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

/**
 * Q2 — LENGTH-AWARE DIAGNOSIS.
 *
 * Round 12's cold journey hit this error on 2 of 3 artifact-creating calls and
 * self-recovered on retry, which raised the question of whether the detector
 * misfires. Investigated: it does NOT misfire on a "partially streamed" call —
 * the MCP server never sees a stream. CallToolRequestSchema parses a COMPLETE
 * JSON-RPC request before dispatch, and `args` is handed to the validator
 * untouched, so `options === undefined` means the client genuinely delivered an
 * arguments object without it. The advertised input schema marks the array
 * required in every case this lane covers (verified: present_options
 * required = ["context","options"], present_findings = ["summary","findings"]),
 * so the model was told.
 *
 * What WAS wrong is the diagnosis. The old text asserted "TRUNCATED in transit"
 * unconditionally and prescribed "retry with a shorter <field>" — advice that
 * only makes sense when the earlier field is actually big. A cutoff after 60
 * characters of `summary` would mean the turn ended almost immediately; far
 * likelier is that the model simply omitted a required array, and telling it to
 * shorten a 60-character summary sends it down a road that cannot fix
 * anything. So we keep one machine code (pinned, retryable) and one shape
 * clause, and let the LENGTH pick which cause to lead with — and, in the short
 * case, give the instruction that actually resolves it: resend with the array.
 *
 * Both branches keep #184's crucial invariant: NO embedded example, so this
 * path can never seed the example-echo it was built to stop.
 *
 * The threshold is deliberately BIASED toward the short branch, because the two
 * pieces of advice are not symmetric in cost. "Resend with the array" is the
 * right move whether the field was forgotten OR the call was truncated (a plain
 * retry usually clears a transient cutoff). "Shorten your context" is only
 * right if truncation is real, and is actively misleading otherwise. So the
 * expensive claim has to earn its evidence: we only lead with truncation when
 * the earlier field is big enough that running out of room is a real story.
 */
const TRUNCATION_PLAUSIBLE_CHARS = 400;

function formatTruncationError(
  toolName: string,
  missingArray: string,
  presentField: string,
  presentLength: number,
): ToolErrorResponse {
  const code = TOOL_ERROR_CODES.TOOL_CALL_TRUNCATED;
  const head =
    `${code}: ${toolName} refused — \`${missingArray}\` is missing while \`${presentField}\` is present. `;
  const diagnosis =
    presentLength >= TRUNCATION_PLAUSIBLE_CHARS
      ? `Your tool call appears to have been TRUNCATED in transit: \`${presentField}\` is ` +
        `${presentLength} characters, so the arguments were most likely cut off mid-message ` +
        `before \`${missingArray}\` was written. Retry with a shorter \`${presentField}\` (move ` +
        `detail into the ${missingArray} themselves) or split the call. `
      : `\`${presentField}\` is only ${presentLength} characters, so a mid-message cutoff is ` +
        `unlikely — you probably just left the required \`${missingArray}\` array out. Resend ` +
        `the same call WITH \`${missingArray}\` populated. If it fails the same way again, the ` +
        `call really is being truncated in transit: shorten \`${presentField}\` or split the call. `;
  const text =
    head +
    diagnosis +
    `Do NOT resubmit any example payload as your content. The artifact was NOT created.`;
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
    return formatTruncationError(toolName, missingArray, presentField, present.length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// M1.2 — FILE-KIND ENUM ALIASES.
//
// The same file operation is spelled three ways across the write tools:
//   - code_change + plan file_map: create / modify / delete
//   - changeset:                   added  / modified / deleted
// An agent that carried one family to the other tool got a hard schema reject
// (the dogfood: a changeset file typed `modify`, the code_change family). We
// normalize HERE — the validation choke point — so each field ACCEPTS both
// families but stores its OWN canonical spelling. Stored values are therefore
// byte-identical to today (UI/delivery/export goldens unchanged); only the
// previously-rejected cross-family input now succeeds. The advertised tool
// schemas keep their canonical 3-value enums (the agent is taught one spelling;
// the alias is a lenient safety net), so no advertised-schema snapshot moves.
const TO_CODE_FILE_KIND: Record<string, "create" | "modify" | "delete"> = {
  added: "create", modified: "modify", deleted: "delete",
};
const TO_CHANGESET_FILE_KIND: Record<string, "modified" | "added" | "deleted"> = {
  create: "added", modify: "modified", delete: "deleted",
};
/** Map an alias to canonical; pass everything else (already-canonical values,
 *  non-strings, junk) through untouched so the target enum still validates it. */
function aliasFileKind(v: unknown, map: Record<string, string>): unknown {
  return typeof v === "string" && map[v] ? map[v] : v;
}
/** Normalize the `changeType` on each element of an args file array (changeset
 *  files / plan-step FileChange lists), returning a NEW array so args is not
 *  mutated. Non-array / non-object elements pass through unchanged. */
function aliasFileArray(files: unknown, map: Record<string, string>): unknown {
  if (!Array.isArray(files)) return files;
  return files.map((f) =>
    f && typeof f === "object" && "changeType" in (f as object)
      ? { ...(f as Record<string, unknown>), changeType: aliasFileKind((f as Record<string, unknown>).changeType, map) }
      : f,
  );
}
/** Normalize plan visuals: a `file_map` visual carries files[] whose per-entry
 *  key is `change` (not `changeType`). Returns a new array; other visual kinds
 *  and non-file_map shapes pass through untouched. */
function aliasPlanVisuals(visuals: unknown): unknown {
  if (!Array.isArray(visuals)) return visuals;
  return visuals.map((v) => {
    if (!v || typeof v !== "object" || !Array.isArray((v as Record<string, unknown>).files)) return v;
    const files = ((v as Record<string, unknown>).files as unknown[]).map((f) =>
      f && typeof f === "object" && "change" in (f as object)
        ? { ...(f as Record<string, unknown>), change: aliasFileKind((f as Record<string, unknown>).change, TO_CODE_FILE_KIND) }
        : f,
    );
    return { ...(v as Record<string, unknown>), files };
  });
}

// ---------------------------------------------------------------------------
// S1 — FIELD-NAME ALIASES (the near-miss vocab split the dogfood hit).
//
// The same slot is spelled differently across sibling tools, and an agent that
// carried one spelling to the other got a HARD schema reject on a perfectly
// reasonable near-miss:
//   - a walk-through section's name: explainer uses `heading`, debrief uses `title`
//   - present_options' background prose: the field is `context`, but `question`
//     is the word an agent reaches for
// We normalize HERE — the same validation choke point as the M1.2 file-kind
// aliases above — so each field ACCEPTS the near-miss alias but STORES its own
// canonical spelling. Stored bytes are unchanged (UI/delivery/export goldens
// hold); only the previously-rejected near-miss now succeeds instead of failing
// the agent on a synonym. The advertised schemas keep their canonical field
// names (the agent is taught one spelling; the alias is a lenient safety net).
// Aliasing is copy-only and NON-destructive: it fills the canonical field ONLY
// when it is absent/empty AND the alias carries a non-empty string, so a real
// canonical value is never overwritten.

/** Copy `from`→`to` on a shallow clone of `o`, but ONLY when `to` is
 *  absent/empty and `from` is a non-empty string. Otherwise returns `o`
 *  untouched. Non-object inputs pass through. */
function aliasField(o: unknown, from: string, to: string): unknown {
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  const rec = o as Record<string, unknown>;
  const toVal = rec[to];
  const toEmpty = toVal === undefined || toVal === null || (typeof toVal === "string" && toVal.length === 0);
  const fromVal = rec[from];
  if (toEmpty && typeof fromVal === "string" && fromVal.length > 0) {
    return { ...rec, [to]: fromVal };
  }
  return o;
}

/** Apply aliasField to every element of a sections array (returns a new array;
 *  non-array / non-object elements pass through untouched). */
function aliasSectionField(sections: unknown, from: string, to: string): unknown {
  if (!Array.isArray(sections)) return sections;
  return sections.map((s) => aliasField(s, from, to));
}

// Per-tool input adapters: pull the relevant args fields, run the matching
// content schema. The schemas live in @deeppairing/shared and are already
// the source of truth for what the daemon stores.

export function validatePresentFindingsInput(args: any): ValidationResult<z.infer<typeof ResearchContentSchema>> {
  const result = ResearchContentSchema.safeParse({
    summary: args?.summary,
    // `findings` carries per-finding `concept` (R4 P-A) — passed whole, so the
    // schema validates + preserves it; a malformed concept errors loudly here.
    findings: args?.findings,
    openQuestions: args?.openQuestions,
    // R4 P-B — visuals must reach the schema to survive to disk. aliasPlanVisuals
    // normalizes a file_map visual's cross-family change kind (added→create).
    visuals: aliasPlanVisuals(args?.visuals),
  });
  if (result.success) return admit("present_findings", result.data);
  // #184 — truncation preempts the example-bearing generic error.
  const truncated = detectTruncatedCall("present_findings", args, "summary", "findings");
  if (truncated) return { ok: false, error: truncated };
  return { ok: false, error: formatValidationError("present_findings", result.error, EXAMPLE_FINDINGS, args) };
}

// D7 — extends the C6b single-source base instead of hand-redeclaring all
// ten fields (the last inline copy of the option shape). Wire-side deltas
// kept deliberately: id/title get .min(1) (agent input hygiene), and visuals
// stays the ID-OPTIONAL variant — a naive extend would inherit id-required
// visuals and break the C6b looseness contract (coerceOption assigns a
// stable option-scoped id when omitted).
const PresentOptionsInputSchema = z.object({
  context: z.string().min(1),
  // M1.1 — optional short question naming the fork. Trimmed + capped so it
  // stays a header, not a paragraph (the full background lives in `context`).
  title: z.string().trim().min(1).max(80).optional()
    .describe("A short question naming the fork, e.g. 'Which storage format for tags?' — the full background stays in context. Becomes the card header + the decision/session title."),
  options: z.array(DecisionOptionBaseSchema.extend({
    id: z.string().min(1).describe("Stable id — discussion threads anchor to it; KEEP IT ACROSS REVISIONS so a comment thread on an option survives a tune"),
    title: z.string().min(1),
    visuals: z.array(PlanVisualSchema.extend({ id: z.string().optional() })).optional(),
  })).min(2).max(4),
  stakes: z.enum(["low", "medium", "high"]).optional(),
});

export function validatePresentOptionsInput(args: any): ValidationResult<z.infer<typeof PresentOptionsInputSchema>> {
  // S1 — accept the `question` near-miss for `context` (fills context only when
  // absent/empty), so an agent that reached for the natural word doesn't fail.
  const aliased = aliasField(args, "question", "context");
  const result = PresentOptionsInputSchema.safeParse(aliased);
  if (result.success) return admit("present_options", result.data);
  // #184 — the exact field bug: context streamed, options truncated away.
  // Return the truncation error (no embedded example) BEFORE the generic one.
  // Check the aliased args so a `question`-only call isn't misread as a
  // context-missing truncation.
  const truncated = detectTruncatedCall("present_options", aliased, "context", "options");
  if (truncated) return { ok: false, error: truncated };
  return { ok: false, error: formatValidationError("present_options", result.error, EXAMPLE_OPTIONS, args) };
}

export function validatePresentSpecInput(args: any): ValidationResult<z.infer<typeof SpecContentSchema> & { title: string }> {
  // Spec needs a title (artifact-level) plus the content fields.
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_spec", titleParse.error, EXAMPLE_SPEC, args) };
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
    return { ok: false, error: formatValidationError("present_spec", contentParse.error, EXAMPLE_SPEC, args) };
  }
  return admit("present_spec", { title: titleParse.data.title, ...contentParse.data });
}

export function validatePresentPlanInput(args: any): ValidationResult<z.infer<typeof PlanContentSchema> & { title: string }> {
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_plan", titleParse.error, EXAMPLE_PLAN, args) };
  }
  const contentParse = PlanContentSchema.safeParse({
    // M1.2 — a plan step's structured FileChange list uses the code family too;
    // accept the changeset family and normalize both step files and file_map
    // visuals to create/modify/delete.
    steps: Array.isArray(args?.steps)
      ? args.steps.map((s: unknown) =>
          s && typeof s === "object" && "files" in (s as object)
            ? { ...(s as Record<string, unknown>), files: aliasFileArray((s as Record<string, unknown>).files, TO_CODE_FILE_KIND) }
            : s,
        )
      : args?.steps,
    estimatedChanges: args?.estimatedChanges,
    visuals: aliasPlanVisuals(args?.visuals),
  });
  if (!contentParse.success) {
    return { ok: false, error: formatValidationError("present_plan", contentParse.error, EXAMPLE_PLAN, args) };
  }
  return admit("present_plan", { title: titleParse.data.title, ...contentParse.data });
}

export function validatePresentCodeChangeInput(args: any): ValidationResult<z.infer<typeof CodeChangeContentSchema>> {
  const result = CodeChangeContentSchema.safeParse({
    filePath: args?.filePath,
    // M1.2 — accept the changeset family (added/modified/deleted) too.
    changeType: aliasFileKind(args?.changeType, TO_CODE_FILE_KIND),
    before: args?.before ?? "",
    after: args?.after ?? "",
    reasoning: args?.reasoning,
    confidence: args?.confidence,
    // Y5 — pass the agent-supplied concept through so the artifact carries it.
    concept: args?.concept,
  });
  if (result.success) return admit("present_code_change", result.data);
  return { ok: false, error: formatValidationError("present_code_change", result.error, EXAMPLE_CODE_CHANGE, args) };
}

export function validatePresentChangesetInput(args: any): ValidationResult<z.infer<typeof ChangesetContentSchema> & { title: string }> {
  // A changeset needs a title (artifact-level) plus the content fields.
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_changeset", titleParse.error, EXAMPLE_CHANGESET, args) };
  }
  const contentParse = ChangesetContentSchema.safeParse({
    summary: args?.summary,
    // M1.2 — accept the code_change family (create/modify/delete) on each file.
    files: aliasFileArray(args?.files, TO_CHANGESET_FILE_KIND),
    risks: args?.risks,
    // reviewState is HUMAN-driven (set via the review route), never taken from
    // agent input — deliberately not read here.
    // Q6 (#232) — reviewIntent/source ARE agent-supplied: only the agent knows
    // whether it is proposing this diff or showing someone else's PR. Both
    // optional; absent reviewIntent means "local", the pre-Q6 meaning.
    reviewIntent: args?.reviewIntent,
    source: args?.source,
    // R4 P-B — changeset-level visuals ("the shape of what this PR touches").
    visuals: aliasPlanVisuals(args?.visuals),
  });
  if (!contentParse.success) {
    return { ok: false, error: formatValidationError("present_changeset", contentParse.error, EXAMPLE_CHANGESET, args) };
  }
  return admit("present_changeset", { title: titleParse.data.title, ...contentParse.data });
}

export function validatePresentDebriefInput(args: any): ValidationResult<z.infer<typeof DebriefContentSchema> & { title: string }> {
  // #190 — a debrief needs a title (artifact-level) plus the content fields.
  // Like spec/changeset, title is validated first, so the #184 truncation lane
  // (earlier-scalar-present / required-array-absent) does NOT apply here — a
  // mid-stream cutoff surfaces as the title-missing path, and the echo guard
  // still nets any example replay.
  const titleParse = z.object({ title: z.string().min(1) }).safeParse(args);
  if (!titleParse.success) {
    return { ok: false, error: formatValidationError("present_debrief", titleParse.error, EXAMPLE_DEBRIEF, args) };
  }
  const contentParse = DebriefContentSchema.safeParse({
    summary: args?.summary,
    // S1 — accept the explainer's `heading` spelling on a debrief section and
    // normalize it to this type's canonical `title` (fills title only when
    // absent), so switching between the two walk-through types doesn't reject.
    sections: aliasSectionField(args?.sections, "heading", "title"),
    decisionsMade: args?.decisionsMade,
    needsYourEyes: args?.needsYourEyes,
    deferred: args?.deferred,
    openQuestions: args?.openQuestions,
    // R4 P-B — visuals framing the debrief.
    visuals: aliasPlanVisuals(args?.visuals),
  });
  if (!contentParse.success) {
    return { ok: false, error: formatValidationError("present_debrief", contentParse.error, EXAMPLE_DEBRIEF, args) };
  }
  return admit("present_debrief", { title: titleParse.data.title, ...contentParse.data });
}

export function validatePresentExplainerInput(args: Record<string, unknown> | null | undefined): ValidationResult<z.infer<typeof ExplainerContentSchema>> {
  // #190 A2 — the explainer's `title` is a real CONTENT field (part of the schema,
  // .min(1)), so we validate the whole ExplainerContentSchema in one pass rather
  // than extracting title first. That makes the #184 truncation lane MEANINGFUL
  // here (unlike spec/changeset/debrief, whose title is extracted first): the
  // canonical cutoff is a long `overview` streaming and the required `sections`
  // array getting truncated away — overview-present / sections-absent is exactly
  // the truncation signature. Route that to the no-example truncation error
  // BEFORE the generic example-bearing one (the echo-able example is what burned
  // us in #183/#184).
  const result = ExplainerContentSchema.safeParse({
    title: args?.title,
    overview: args?.overview,
    // S1 — accept the debrief's `title` spelling on an explainer section and
    // normalize it to this type's canonical `heading` (fills heading only when
    // absent), so switching between the two walk-through types doesn't reject.
    // The artifact-level `title` above is a separate top-level field, untouched.
    sections: aliasSectionField(args?.sections, "title", "heading"),
    relatedArtifactIds: args?.relatedArtifactIds,
    suggestedQuestions: args?.suggestedQuestions,
    // R4 P-B — the explainer's visuals (the round-13 headline: "draw me the
    // shape"). Must reach the schema or they are silently stripped.
    visuals: aliasPlanVisuals(args?.visuals),
    // R4 P-C — the honest-gaps list.
    unknowns: args?.unknowns,
  });
  if (result.success) return admit("present_explainer", result.data);
  const truncated = detectTruncatedCall("present_explainer", args, "overview", "sections");
  if (truncated) return { ok: false, error: truncated };
  return { ok: false, error: formatValidationError("present_explainer", result.error, EXAMPLE_EXPLAINER, args) };
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
  return { ok: false, error: formatValidationError("log_reasoning", result.error, EXAMPLE_REASONING, args) };
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

// G1 (#198b) — optional linkage from a present_* call to a human REQUEST it
// fulfils. When set, the handler marks that request served (its
// servedByArtifactId ← the new artifact) so the composer flips it and it drops
// out of the pending obligations. Advertised on the tools that fulfil the three
// request intents (explain→explainer, plan→plan/spec, status→debrief).
const SERVED_REQUEST_ID = z.string().optional()
  .describe("If this artifact serves a human request (from check_feedback's 'Human requests' block), the request id (e.g. 'req_ab12cd34ef') — links it so the request clears");

// #206 (I1) — optional FEATURE tag. Names the feature/milestone this artifact
// belongs to so the Features view can group a whole multi-run effort together
// instead of leaving most artifacts Ungrouped. The description teaches the
// stable-id convention (same lesson as decision-option ids): pick the tag ONCE
// and pass it IDENTICALLY on every artifact of the same feature — a new tag per
// run splinters the group. Normalized server-side to match the human's
// "Milestone N" title prefixes, so "Milestone 7" and "milestone-7" converge.
const FEATURE_TAG = z.string().optional()
  .describe("A short, STABLE tag for the feature/milestone this work belongs to (e.g. 'milestone-7', 'auth-rework'). Keep it IDENTICAL across every artifact of the same feature so they group together in the Features view — match the human's milestone naming if one exists; don't invent a new tag per run.");

// `satisfies` (not a Record annotation) keeps the literal keys, so property
// access stays exact under noUncheckedIndexedAccess.
export const TOOL_INPUT_SCHEMAS = {
  // #206 (I1) — `feature` is advertised on EVERY artifact-creating tool (the
  // whole point of slice 2: tag at the source so grouping recall stops leaking).
  // Advertisement-only, like servedRequestId — the per-tool validators build
  // their content from named fields and ignore it; the HANDLER reads args.feature
  // and threads it to createArtifact, which normalizes + persists featureId.
  present_findings: ResearchContentSchema.extend({
    title: ARTIFACT_TITLE.optional(),
    feature: FEATURE_TAG,
  }),
  present_options: PresentOptionsInputSchema.extend({
    relatedFindings: z.array(z.string()).optional()
      .describe("Artifact IDs of findings that motivated this decision"),
    feature: FEATURE_TAG,
  }),
  present_spec: SpecContentSchema.extend({ title: ARTIFACT_TITLE, servedRequestId: SERVED_REQUEST_ID, feature: FEATURE_TAG }),
  present_plan: PlanContentSchema.extend({
    title: ARTIFACT_TITLE,
    relatedFindings: z.array(z.string()).optional()
      .describe("Artifact IDs of findings that motivated this plan"),
    servedRequestId: SERVED_REQUEST_ID,
    feature: FEATURE_TAG,
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
    feature: FEATURE_TAG,
  }),
  log_reasoning: ReasoningContentSchema,
  // #171/#175 — multi-file changeset. `reviewState` and `reviewReasons` are
  // HUMAN-driven (set via the review route), so they're omitted from the
  // advertised input — the agent never sends them.
  present_changeset: ChangesetContentSchema.omit({ reviewState: true, reviewReasons: true }).extend({ title: ARTIFACT_TITLE, feature: FEATURE_TAG }),
  // #190 — the end-of-feature debrief. `summary` is the only required content
  // field (all others optional-tolerant); title is artifact-level.
  present_debrief: DebriefContentSchema.extend({ title: ARTIFACT_TITLE, servedRequestId: SERVED_REQUEST_ID, feature: FEATURE_TAG }),
  // #190 A2 — the read-only explainer walk-through. `title`, `overview`, and a
  // non-empty `sections[]` are the required core; `title` lives IN the content
  // schema (it doubles as the artifact title). G1 (#198b) adds the optional
  // servedRequestId linkage (the validator ignores it — it builds its own
  // content object from named fields — so it stays advertisement-only).
  present_explainer: ExplainerContentSchema.extend({ servedRequestId: SERVED_REQUEST_ID, feature: FEATURE_TAG }),
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
