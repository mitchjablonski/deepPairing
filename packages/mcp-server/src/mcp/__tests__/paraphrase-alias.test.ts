/**
 * Paraphrase-catch corpus — the curated concept-alias bridge.
 *
 * The moat headline is "the gate catches a rejected approach even when it comes
 * back PARAPHRASED". Stemming already collapses morphology (host ↔ hosting);
 * this suite pins the harder half — SYNONYMS with zero verbatim token overlap —
 * caught by the hand-audited CONCEPT_ALIASES table in preflight-validator.ts.
 *
 * Both directions are load-bearing:
 *   - SHOULD-match: a rejected concept and a true synonym paraphrase (sharing NO
 *     surface token) must still block.
 *   - MUST-NOT-match: near-misses that merely share words, plus the classic
 *     precision traps (authentication ≠ authorization, rail ∈ guardrail), must
 *     NOT block. A false hard-block on an approach the human never rejected is
 *     the primary risk this table is disciplined against.
 */
import { describe, it, expect } from "vitest";
import type { RejectedApproach } from "../../store/store-interface.js";
import {
  aliasCanonical,
  meaningfulTokens,
  conceptMatchesProposal,
  containmentBlockAllowed,
  findRejectedApproachMatch,
  findConceptToConceptMatch,
  runPreflight,
} from "../preflight-validator.js";

const rejected = (concept: string): RejectedApproach =>
  ({
    id: "rx",
    description: "a stance we set aside earlier",
    concept,
    reason: "the human rejected this",
    rejectedAt: "2026-04-01T00:00:00Z",
  }) as any;

describe("aliasCanonical — synonyms collapse to one representative, non-members pass through", () => {
  it("maps each member of a group to the SAME representative (symmetric)", () => {
    // delete ≡ remove
    expect(aliasCanonical("remove")).toBe(aliasCanonical("delete"));
    expect(aliasCanonical("remov")).toBe(aliasCanonical("delet"));
    // directory ≡ folder
    expect(aliasCanonical("folder")).toBe(aliasCanonical("directory"));
    // cache ≡ memoize
    expect(aliasCanonical("memoize")).toBe(aliasCanonical("cache"));
    expect(aliasCanonical("memoiz")).toBe(aliasCanonical("cach"));
    // env ≡ environment
    expect(aliasCanonical("env")).toBe(aliasCanonical("environment"));
  });

  it("keeps authentication and authorization in SEPARATE groups (the classic near-miss)", () => {
    expect(aliasCanonical("authentication")).not.toBe(aliasCanonical("authorization"));
    expect(aliasCanonical("authn")).not.toBe(aliasCanonical("authz"));
    // bare "auth" is deliberately un-aliased (ambiguous → would bridge the two).
    expect(aliasCanonical("auth")).toBe("auth");
  });

  it("leaves un-grouped tokens untouched — rail/guardrail stay distinct; no billing group exists", () => {
    expect(aliasCanonical("rail")).toBe("rail");
    expect(aliasCanonical("guardrail")).toBe("guardrail");
    expect(aliasCanonical("rail")).not.toBe(aliasCanonical("guardrail"));
    // The billing/pricing group was DROPPED (its members were not mutually
    // substitutable). Every one of these must now pass through unchanged, so
    // "metered billing" can never collapse and falsely block "serverless *".
    for (const ungrouped of ["serverless", "consumption", "meter", "bill", "billing", "metered", "pay", "request", "host", "usage", "pric"]) {
      expect(aliasCanonical(ungrouped), `${ungrouped} must be un-aliased`).toBe(ungrouped);
    }
  });

  it("is 1:1 per token — meaningfulTokens preserves token COUNT after canonicalization", () => {
    // "delete the cache" → [delete, cache] (2), "remove the memoization" → 2.
    expect(meaningfulTokens("delete the cache").length).toBe(2);
    expect(meaningfulTokens("remove the memoization").length).toBe(2);
  });
});

describe("SHOULD-match — true synonym paraphrases (zero verbatim token reuse) still block", () => {
  // Each pair shares NO surface token; only the alias table bridges them.
  const shouldMatch: Array<[concept: string, paraphrase: string, note: string]> = [
    ["delete the directory", "remove the folder", "delete↔remove + directory↔folder"],
    ["cache then delete", "memoize then remove", "cache↔memoize + delete↔remove"],
    ["delete the env", "remove the environment", "delete↔remove + env↔environment"],
    ["delete authentication", "remove login", "delete↔remove + authentication↔login"],
  ];

  for (const [concept, paraphrase, note] of shouldMatch) {
    it(`conceptMatchesProposal: "${concept}" ↔ "${paraphrase}" (${note})`, () => {
      // Sanity: genuinely zero verbatim overlap between the two MEANINGFUL
      // token sets (connective stopwords like "the"/"then" are dropped by the
      // matcher and don't count as reuse — the DISTINCTIVE tokens must differ).
      const CONNECTIVES = new Set(["the", "then", "a", "an", "and", "for", "with"]);
      const meaningfulSurface = (s: string) =>
        new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !CONNECTIVES.has(t)));
      const a = meaningfulSurface(concept);
      const b = meaningfulSurface(paraphrase);
      const shared = [...a].filter((t) => b.has(t));
      expect(shared, `expected zero shared distinctive tokens, got ${shared.join(",")}`).toHaveLength(0);
      // Both directions of the bridge.
      expect(conceptMatchesProposal(concept, paraphrase)).toBe(true);
      expect(conceptMatchesProposal(paraphrase, concept)).toBe(true);
    });
  }

  it("findRejectedApproachMatch blocks the paraphrase via the concept lane", () => {
    const m = findRejectedApproachMatch(
      ["I'll remove the folder once we're done"],
      [rejected("delete the directory")],
    );
    expect(m?.via).toBe("concept");
  });

  it("findConceptToConceptMatch bridges named-concept synonyms (short-vs-short)", () => {
    const m = findConceptToConceptMatch(["remove the folder"], ["delete the directory"]);
    expect(m?.storedConcept).toBe("delete the directory");
  });

  it("runPreflight HARD-BLOCKS a paraphrased session rejection (source: session)", () => {
    const r = runPreflight({
      toolName: "present_options",
      proposalStrings: ["Proposal: memoize then remove the transient values"],
      rejectedApproaches: [rejected("cache then delete")],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) {
      expect(r.block.source).toBe("session");
      expect((r.block.broadcastEvent.match as any).via).toBe("concept");
    }
  });
});

describe("MUST-NOT-match — near-misses and precision traps stay admitted", () => {
  // Each pair shares SOME word but describes a different approach, OR is a
  // known precision trap. None may hard-block.
  const mustNotMatch: Array<[concept: string, proposal: string, note: string]> = [
    ["authentication layer", "authorization layer", "authn ≠ authz (classic near-miss)"],
    ["session authentication", "session authorization", "shared 'session' must not bridge authn↔authz"],
    ["add a guardrail", "add a rail", "rail ∈ guardrail must stay dead"],
    ["cache invalidation", "cache warming", "shares 'cache' but different approach"],
    ["delete the directory backup", "remove the folder", "extra distinctive token ('backup') absent → no full coverage"],
  ];

  for (const [concept, proposal, note] of mustNotMatch) {
    it(`conceptMatchesProposal: "${concept}" does NOT match "${proposal}" (${note})`, () => {
      expect(conceptMatchesProposal(concept, proposal)).toBe(false);
    });
  }

  it("runPreflight does NOT block an authorization proposal against an authentication rejection", () => {
    const r = runPreflight({
      toolName: "present_code_change",
      proposalStrings: ["Add an authorization layer to gate the admin routes"],
      proposalConcepts: ["authorization layer"],
      rejectedApproaches: [rejected("authentication layer")],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(false);
  });

  it("runPreflight does NOT block on the rail ∈ guardrail trap", () => {
    const r = runPreflight({
      toolName: "present_findings",
      proposalStrings: ["Add a rail to the diagram before the deploy step"],
      rejectedApproaches: [rejected("add a guardrail")],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(false);
  });
});

describe("FALSE-POSITIVE regression — the collapse-defeats-the-floor class", () => {
  // The exact review repro: a pricing DECISION ("metered billing") must not
  // hard-block an unrelated architecture proposal ("serverless deployment").
  // Guarded by BOTH fixes: (1) the billing group is gone, so these tokens no
  // longer canonicalize together; (2) even if a future group re-introduced the
  // collapse, the distinct-canonical floor below catches it.
  it("rejecting 'metered billing' does NOT block a 'serverless deployment' proposal", () => {
    const r = runPreflight({
      toolName: "present_code_change",
      proposalStrings: ["migrate the API to a serverless deployment model"],
      proposalConcepts: ["serverless deployment"],
      rejectedApproaches: [rejected("metered billing")],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(false);
  });

  it("containmentBlockAllowed counts DISTINCT canonicals — a 2-word phrase collapsing to 1 canonical cannot containment-block", () => {
    // "cache memoize": both words are the SAME synonym group → one distinct
    // canonical. By array length it was ≥2 (would block); by distinct-canonical
    // it is 1 (floored, single-token concepts block only via exact named key).
    expect(meaningfulTokens("cache memoize")).toHaveLength(2); // count preserved
    expect(new Set(meaningfulTokens("cache memoize")).size).toBe(1); // but 1 distinct
    expect(containmentBlockAllowed("cache memoize")).toBe(false);
  });

  it("a within-group 2-word concept does NOT hard-block prose sharing only that one canonical", () => {
    // Without the distinct-canonical floor, "cache memoize" → [cache, cache]
    // would token-contain into ANY prose mentioning caching. It must not.
    const r = runPreflight({
      toolName: "present_findings",
      proposalStrings: ["add a caching layer in front of the read path"],
      rejectedApproaches: [rejected("cache memoize")],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(false);
  });

  it("REGRESSION: a genuine multi-DISTINCT-token concept still hard-blocks (floor not over-tightened)", () => {
    // "global mutable state" → 3 distinct canonicals → still eligible to block.
    const r = runPreflight({
      toolName: "present_findings",
      proposalStrings: ["introduce a global mutable state cache for config"],
      rejectedApproaches: [rejected("global mutable state")],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(true);
  });
});
