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
 *
 * #160 expanded the set CONSERVATIVELY under the same noise tradeoff:
 * every addition is a vendor-prefixed / structurally-unambiguous shape
 * (sk_live_, xox?-, npm_, github_pat_, the GCP service-account JSON
 * field, and a JWT that must carry the `eyJ` JSON-object marker on
 * BOTH its header and payload segments). Each ships with a should-match
 * fixture AND a near-miss test pinning the noise case it avoids
 * (secret-scan.test.ts) — a false-positive banner teaches users to
 * ignore the real one, so precision beats recall here.
 *
 * #160 also records WHERE a pattern matched: the 1-based `line` within
 * the scanned string and, for structured content, the `field` path
 * ("findings[0].evidence[1].snippet"). Locations are derived from the
 * match INDEX only — the matched value and its surrounding text are
 * NEVER captured (so surfacing a warning can't itself re-echo the
 * secret into the DOM / logs / exports).
 */

export interface SecretMatch {
  pattern: string;
  /** A short label suitable for telemetry / log ("OpenAI API key"). */
  label: string;
  /** #160 — 1-based line of the (first) match within the scanned string. */
  line?: number;
  /** #160 — dotted/bracketed path of the field the match was found in,
   *  e.g. "steps[2].preview". Only set by the structured-content walk. */
  field?: string;
}

const PATTERNS: ReadonlyArray<{ re: RegExp; pattern: string; label: string }> = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, pattern: "sk-", label: "OpenAI / Anthropic-shape API key" },
  { re: /\bAKIA[0-9A-Z]{12,20}\b/, pattern: "AKIA", label: "AWS access key id" },
  { re: /\bghp_[A-Za-z0-9]{20,}/, pattern: "ghp_", label: "GitHub personal access token" },
  { re: /\bgho_[A-Za-z0-9]{20,}/, pattern: "gho_", label: "GitHub OAuth token" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/, pattern: "glpat-", label: "GitLab personal access token" },
  { re: /\bya29\.[A-Za-z0-9_-]{20,}/, pattern: "ya29.", label: "Google OAuth access token" },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, pattern: "PEM", label: "Private key (PEM)" },
  // #160 — conservative expansion (see the noise-tradeoff note above).
  // Stripe LIVE mode only: sk_test_ is deliberately out (docs/test snippets
  // quote it constantly; a leaked test key is not the launch-day tweet).
  { re: /\bsk_live_[A-Za-z0-9]{16,}/, pattern: "sk_live_", label: "Stripe live secret key" },
  // Slack token families: bot (xoxb), user (xoxp), app (xoxa), refresh (xoxr),
  // signing/session (xoxs). Requires token-length payload after the dash so
  // prose like "tokens start with xoxb-" never trips it.
  { re: /\bxox[bpars]-[A-Za-z0-9][A-Za-z0-9-]{9,}/, pattern: "xox", label: "Slack token" },
  // npm automation tokens: npm_ + 36 base62 chars, NO underscores — which is
  // exactly what keeps npm_config_registry / npm_package_name (real env vars
  // in every npm lifecycle script) out.
  { re: /\bnpm_[A-Za-z0-9]{30,}/, pattern: "npm_", label: "npm access token" },
  // GitHub fine-grained PAT: github_pat_ + 22 base62 + "_" + 59 base62.
  // The exact 22-char first segment is required so a prose placeholder like
  // "github_pat_your_token_here" can't match.
  { re: /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{30,}/, pattern: "github_pat_", label: "GitHub fine-grained personal access token" },
  // GCP service-account JSON: the "private_key" field whose VALUE is a PEM
  // opener. `"private_key_id"` (sibling field, non-secret hex) can't match —
  // the field name must end exactly at the closing quote.
  { re: /"private_key"\s*:\s*"-----BEGIN/, pattern: '"private_key"', label: "GCP service-account key (JSON)" },
  // Signed JWT: three base64url segments. Collision-prone as a bare
  // three-dotted-segments shape, so BOTH the header and payload segments must
  // start with `eyJ` (base64url of `{"`) and the signature must be present
  // and token-length — an unsigned/two-segment example never matches.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/, pattern: "eyJ", label: "JWT (signed)" },
];

/** 1-based line number of a character index within `text`. Derived from the
 *  index alone — never reads the matched value. */
function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Scan a text blob for secret-shape patterns. Returns at most one
 * match per pattern (deduped) — the goal is to warn the user, not to
 * list every occurrence. #160 — each match carries the 1-based `line`
 * of its first occurrence.
 */
export function scanForSecrets(text: string | undefined | null): SecretMatch[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const matches: SecretMatch[] = [];
  for (const { re, pattern, label } of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      matches.push({ pattern, label, line: lineOfIndex(text, m.index) });
    }
  }
  return matches;
}

/**
 * Scan an array of text blobs (e.g., every Evidence.snippet on a
 * finding, plus the detail and recommendation). Returns the merged
 * deduped list of patterns matched across all blobs — first hit per
 * pattern wins, keeping its `line` (blobs are unlabeled, so no `field`).
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
 * Originally the generic fallback for revise_artifact's supersede path; #160
 * promoted it to THE scan for all present_* tools because the walk knows each
 * leaf's field path ("findings[0].evidence[1].snippet"), which the flat blob
 * lists could never report. Dedupe stays per-pattern — the first field to hit
 * a pattern wins and keeps its `field` + `line`.
 */
export function scanContentForSecrets(content: unknown, maxDepth = 6): SecretMatch[] {
  const seen = new Set<string>();
  const out: SecretMatch[] = [];
  const walk = (value: unknown, fieldPath: string, depth: number): void => {
    if (depth > maxDepth || value == null) return;
    if (typeof value === "string") {
      for (const m of scanForSecrets(value)) {
        if (seen.has(m.pattern)) continue;
        seen.add(m.pattern);
        out.push(fieldPath ? { ...m, field: fieldPath } : m);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${fieldPath}[${i}]`, depth + 1));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, fieldPath ? `${fieldPath}.${k}` : k, depth + 1);
      }
    }
  };
  walk(content, "", 0);
  return out;
}
