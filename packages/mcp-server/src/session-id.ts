/**
 * Artifact-session id derivation for a wrapper spawn.
 *
 * Extracted from standalone.ts so it is unit-testable without spawning a
 * daemon (standalone.ts runs main() at import time).
 */
import crypto from "node:crypto";
import path from "node:path";

export interface SessionIdResult {
  /** The composed artifact-session id (drives sessions/<id>/). */
  sessionId: string;
  /** `split` when a Claude session id was present + usable; `fallback` otherwise. */
  mode: "split" | "fallback";
  /** The sanitized Claude session id, present only in split mode. */
  claudeSessionId?: string;
}

/**
 * Derive the artifact-session id for a wrapper spawn.
 *
 * Base identity is per-projectRoot (U0.6): `session_<safeName>_<projectHash>`.
 * When Claude Code (>= v2.1.154) spawns us it sets `CLAUDE_CODE_SESSION_ID` in
 * the environment (== the session UUID == the transcript basename). When that
 * is present and usable we append a sanitized copy so each concurrent Claude
 * session gets its OWN artifacts/comments/decisions bucket under
 * `sessions/<id>/`. The moat (rejected approaches / guardrails) lives at
 * `projectRoot/.deeppairing` keyed by projectRoot, independent of sessionId,
 * so the per-session split can never fragment it by construction.
 *
 * FALLBACK — when the env value is absent, empty, or sanitizes to empty — this
 * returns the EXACT pre-split expression, byte-identical, so old clients
 * (`pnpm start`, non-Claude MCP clients, Claude Code < v2.1.154) resolve the
 * same id they always did.
 */
export function deriveSessionId(
  projectRoot: string,
  claudeSessionIdRaw?: string,
): SessionIdResult {
  const projectName = path.basename(projectRoot);
  const safeProjectName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const projectHash = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
  const base = `session_${safeProjectName}_${projectHash}`;

  // Path-safety: the sid is a UUID (hex + hyphens), but a malformed or hostile
  // env value must never escape sessions/ (path traversal: `../../etc`, `a/b`)
  // nor blow up the filename. Strip anything outside [a-zA-Z0-9-] and cap the
  // length. A value that sanitizes to empty (e.g. `..`, `///`) yields the
  // byte-identical fallback — never a crash, never an escape.
  const sanitized = (claudeSessionIdRaw ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);

  if (sanitized.length === 0) {
    return { sessionId: base, mode: "fallback" };
  }
  return { sessionId: `${base}_${sanitized}`, mode: "split", claudeSessionId: sanitized };
}
