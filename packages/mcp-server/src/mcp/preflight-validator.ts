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
import type { TeamPreference } from "@deeppairing/shared";
import type { RejectedApproach } from "../store/store-interface.js";

// ---------------------------------------------------------------------
// Matchers (pure utilities; exported for unit tests)
// ---------------------------------------------------------------------

/**
 * Concept-token check used by both rejected-approach matching and team-pref
 * matching. Returns true when every meaningful (≥4 char) token from `concept`
 * appears in `proposal`. Substring-based and case-insensitive — good enough
 * to catch paraphrases without false positives on common words.
 */
export function conceptMatchesProposal(concept: string, proposal: string): boolean {
  const tokens = concept.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return false;
  const p = proposal.toLowerCase();
  return tokens.every((t) => p.includes(t));
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
      re += escape(glob[i]);
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
    const conceptTokens = rej.concept
      ? clean(rej.concept).split(/\s+/).filter((t) => t.length >= 4)
      : [];
    for (const proposal of proposalStrings) {
      const p = clean(proposal);
      if (!p) continue;
      // Direct substring in either direction (whole rejection description)
      if (rejNormalized.includes(p) || p.includes(rejNormalized)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      // Specific noun fragment of the rejection (post-colon)
      if (specificNoun.length >= 3 && p.includes(specificNoun)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      // Concept match: every non-stopword concept token present in the proposal
      if (conceptTokens.length > 0 && conceptTokens.every((t) => p.includes(t))) {
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

export type PreflightResult =
  | { blocked: false }
  | { blocked: true; block: PreflightBlock };

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
  const { toolName, proposalStrings, proposalPaths = [], rejectedApproaches, teamPreferences } = input;

  // Lane 1 — session-scoped rejected approaches.
  if (rejectedApproaches.length > 0) {
    const match = findRejectedApproachMatch(proposalStrings, rejectedApproaches);
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
      };
    }
  }

  // Lane 2 — team-preference violations. Distinct authority from session
  // memory: a team pref is committed to a file in the repo, so the block
  // message attributes to "team policy" not "the user".
  if (teamPreferences.length > 0) {
    const teamMatch = findTeamPreferenceViolation(proposalStrings, teamPreferences, proposalPaths);
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
      };
    }
  }

  return { blocked: false };
}
