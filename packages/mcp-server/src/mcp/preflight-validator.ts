/**
 * U5 — PreflightValidator. The blocking-rule engine extracted from
 * server.ts so it's testable without spinning up the full MCP harness.
 *
 * Architecture review #3: server.ts had grown to 2000+ lines mixing
 * concept matching, glob matching, team-preference enforcement, and
 * rejected-approach pre-flight all interleaved with 13 MCP tool
 * handlers. Adding a new blocking rule meant inserting it carefully
 * into the god-function and edge cases (multi-level concept matches,
 * scope+concept interaction) were under-tested because spinning up
 * the harness was expensive.
 *
 * This module is pure logic — no broadcast, no MCP-shape concerns,
 * no store coupling beyond reading rejected-approaches and team-prefs
 * passed in by the caller. server.ts now imports `runPreflight` and
 * handles the broadcast + tool-error response itself; this file owns
 * the matching rules.
 */
import type {
  TeamPreference,
  PreflightConsideredConcept,
  PreflightNearMiss,
} from "@deeppairing/shared";
import type { RejectedApproach } from "../store/store-interface.js";

// ---------------------------------------------------------------------
// Phase-1 (B) — normalization + light stemming.
//
// This module is imported by BOTH the MCP-side preflight AND the hot
// PreToolUse hook (cli/preflight-hook-core.ts → runPreflight), and the hook
// runs via plain `node` from .deeppairing/hooks/ and MUST stay free of
// `@deeppairing/shared` at runtime. So everything here is dependency-free
// pure logic — no import of normalizeConceptKey/zod from shared.
// ---------------------------------------------------------------------

/**
 * D7-equivalent concept-key normalizer, INLINED here (not imported from
 * `@deeppairing/shared`) to keep the hook's runtime import graph free of the
 * shared package. Same contract as shared/normalize.ts: trim → lowercase →
 * collapse internal whitespace. Used for concept↔concept exact-key equality.
 */
export function normalizeConceptKey(name: string): string {
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Grammatical function words that never help (and shouldn't gate) a concept
 * match. Kept deliberately tiny — the "every meaningful token must appear"
 * semantics already make common words harmless; this only guards the case of
 * a concept whose ONLY tokens are function words. Checked pre-stem.
 */
const SHORT_STOPWORDS = new Set([
  "the", "and", "for", "but", "not", "use", "with", "from", "into", "onto",
  "that", "this", "than", "then", "via", "per", "our", "your", "its",
]);

/**
 * (B) Minimal, conservative, dependency-free suffix stemmer. Collapses obvious
 * inflectional morphology so "host" / "hosts" / "hosting" / "hosted" all map to
 * the stem "host". Deliberately UNDER-stems rather than over-stems: an
 * over-aggressive stemmer that collapses two unrelated words to the same stem
 * would manufacture a false-positive HARD BLOCK, whereas an under-stem just
 * misses and the residual is routed to the advisory near-miss channel.
 *
 * Guarantees relied on by the FP-guard tests:
 *   - "rail" (≤4 chars) is returned untouched, so it never equals "guardrail"
 *     (no suffix rule fires on "guardrail" → it stays "guardrail"). The
 *     rail∈guardrail false positive that was specifically patched stays dead.
 *   - Short acronyms (sql/orm/jwt/api/css, ≤4 chars) pass through verbatim, so
 *     they remain decisive tokens instead of being canonicalized away.
 */
export function stemToken(raw: string): string {
  const t = raw.toLowerCase();
  // Short words & acronyms: leave alone (precision guard; "rail" stays "rail").
  if (t.length <= 4) return t;
  if (t.endsWith("ing") && t.length >= 6) return t.slice(0, -3); // hosting → host
  if (t.endsWith("ed") && t.length >= 5) return t.slice(0, -2);  // hosted → host
  // Plural / 3rd-person "s", but NOT a doubled "ss" (class, address stay put).
  if (t.endsWith("s") && !t.endsWith("ss") && t.length >= 5) return t.slice(0, -1); // hosts → host
  return t;
}

/**
 * Tokenize a string into meaningful, STEMMED tokens. Splits on any
 * non-alphanumeric run (so "console.log" → ["console","log"], "pay-per-request"
 * → ["pay","per","request"], and "argon2id" stays one token). Drops
 * function-word stopwords and ≤2-char noise, keeps 3-char decisive acronyms
 * (sql/orm/jwt), then stems each survivor.
 *
 * (B) — threshold lowered from the legacy ≥4 to ≥3 so short acronyms count;
 * combined with the stopword guard this raises recall on acronym-driven
 * concepts without re-opening the short-fragment false positives (the surface
 * matcher's word-boundary guard is unchanged).
 */
export function meaningfulTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !SHORT_STOPWORDS.has(t))
    .map(stemToken);
}

/**
 * Y1' — fraction of meaningful concept tokens that appear in the proposal.
 * Returns 0..1. Used for near-miss detection: a stance is "almost flagged"
 * when the partial coverage is high enough to be relevant but below the
 * full-match threshold the blocking matchers use.
 *
 * (B) — now compares STEMMED token sets (was substring `.includes`), so a
 * near-miss survives morphology the same way a full match does.
 */
function tokenCoverage(concept: string, proposal: string): number {
  const tokens = meaningfulTokens(concept);
  if (tokens.length === 0) return 0;
  const pset = new Set(meaningfulTokens(proposal));
  const hits = tokens.filter((t) => pset.has(t)).length;
  return hits / tokens.length;
}

/** Threshold above which a partial match is surfaced as "near miss". */
const NEAR_MISS_THRESHOLD = 0.5;
/** Cap on `consideredConcepts` so the JSON stays small. */
const CONSIDERED_CAP = 20;

// ---------------------------------------------------------------------
// Matchers (pure utilities; exported for unit tests)
// ---------------------------------------------------------------------

/**
 * Concept-token check used by both rejected-approach matching and team-pref
 * matching. Returns true when every meaningful token from `concept` (stemmed)
 * is PRESENT AS A WHOLE STEMMED TOKEN in `proposal`.
 *
 * (B) — this is the unified normalized token-EQUALITY basis that both the
 * session lane and the team lane now share. Pre-Phase-1 the team lane used raw
 * `.includes()` (caught morphology but re-opened rail∈guardrail) and the
 * session lane used a word-bounded regex (no false positive but missed
 * morphology). Stemmed set-membership gets BOTH right: "host" matches
 * "hosting" (same stem) yet "rail" does NOT match "guardrail" (distinct stems,
 * and equality — not substring — is the test).
 */
export function conceptMatchesProposal(concept: string, proposal: string): boolean {
  const tokens = meaningfulTokens(concept);
  if (tokens.length === 0) return false;
  const pset = new Set(meaningfulTokens(proposal));
  return tokens.every((t) => pset.has(t));
}

/**
 * (A) Concept↔concept matcher — the biggest free precision win. When the
 * agent's proposal carries its OWN named concept(s) (present_options'
 * `option.concept.name`, present_code_change's `concept`), compare those SHORT
 * strings directly against each stored SHORT concept, instead of matching the
 * stored concept's tokens against the raw proposal PROSE (concept-vs-prose,
 * lower precision — the whole reasoning blob is a big haystack).
 *
 * Two tiers, both high-precision because BOTH sides are short:
 *   1. Exact normalized-key equality (normalizeConceptKey) — a clear match.
 *   2. Full stemmed token-set containment (every stored-concept token present
 *      as a whole stemmed token in the proposal concept) — short-vs-short, so
 *      this is far tighter than concept-vs-prose and safe to hard-block.
 *
 * Partial overlap is NOT returned here (the caller routes it to the advisory
 * near-miss channel via tokenCoverage), honoring the behavior invariant:
 * only a CLEAR normalized-concept match becomes a new hard block.
 */
export function findConceptToConceptMatch(
  proposalConcepts: string[],
  storedConcepts: string[],
): { proposalConcept: string; storedConcept: string } | null {
  for (const stored of storedConcepts) {
    if (!stored?.trim()) continue;
    const storedKey = normalizeConceptKey(stored);
    for (const pc of proposalConcepts) {
      if (!pc?.trim()) continue;
      if (normalizeConceptKey(pc) === storedKey) return { proposalConcept: pc, storedConcept: stored };
      if (conceptMatchesProposal(stored, pc)) return { proposalConcept: pc, storedConcept: stored };
    }
  }
  return null;
}

/**
 * Minimal glob matcher for team-preference scope paths. Supports:
 *   - `**` matches any sequence (including path separators)
 *   - `*`  matches any run of non-separator chars
 * Everything else is literal. Good enough for scoping rules like
 * `packages/auth/**`, `src/*.ts`. We avoid adding minimatch as a
 * dependency just for this.
 */
export function matchesGlob(pathStr: string, glob: string): boolean {
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++; // consume second *
    } else if (glob[i] === "*") {
      re += "[^/]*";
    } else {
      re += escape(glob[i]!); // `!` safe: i < glob.length loop bound
    }
  }
  return new RegExp(`^${re}$`).test(pathStr);
}

/**
 * Team-preference violation check. Two paths:
 *   - kind: "avoid"   → matches just like a rejected approach (concept tokens
 *     present in proposal). Returns the matched preference.
 *   - kind: "require" → only enforced when the concept is phrased as
 *     "<thing> for <domain>" (e.g. "argon2id for password hashing"). A
 *     proposal mentioning the domain ("password hashing") but lacking the
 *     required thing ("argon2id") is a violation. Concepts without a "for"
 *     clause stay advisory (firstCallHint surfaces them).
 *
 * Why advisory require: detecting "you should have done X but didn't" without
 * a domain ontology is too noisy. The "X for Y" convention is opt-in; teams
 * that want enforcement write their preferences that way.
 */
export function findTeamPreferenceViolation(
  proposalStrings: string[],
  prefs: TeamPreference[],
  proposalPaths: string[] = [],
): { proposal: string; pref: TeamPreference; via: "avoid" | "require" } | null {
  for (const pref of prefs) {
    if (pref.kind === "prefer") continue; // 'prefer' is taste, never blocks

    // Scope check: if the pref is scoped AND the proposal carries path info,
    // require at least one proposal path to match the scope. If the proposal
    // has NO paths, skip this pref — we can't verify scope, so we bias toward
    // NOT blocking (avoid false positives on unrelated work).
    if (pref.scope?.paths?.length) {
      if (proposalPaths.length === 0) continue;
      const hit = proposalPaths.some((p) => pref.scope!.paths!.some((g) => matchesGlob(p, g)));
      if (!hit) continue;
    }

    if (pref.kind === "avoid") {
      for (const proposal of proposalStrings) {
        if (!proposal.trim()) continue;
        if (conceptMatchesProposal(pref.concept, proposal)) {
          return { proposal, pref, via: "avoid" };
        }
      }
    }

    if (pref.kind === "require") {
      const forIdx = pref.concept.toLowerCase().indexOf(" for ");
      if (forIdx === -1) continue; // no "X for Y" → can't infer domain → advisory only
      const required = pref.concept.slice(0, forIdx).trim();
      const domain = pref.concept.slice(forIdx + 5).trim();
      if (!required || !domain) continue;
      for (const proposal of proposalStrings) {
        if (!proposal.trim()) continue;
        const mentionsDomain = conceptMatchesProposal(domain, proposal);
        if (!mentionsDomain) continue;
        const hasRequired = conceptMatchesProposal(required, proposal);
        if (!hasRequired) {
          return { proposal, pref, via: "require" };
        }
      }
    }
  }
  return null;
}

/**
 * Match a proposal against a list of previously-rejected approaches.
 *
 * Two layers:
 *   1) Surface: case-insensitive substring against the rejection description
 *      (and its colon-delimited fragments, so "Deploy: Railway" catches bare
 *      "Railway" proposals).
 *   2) Concept: when a rejected approach carries a `concept`, match if the
 *      concept's keywords appear anywhere in the proposal. This catches
 *      paraphrased re-proposals — e.g. "Deploy to Fly.io" still blocks
 *      after rejecting Railway with concept "pay-per-request hosting".
 */
/**
 * True when `needle` appears in `haystack` as a whole word / phrase, NOT as a
 * substring fragment. Both args are assumed already lower-cased.
 *
 * This is the fix for the surface false-positive: the old matcher used raw
 * `String.includes`, so a short rejected stance like "PR" matched inside
 * "a**ppr**oach" / "ex**pr**ess", and "rail" inside "guard**rail**" — blocking
 * unrelated proposals. A needle under 3 chars never matches; longer needles
 * must be flanked by a non-alphanumeric char or a string edge, so "railway"
 * still matches "deploy to railway" but not "guardrail".
 */
function containsAsPhrase(haystack: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length < 3) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`).test(haystack);
}

export function findRejectedApproachMatch(
  proposalStrings: string[],
  rejected: RejectedApproach[],
): { proposal: string; rejected: RejectedApproach; via: "surface" | "concept" } | null {
  const clean = (s: string) => s.trim().toLowerCase();
  for (const rej of rejected) {
    const rejNormalized = clean(rej.description);
    if (!rejNormalized) continue;
    // The portion AFTER the first colon is the specific rejection noun
    // ("Deploy: Railway" → "railway"); the prefix is the category and
    // recurs across unrelated rejections, so we don't match on it.
    const specificNoun = rejNormalized.includes(":")
      ? rejNormalized.split(":").slice(1).join(":").trim()
      : rejNormalized;
    for (const proposal of proposalStrings) {
      const p = clean(proposal);
      if (!p) continue;
      // Whole rejection description present as a phrase in either direction
      // (word-bounded, so a short stance can't match a fragment of a word).
      if (containsAsPhrase(p, rejNormalized) || containsAsPhrase(rejNormalized, p)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      // Specific noun of the rejection (post-colon), as a whole word.
      if (containsAsPhrase(p, specificNoun)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      // (B) Concept match: every meaningful STEMMED concept token present as a
      // whole stemmed token in the proposal. Unified with the team lane on the
      // same token-equality basis so this lane now catches morphology
      // ("hosting" ← concept "host") that the old word-bounded per-token regex
      // missed, WITHOUT re-opening rail∈guardrail (equality, not substring).
      if (rej.concept && conceptMatchesProposal(rej.concept, proposal)) {
        return { proposal, rejected: rej, via: "concept" };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Orchestrator — what server.ts calls
// ---------------------------------------------------------------------

export interface PreflightInput {
  toolName: string;
  proposalStrings: string[];
  proposalPaths?: string[];
  /**
   * (A) The proposal's OWN named concept(s) — e.g. present_options'
   * `option.concept.name` or present_code_change's `concept`. When present,
   * the validator runs a high-precision concept↔concept comparison (short vs
   * short) in addition to the legacy concept-vs-prose path. Optional and
   * defaults to [] so callers that don't name a concept (the hot hook against a
   * raw edit) are unaffected.
   */
  proposalConcepts?: string[];
  rejectedApproaches: RejectedApproach[];
  teamPreferences: TeamPreference[];
}

export interface PreflightBlock {
  source: "session" | "team";
  /** LLM-facing tool error message, ready to drop into a text content block. */
  message: string;
  /** Companion-UI broadcast payload: shape matches the legacy `preflight_blocked` event. */
  broadcastEvent: {
    type: "preflight_blocked";
    toolName: string;
    source: "session" | "team";
    match: Record<string, unknown>;
  };
}

/**
 * Y1' — trace payload the validator computes alongside its block decision.
 * The caller persists it to disk + broadcasts it; the UI renders the
 * "Cross-checked your N prior stances" breadcrumb from these fields.
 *
 * Note: `at` and `artifactId` belong to the caller (the validator doesn't
 * know which artifact it ran for; it gets called BEFORE createArtifact).
 * The orchestrator returns the partial trace here; the caller stamps
 * those two fields when persisting.
 */
export interface PreflightTracePartial {
  decision: "admitted" | "blocked";
  consideredCount: number;
  consideredConcepts: PreflightConsideredConcept[];
  nearMisses: PreflightNearMiss[];
  block?: {
    source: "session" | "team";
    concept?: string;
    reason?: string;
    via?: "surface" | "concept" | "avoid" | "require";
  };
}

export type PreflightResult =
  | { blocked: false; trace: PreflightTracePartial }
  | { blocked: true; block: PreflightBlock; trace: PreflightTracePartial };

/**
 * Run both lanes of the pre-flight check (session-rejected first, then
 * team prefs) and return a structured result. Caller is responsible for
 * the broadcast and the MCP-shape error response — those are
 * presentation concerns this module deliberately does not own.
 *
 * Order matters: session-rejected wins because it's the user's most
 * recent stance and is what their brain expects to be enforced.
 */
export function runPreflight(input: PreflightInput): PreflightResult {
  const { toolName, proposalStrings, proposalPaths = [], proposalConcepts = [], rejectedApproaches, teamPreferences } = input;

  // (A) Near-miss + concept↔concept both benefit from also weighing the
  // agent's NAMED concept(s), not just the prose. The named concept is short
  // and precise, so a partial token overlap here is a strong "adjacent stance"
  // signal. Union it into the texts the coverage pass scans.
  const coverageTexts = proposalConcepts.length ? [...proposalStrings, ...proposalConcepts] : proposalStrings;

  // Y1' — build the trace's "considered" list FIRST. Includes every
  // session-rejected approach + every team pref whose scope (if any) the
  // proposal touches. This is the count the breadcrumb headlines —
  // "Cross-checked your N prior stances" — and the detail the user sees
  // on expand. Cap so the JSON stays small.
  const considered: PreflightConsideredConcept[] = [];
  for (const rej of rejectedApproaches) {
    if (considered.length >= CONSIDERED_CAP) break;
    considered.push({
      source: "session",
      concept: rej.concept ?? rej.description,
      reason: rej.reason,
    });
  }
  for (const pref of teamPreferences) {
    if (considered.length >= CONSIDERED_CAP) break;
    if (pref.kind === "prefer") continue; // never blocks; drop from "considered" too
    // Scope filter: skip prefs whose scope doesn't touch any proposal path.
    if (pref.scope?.paths?.length) {
      const hit = proposalPaths.some((p) =>
        pref.scope!.paths!.some((g) => matchesGlob(p, g)),
      );
      if (!hit) continue;
    }
    considered.push({
      source: "team",
      concept: pref.concept,
      reason: pref.rationale,
    });
  }

  // Y1' — near-misses: stances whose tokens partially appear in the
  // proposal. Computed once, included in trace whether we block or not.
  // The blocking matchers below take precedence (a full match isn't a
  // near miss; it's a block).
  const nearMisses: PreflightNearMiss[] = [];
  for (const rej of rejectedApproaches) {
    const conceptText = rej.concept ?? rej.description;
    const cov = Math.max(
      ...coverageTexts.map((p) => tokenCoverage(conceptText, p)),
      0,
    );
    if (cov >= NEAR_MISS_THRESHOLD && cov < 1) {
      nearMisses.push({
        source: "session",
        concept: conceptText,
        reason: rej.reason,
        why: `Partial token overlap (${Math.round(cov * 100)}%) with a past rejection.`,
      });
    }
  }
  for (const pref of teamPreferences) {
    if (pref.kind === "prefer") continue;
    if (pref.scope?.paths?.length) {
      const hit = proposalPaths.some((p) =>
        pref.scope!.paths!.some((g) => matchesGlob(p, g)),
      );
      if (!hit) continue;
    }
    const cov = Math.max(
      ...coverageTexts.map((p) => tokenCoverage(pref.concept, p)),
      0,
    );
    if (cov >= NEAR_MISS_THRESHOLD && cov < 1) {
      nearMisses.push({
        source: "team",
        concept: pref.concept,
        reason: pref.rationale,
        why: `Partial token overlap (${Math.round(cov * 100)}%) with a team policy.`,
      });
    }
  }

  // Lane 1 — session-scoped rejected approaches.
  if (rejectedApproaches.length > 0) {
    let match = findRejectedApproachMatch(proposalStrings, rejectedApproaches);
    // (A) concept↔concept fallback: if the prose path didn't catch it but the
    // agent NAMED a concept, compare that short string against each stored
    // rejected concept (exact normalized key OR full stemmed token
    // containment). Higher precision than concept-vs-prose, so blocking here is
    // consistent with the behavior invariant (clear normalized-concept match).
    if (!match && proposalConcepts.length > 0) {
      for (const rej of rejectedApproaches) {
        if (!rej.concept) continue;
        const cc = findConceptToConceptMatch(proposalConcepts, [rej.concept]);
        if (cc) {
          match = { proposal: cc.proposalConcept, rejected: rej, via: "concept" };
          break;
        }
      }
    }
    if (match) {
      const reasonLine = match.rejected.reason
        ? `\nPrior rejection reason: "${match.rejected.reason}"`
        : "";
      const conceptLine =
        match.via === "concept" && match.rejected.concept
          ? `\nMatched on underlying concept: "${match.rejected.concept}". ` +
            `A paraphrased proposal still counts — the user has rejected this kind of approach.`
          : "";
      const message =
        `REJECTED_APPROACH_BLOCKED: ${toolName} refused — your proposal contains "${match.proposal}" ` +
        `which the user previously rejected ("${match.rejected.description}").${reasonLine}${conceptLine}\n\n` +
        `Do NOT retry with this approach. Revise your proposal to exclude it, or — if you believe ` +
        `conditions have changed — present_findings first to make the case for reconsidering, then ` +
        `wait for the human's response via check_feedback. The artifact was NOT created.`;
      return {
        blocked: true,
        block: {
          source: "session",
          message,
          broadcastEvent: {
            type: "preflight_blocked",
            toolName,
            source: "session",
            match: {
              proposal: match.proposal,
              description: match.rejected.description,
              reason: match.rejected.reason,
              concept: match.rejected.concept,
              via: match.via,
            },
          },
        },
        trace: {
          decision: "blocked",
          consideredCount: considered.length,
          consideredConcepts: considered,
          nearMisses,
          block: {
            source: "session",
            concept: match.rejected.concept ?? match.rejected.description,
            reason: match.rejected.reason,
            via: match.via,
          },
        },
      };
    }
  }

  // Lane 2 — team-preference violations. Distinct authority from session
  // memory: a team pref is committed to a file in the repo, so the block
  // message attributes to "team policy" not "the user".
  if (teamPreferences.length > 0) {
    let teamMatch = findTeamPreferenceViolation(proposalStrings, teamPreferences, proposalPaths);
    // (A) concept↔concept fallback for team 'avoid' prefs (require stays
    // domain-gated in findTeamPreferenceViolation). Same scope discipline: a
    // scoped pref only fires when the proposal's paths intersect the scope, and
    // an unscoped-vs-no-path proposal is skipped to bias away from false blocks.
    if (!teamMatch && proposalConcepts.length > 0) {
      for (const pref of teamPreferences) {
        if (pref.kind !== "avoid") continue;
        if (pref.scope?.paths?.length) {
          if (proposalPaths.length === 0) continue;
          const hit = proposalPaths.some((p) => pref.scope!.paths!.some((g) => matchesGlob(p, g)));
          if (!hit) continue;
        }
        const cc = findConceptToConceptMatch(proposalConcepts, [pref.concept]);
        if (cc) {
          teamMatch = { proposal: cc.proposalConcept, pref, via: "avoid" };
          break;
        }
      }
    }
    if (teamMatch) {
      const { pref, proposal, via } = teamMatch;
      const attribution = pref.addedBy ? ` (added by ${pref.addedBy})` : "";
      const scope = pref.scope?.paths?.length
        ? `\nScope: ${pref.scope.paths.join(", ")}`
        : "";
      const headline = via === "avoid"
        ? `your proposal touches "${proposal}" which conflicts with the team's "avoid: ${pref.concept}" policy`
        : `your proposal addresses "${proposal}" but is missing the team-required "${pref.concept}"`;
      const message =
        `REJECTED_APPROACH_BLOCKED: ${toolName} refused — ${headline}.\n` +
        `Team rationale: "${pref.rationale}"${attribution}.${scope}\n\n` +
        (via === "avoid"
          ? `Do NOT propose this. Revise to use an alternative approach, or call present_findings to make a case for changing the team policy. The artifact was NOT created.`
          : `Revise your proposal to use the required approach, or call present_findings to surface why this case warrants an exception. The artifact was NOT created.`);

      return {
        blocked: true,
        block: {
          source: "team",
          message,
          broadcastEvent: {
            type: "preflight_blocked",
            toolName,
            source: "team",
            match: {
              proposal,
              description: pref.concept,
              reason: pref.rationale,
              concept: pref.concept,
              via,
              kind: pref.kind,
              addedBy: pref.addedBy,
              scope: pref.scope?.paths,
            },
          },
        },
        trace: {
          decision: "blocked",
          consideredCount: considered.length,
          consideredConcepts: considered,
          nearMisses,
          block: {
            source: "team",
            concept: pref.concept,
            reason: pref.rationale,
            via,
          },
        },
      };
    }
  }

  return {
    blocked: false,
    trace: {
      decision: "admitted",
      consideredCount: considered.length,
      consideredConcepts: considered,
      nearMisses,
    },
  };
}
