/**
 * V4 — non-blocking secret-shape scan for artifact / comment text.
 *
 * Threat model: the agent pastes an .env value or an API key into a
 * finding's `evidence.snippet`, a code-change `before`/`after`, or a
 * comment body. The string lands in `.deeppairing/sessions/*` on disk
 * AND is broadcast over the WebSocket AND is included in
 * `export_session` markdown. One tweet ("deepPairing leaked my
 * OPENAI_API_KEY into a JSON file") kills launch-day momentum.
 *
 * This is a heuristic warning, not a redactor. We don't modify the
 * text (the developer may have a legitimate reason — e.g., reviewing
 * a secret-scanner finding). Callers broadcast a `secret_warning`
 * event so the companion UI can surface a toast, and the daemon logs
 * which artifact tripped what pattern so the developer can react.
 *
 * Patterns are deliberately narrow: a vendor-prefixed key (sk-, AKIA,
 * ghp_, ya29., gho_, glpat-) or a PEM block opener. Generic
 * `password=...` patterns are too noisy (a code-review-finding
 * legitimately quotes `password=` from a config) so they're out.
 */

export interface SecretMatch {
  pattern: string;
  /** A short label suitable for telemetry / log ("OpenAI API key"). */
  label: string;
}

const PATTERNS: ReadonlyArray<{ re: RegExp; pattern: string; label: string }> = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, pattern: "sk-", label: "OpenAI / Anthropic-shape API key" },
  { re: /\bAKIA[0-9A-Z]{12,20}\b/, pattern: "AKIA", label: "AWS access key id" },
  { re: /\bghp_[A-Za-z0-9]{20,}/, pattern: "ghp_", label: "GitHub personal access token" },
  { re: /\bgho_[A-Za-z0-9]{20,}/, pattern: "gho_", label: "GitHub OAuth token" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/, pattern: "glpat-", label: "GitLab personal access token" },
  { re: /\bya29\.[A-Za-z0-9_-]{20,}/, pattern: "ya29.", label: "Google OAuth access token" },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, pattern: "PEM", label: "Private key (PEM)" },
];

/**
 * Scan a text blob for secret-shape patterns. Returns at most one
 * match per pattern (deduped) — the goal is to warn the user, not to
 * list every occurrence.
 */
export function scanForSecrets(text: string | undefined | null): SecretMatch[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const matches: SecretMatch[] = [];
  for (const { re, pattern, label } of PATTERNS) {
    if (re.test(text)) {
      matches.push({ pattern, label });
    }
  }
  return matches;
}

/**
 * Scan an array of text blobs (e.g., every Evidence.snippet on a
 * finding, plus the detail and recommendation). Returns the merged
 * deduped list of patterns matched across all blobs.
 */
export function scanManyForSecrets(blobs: ReadonlyArray<string | undefined | null>): SecretMatch[] {
  const seen = new Set<string>();
  const out: SecretMatch[] = [];
  for (const blob of blobs) {
    for (const m of scanForSecrets(blob)) {
      if (seen.has(m.pattern)) continue;
      seen.add(m.pattern);
      out.push(m);
    }
  }
  return out;
}

/**
 * #158 — scan EVERY string leaf of an artifact-content object (depth-bounded).
 * Used by revise_artifact, which supersedes any artifact type with arbitrary
 * new content: without a re-scan, a v2 would silently DROP a v1 warning (the
 * new artifact has no secretWarnings) — or miss a secret pasted into the
 * revision. The present_* tools keep their curated blob lists; this is the
 * generic fallback for the supersede path.
 */
export function scanContentForSecrets(content: unknown, maxDepth = 6): SecretMatch[] {
  const blobs: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > maxDepth || value == null) return;
    if (typeof value === "string") {
      blobs.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1);
    }
  };
  walk(content, 0);
  return scanManyForSecrets(blobs);
}
