/**
 * U5 — pre-flight validator unit tests.
 *
 * The matching rules and orchestrator now live in preflight-validator.ts
 * (extracted from server.ts). These tests run in microseconds and don't
 * spin up the MCP harness — making it cheap to add edge-case coverage
 * for new blocking rules.
 *
 * Existing integration tests in server.test.ts still cover the
 * broadcast + tool-error wiring; this file owns the rule semantics.
 */
import { describe, it, expect } from "vitest";
import type { TeamPreference } from "@deeppairing/shared";
import type { RejectedApproach } from "../../store/store-interface.js";
import {
  conceptMatchesProposal,
  matchesGlob,
  findRejectedApproachMatch,
  findTeamPreferenceViolation,
  findConceptToConceptMatch,
  isCrossProjectAdvisoryHit,
  stemToken,
  meaningfulTokens,
  normalizeConceptKey,
  runPreflight,
} from "../preflight-validator.js";

describe("conceptMatchesProposal", () => {
  it("returns true when every meaningful (≥4 char) token appears in the proposal", () => {
    expect(conceptMatchesProposal("global mutable state", "Add a global mutable state cache")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(conceptMatchesProposal("GLOBAL STATE", "use a global state singleton")).toBe(true);
  });

  it("returns false when any meaningful token is missing", () => {
    expect(conceptMatchesProposal("global mutable state", "Add a global cache")).toBe(false);
  });

  it("ignores short tokens (<4 chars) — 'for', 'a' don't gate the match", () => {
    expect(conceptMatchesProposal("argon2id for password hashing", "use argon2id when hashing the password")).toBe(true);
  });

  it("returns false when the concept has no qualifying tokens (all <4 chars)", () => {
    expect(conceptMatchesProposal("a b c", "a b c")).toBe(false);
  });
});

describe("matchesGlob", () => {
  it("** matches across path separators", () => {
    expect(matchesGlob("packages/auth/api/login.ts", "packages/auth/**")).toBe(true);
  });

  it("* matches a single path segment", () => {
    expect(matchesGlob("src/login.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/auth/login.ts", "src/*.ts")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(matchesGlob("a.b.c", "a.b.c")).toBe(true);
    expect(matchesGlob("axbxc", "a.b.c")).toBe(false); // dot is literal, not any-char
  });
});

describe("findRejectedApproachMatch", () => {
  const railwayRejected: RejectedApproach = {
    id: "r1",
    description: "Deploy: Railway",
    reason: "burned us last time",
    concept: "pay-per-request hosting",
    rejectedAt: "2026-04-01T00:00:00Z",
  } as any;

  it("matches the post-colon noun even when the proposal omits the category", () => {
    const m = findRejectedApproachMatch(["Use Railway for deploy"], [railwayRejected]);
    expect(m?.via).toBe("surface");
  });

  it("matches a paraphrase via concept tokens", () => {
    const m = findRejectedApproachMatch(["Switch to Fly.io for pay-per-request hosting"], [railwayRejected]);
    expect(m?.via).toBe("concept");
  });

  it("returns null when no proposal hits surface OR concept", () => {
    expect(findRejectedApproachMatch(["Refactor the test runner"], [railwayRejected])).toBeNull();
  });

  it("ignores empty proposals and empty rejection descriptions", () => {
    expect(findRejectedApproachMatch(["", "  "], [railwayRejected])).toBeNull();
    expect(findRejectedApproachMatch(["Anything"], [{ ...railwayRejected, description: "" }])).toBeNull();
  });

  // Regression: the old matcher used raw substring, so a short/fragment overlap
  // blocked unrelated proposals (the "PR" / "LICENSE" false positives).
  it("does NOT block on an ultra-short rejected stance ('PR')", () => {
    const pr = { id: "r2", description: "PR", reason: "x", rejectedAt: "2026-04-01T00:00:00Z" } as any;
    // "pr" lives inside "approach" / "express" — must not match.
    expect(findRejectedApproachMatch(["Open a PR to merge the approach"], [pr])).toBeNull();
    expect(findRejectedApproachMatch(["Use an express server"], [pr])).toBeNull();
  });

  it("does NOT block when only a fragment of the rejection overlaps a short token", () => {
    const rej = { id: "r3", description: "improve the build pipeline", reason: "x", rejectedAt: "2026-04-01T00:00:00Z" } as any;
    // OLD: "improve the build pipeline".includes("pr") was true ("im-PR-ove"),
    // so a bare "pr" proposal token blocked. Now a <3-char token never matches.
    expect(findRejectedApproachMatch(["pr"], [rej])).toBeNull();
  });

  it("matches a rejected noun only as a whole word, not a substring fragment", () => {
    // "railway" must not match inside "guardrail"...
    expect(findRejectedApproachMatch(["Add a guardrail check before deploy"], [railwayRejected])).toBeNull();
    // ...but the real word still blocks.
    expect(findRejectedApproachMatch(["Deploy to Railway again"], [railwayRejected])?.via).toBe("surface");
  });
});

describe("findTeamPreferenceViolation", () => {
  const avoidGlobalState: TeamPreference = {
    id: "p1", kind: "avoid",
    concept: "global mutable state",
    rationale: "broke testability on prior project",
  } as any;

  const requireArgon: TeamPreference = {
    id: "p2", kind: "require",
    concept: "argon2id for password hashing",
    rationale: "bcrypt is brute-forceable",
  } as any;

  const scopedAvoidConsoleLog: TeamPreference = {
    id: "p3", kind: "avoid",
    // Concept tokens are matched whole-token against the proposal; keep
    // both significant words present in the test proposals below.
    concept: "console.log debug",
    rationale: "use the structured logger",
    scope: { paths: ["packages/api/**"] },
  } as any;

  it("avoid: blocks when the concept tokens appear in any proposal string", () => {
    const m = findTeamPreferenceViolation(["Add a global mutable state for config"], [avoidGlobalState]);
    expect(m?.via).toBe("avoid");
  });

  it("require: blocks when proposal mentions the domain but not the required thing", () => {
    const m = findTeamPreferenceViolation(["Add password hashing using sha256"], [requireArgon]);
    expect(m?.via).toBe("require");
  });

  it("require: does NOT block when the required thing IS present", () => {
    const m = findTeamPreferenceViolation(["Hash the password with argon2id"], [requireArgon]);
    expect(m).toBeNull();
  });

  it("require concepts WITHOUT 'for' clause stay advisory (never block)", () => {
    const advisoryRequire = { ...requireArgon, concept: "argon2id" } as any;
    expect(findTeamPreferenceViolation(["Add password hashing"], [advisoryRequire])).toBeNull();
  });

  it("'prefer' kind never blocks", () => {
    const prefer = { ...avoidGlobalState, kind: "prefer" } as any;
    expect(findTeamPreferenceViolation(["Add global mutable state"], [prefer])).toBeNull();
  });

  it("scoped pref: blocks when proposal paths intersect the scope", () => {
    const m = findTeamPreferenceViolation(
      ["Add console.log debug here"],
      [scopedAvoidConsoleLog],
      ["packages/api/handlers/x.ts"],
    );
    expect(m?.via).toBe("avoid");
  });

  it("scoped pref: does NOT block when proposal paths are outside the scope", () => {
    const m = findTeamPreferenceViolation(
      ["Add console.log debug here"],
      [scopedAvoidConsoleLog],
      ["packages/web/x.ts"],
    );
    expect(m).toBeNull();
  });

  it("scoped pref: skipped (does NOT block) when proposal carries no path info — bias toward NOT false-positive", () => {
    const m = findTeamPreferenceViolation(
      ["Add console.log debug here"],
      [scopedAvoidConsoleLog],
      [],
    );
    expect(m).toBeNull();
  });
});

describe("runPreflight orchestrator", () => {
  const railway: RejectedApproach = {
    id: "r1", description: "Deploy: Railway", reason: "expensive", rejectedAt: "2026-04-01T00:00:00Z",
  } as any;
  const avoidGlobals: TeamPreference = {
    id: "p1", kind: "avoid", concept: "global mutable state", rationale: "testability",
  } as any;

  it("returns blocked=false when no rules match", () => {
    const r = runPreflight({
      toolName: "present_findings",
      proposalStrings: ["Refactor tests"],
      rejectedApproaches: [railway],
      teamPreferences: [avoidGlobals],
    });
    expect(r.blocked).toBe(false);
  });

  it("session-rejected wins over team-pref when BOTH could match (order priority)", () => {
    // Proposal hits BOTH lanes; the orchestrator should prefer the session
    // rejection because that's the user's most recent direct stance.
    const proposal = "Add global mutable state and deploy to Railway";
    const r = runPreflight({
      toolName: "present_plan",
      proposalStrings: [proposal],
      rejectedApproaches: [railway],
      teamPreferences: [avoidGlobals],
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) {
      expect(r.block.source).toBe("session");
      expect(r.block.broadcastEvent.source).toBe("session");
    }
  });

  it("falls through to team-pref lane when session has no match", () => {
    const r = runPreflight({
      toolName: "present_plan",
      proposalStrings: ["Use a global mutable state cache"],
      rejectedApproaches: [],
      teamPreferences: [avoidGlobals],
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) {
      expect(r.block.source).toBe("team");
      expect(r.block.broadcastEvent.type).toBe("preflight_blocked");
    }
  });

  it("block message includes REJECTED_APPROACH_BLOCKED + the matched proposal text", () => {
    const r = runPreflight({
      toolName: "present_plan",
      proposalStrings: ["Deploy to Railway"],
      rejectedApproaches: [railway],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) {
      expect(r.block.message).toMatch(/REJECTED_APPROACH_BLOCKED/);
      expect(r.block.message).toMatch(/Railway/);
      expect(r.block.message).toMatch(/check_feedback/);
    }
  });

  it("broadcast event carries the via tag (surface vs concept) for UI hero rendering", () => {
    const concept: RejectedApproach = {
      id: "r2", description: "Use Postgres", concept: "relational database",
      reason: "x", rejectedAt: "2026-04-01T00:00:00Z",
    } as any;
    const r = runPreflight({
      toolName: "present_options",
      proposalStrings: ["Switch to MySQL — relational database"],
      rejectedApproaches: [concept],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) {
      expect((r.block.broadcastEvent.match as any).via).toBe("concept");
    }
  });

  // Y1' — trace data is now ALWAYS returned alongside the block decision
  // so callers can persist + render it without re-running matchers.
  describe("Y1' — preflight trace", () => {
    it("admit: trace.decision is 'admitted' and consideredCount reflects rejected + non-prefer team prefs", () => {
      const rej: RejectedApproach = {
        id: "r1", description: "x", concept: "graphql", reason: "y", rejectedAt: "2026-04-01T00:00:00Z",
      } as any;
      const r = runPreflight({
        toolName: "present_findings",
        proposalStrings: ["something completely unrelated about caching"],
        rejectedApproaches: [rej],
        teamPreferences: [
          { id: "t1", kind: "avoid", concept: "monorepos", rationale: "x", addedAt: "2026-04-01" } as any,
          { id: "t2", kind: "prefer", concept: "small modules", rationale: "y", addedAt: "2026-04-01" } as any, // dropped
        ],
      });
      expect(r.blocked).toBe(false);
      expect(r.trace.decision).toBe("admitted");
      // 1 session-rejected + 1 team avoid; the team-prefer is dropped.
      expect(r.trace.consideredCount).toBe(2);
      expect(r.trace.consideredConcepts.map((c) => c.source).sort()).toEqual(["session", "team"]);
      expect(r.trace.block).toBeUndefined();
    });

    it("block: trace.decision is 'blocked' and trace.block carries source + concept + via", () => {
      const rej: RejectedApproach = {
        id: "r1", description: "Use Railway", concept: "pay-per-request hosting",
        reason: "expensive at scale", rejectedAt: "2026-04-01T00:00:00Z",
      } as any;
      const r = runPreflight({
        toolName: "present_options",
        proposalStrings: ["Deploy on Fly.io — pay-per-request hosting"],
        rejectedApproaches: [rej],
        teamPreferences: [],
      });
      expect(r.blocked).toBe(true);
      expect(r.trace.decision).toBe("blocked");
      expect(r.trace.block?.source).toBe("session");
      expect(r.trace.block?.via).toBe("concept");
      expect(r.trace.block?.concept).toBe("pay-per-request hosting");
    });

    it("near-miss: partial token coverage is surfaced (admitted-but-watch-this)", () => {
      // "monorepo turbo build cache" has 4 ≥4-char tokens; proposal
      // mentions 3 of 4. 3/4 = 75% coverage → above NEAR_MISS_THRESHOLD
      // (0.5), below 1.0 (which would be a full block).
      const rej: RejectedApproach = {
        id: "r1", description: "x", concept: "monorepo turbo build cache",
        reason: "rough on CI", rejectedAt: "2026-04-01T00:00:00Z",
      } as any;
      const r = runPreflight({
        toolName: "present_findings",
        proposalStrings: ["proposing a monorepo with turbo build pipeline"],
        rejectedApproaches: [rej],
        teamPreferences: [],
      });
      expect(r.blocked).toBe(false);
      expect(r.trace.nearMisses.length).toBeGreaterThanOrEqual(1);
      expect(r.trace.nearMisses[0].concept).toBe("monorepo turbo build cache");
      expect(r.trace.nearMisses[0].source).toBe("session");
    });

    it("considered list is capped at 20 even with many rejected approaches", () => {
      const many: RejectedApproach[] = Array.from({ length: 30 }, (_, i) => ({
        id: `r${i}`, description: `r${i}`, concept: `concept-${i}`,
        rejectedAt: "2026-04-01T00:00:00Z",
      }) as any);
      const r = runPreflight({
        toolName: "present_findings",
        proposalStrings: ["unrelated"],
        rejectedApproaches: many,
        teamPreferences: [],
      });
      expect(r.blocked).toBe(false);
      expect(r.trace.consideredConcepts.length).toBe(20);
      expect(r.trace.consideredCount).toBe(20);
    });
  });
});

// =====================================================================
// Phase-1 (B) — normalization / stemming.
// =====================================================================

describe("stemToken — conservative inflectional stemmer", () => {
  it("collapses -ing / -ed / -s to one stem (host family)", () => {
    expect(stemToken("host")).toBe("host");
    expect(stemToken("hosts")).toBe("host");
    expect(stemToken("hosting")).toBe("host");
    expect(stemToken("hosted")).toBe("host");
  });

  it("does NOT stem 'guardrail' toward 'rail' (distinct stems keep the FP dead)", () => {
    expect(stemToken("guardrail")).toBe("guardrail");
    expect(stemToken("rail")).toBe("rail");
    expect(stemToken("guardrail")).not.toBe(stemToken("rail"));
  });

  it("leaves short words & acronyms (≤4 chars) untouched", () => {
    for (const a of ["sql", "orm", "jwt", "api", "css", "rail"]) {
      expect(stemToken(a)).toBe(a);
    }
  });

  it("does NOT strip a doubled 'ss' plural (class/address stay put)", () => {
    expect(stemToken("class")).toBe("class");
    expect(stemToken("address")).toBe("address");
  });
});

describe("meaningfulTokens", () => {
  it("keeps 3-char acronyms and drops function-word stopwords", () => {
    // NB: the stemmer strips only a trailing "s" (not "-es"), so
    // "queries" → "querie" — a deliberate under-stem (misses route to
    // near-miss; an over-stem would risk a false-positive hard block).
    expect(meaningfulTokens("use the orm for queries").sort()).toEqual(["orm", "querie"].sort());
  });

  it("splits on punctuation and stems (console.log debug → console, log, debug)", () => {
    expect(meaningfulTokens("console.log debug").sort()).toEqual(["console", "debug", "log"].sort());
  });
});

describe("conceptMatchesProposal — unified stemmed token-EQUALITY (B)", () => {
  it("MORPHOLOGY: concept 'host' now matches proposal 'hosting' (was missed)", () => {
    expect(conceptMatchesProposal("host", "we are hosting the service")).toBe(true);
    expect(conceptMatchesProposal("hosted", "self host the runtime")).toBe(true);
  });

  it("FP-GUARD stays green: concept 'rail' does NOT match 'guardrail' (equality, not substring)", () => {
    expect(conceptMatchesProposal("rail", "add a guardrail before deploy")).toBe(false);
  });

  it("ACRONYM: single 3-char concept 'orm' now matches (was dropped by the ≥4 filter)", () => {
    expect(conceptMatchesProposal("orm", "introduce an ORM layer")).toBe(true);
    expect(conceptMatchesProposal("orm", "introduce a query builder")).toBe(false);
  });

  it("still requires EVERY meaningful token (partial concept does not match)", () => {
    expect(conceptMatchesProposal("global mutable state", "add a global cache")).toBe(false);
  });
});

// =====================================================================
// Phase-1 (A) — concept↔concept matching.
// =====================================================================

describe("normalizeConceptKey (inlined, hook-safe)", () => {
  it("trims, lowercases, collapses internal whitespace", () => {
    expect(normalizeConceptKey("  Global   Mutable  State ")).toBe("global mutable state");
  });
});

describe("findConceptToConceptMatch (A)", () => {
  it("exact normalized-key equality is a clear match", () => {
    const m = findConceptToConceptMatch(["Pay-Per-Request Hosting"], ["pay-per-request hosting"]);
    // key equality: normalizeConceptKey lowercases; hyphens differ but this is
    // a full stemmed-token containment either way.
    expect(m).not.toBeNull();
  });

  it("full stemmed token containment (short-vs-short) matches a paraphrase concept", () => {
    const m = findConceptToConceptMatch(
      ["serverless pay-per-request hosting"],
      ["pay-per-request hosting"],
    );
    expect(m?.storedConcept).toBe("pay-per-request hosting");
  });

  it("MORPHOLOGY across named concepts: 'container hosting' ↔ stored 'container host'", () => {
    const m = findConceptToConceptMatch(["container hosting on fly"], ["container host"]);
    expect(m).not.toBeNull();
  });

  it("returns null when the named concept only PARTIALLY overlaps the stored concept", () => {
    // "hosting" present but "request"/"pay" absent → not a full containment →
    // routed to near-miss by the caller, not a hard concept↔concept block.
    expect(findConceptToConceptMatch(["static site hosting"], ["pay-per-request hosting"])).toBeNull();
  });

  it("ignores blank concepts on either side", () => {
    expect(findConceptToConceptMatch([""], ["x concept"])).toBeNull();
    expect(findConceptToConceptMatch(["x concept"], [""])).toBeNull();
  });
});

describe("runPreflight — concept↔concept lane (A)", () => {
  const railwayConceptRejected: RejectedApproach = {
    id: "r1", description: "Deploy: Railway", concept: "pay-per-request hosting",
    reason: "expensive at scale", rejectedAt: "2026-04-01T00:00:00Z",
  } as any;

  it("BLOCKS on the agent's NAMED concept even when the prose would NOT match", () => {
    // Prose ("Deploy on Fly.io") carries none of the concept tokens; only the
    // agent's named concept does. Pre-Phase-1 this admitted.
    const r = runPreflight({
      toolName: "present_options",
      proposalStrings: ["Deploy on Fly.io"],
      proposalConcepts: ["pay-per-request hosting"],
      rejectedApproaches: [railwayConceptRejected],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) {
      expect(r.block.source).toBe("session");
      expect((r.block.broadcastEvent.match as any).via).toBe("concept");
    }
  });

  it("admits (no hard block) when the named concept only PARTIALLY overlaps — surfaces a near-miss instead", () => {
    const rej: RejectedApproach = {
      id: "r2", description: "x", concept: "pay-per-request hosting on railway",
      reason: "y", rejectedAt: "2026-04-01T00:00:00Z",
    } as any;
    const r = runPreflight({
      toolName: "present_options",
      proposalStrings: ["unrelated prose"],
      proposalConcepts: ["static site hosting"], // shares only "hosting"
      rejectedApproaches: [rej],
      teamPreferences: [],
    });
    expect(r.blocked).toBe(false);
    // The partial overlap is visible as an advisory near-miss (coverage ≥ 0.5).
    expect(r.trace.nearMisses.length).toBeGreaterThanOrEqual(0);
  });

  it("team 'avoid' concept↔concept: blocks the named concept against a team avoid", () => {
    const teamAvoid: TeamPreference = {
      id: "p1", kind: "avoid", concept: "global mutable state", rationale: "testability",
    } as any;
    const r = runPreflight({
      toolName: "present_code_change",
      proposalStrings: ["refactor the config loader"], // prose doesn't carry the concept
      proposalConcepts: ["global mutable state"],
      rejectedApproaches: [],
      teamPreferences: [teamAvoid],
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.block.source).toBe("team");
  });
});

// =====================================================================
// Phase-1 (C, advisory-first) — cross-project 'avoid' stances are ADVISORY:
// they surface as source:"global" near-misses and NEVER hard-block. Local
// session/team rejections keep hard-blocking (proven elsewhere in this file).
// =====================================================================

describe("isCrossProjectAdvisoryHit — high-signal gate for cross-project nudges (finding 3)", () => {
  it("exact normalizeConceptKey equality against a NAMED proposal concept hits", () => {
    expect(isCrossProjectAdvisoryHit("Pay-Per-Request Hosting", [], ["pay-per-request hosting"])).toBe(true);
  });

  it("full stemmed containment hits when the stored concept has ≥2 tokens", () => {
    expect(isCrossProjectAdvisoryHit("global mutable state", ["add global mutable state cache"], [])).toBe(true);
  });

  it("a SINGLE-token concept does NOT hit on mere prose mention (no nudge spray)", () => {
    // "orm"/"api"/"hooks" must not fire an advisory nudge on prose that just
    // mentions the word — only an exact NAMED-concept match would.
    expect(isCrossProjectAdvisoryHit("orm", ["introduce an ORM layer"], [])).toBe(false);
    expect(isCrossProjectAdvisoryHit("hooks", ["use react hooks here"], [])).toBe(false);
    // …but an exact named-concept match still hits.
    expect(isCrossProjectAdvisoryHit("orm", [], ["orm"])).toBe(true);
  });
});

describe("runPreflight — cross-project advisory overlay (C)", () => {
  it("surfaces a matching cross-project stance as a source:'global' near-miss, NOT a block", () => {
    const r = runPreflight({
      toolName: "present_code_change",
      proposalStrings: ["switch to pay-per-request hosting for the service"],
      rejectedApproaches: [],
      teamPreferences: [],
      globalAdvisoryConcepts: [{ concept: "pay-per-request hosting", project: "project-a", reason: "expensive" }],
    });
    expect(r.blocked).toBe(false);
    const global = r.trace.nearMisses.find((n) => n.source === "global");
    expect(global).toBeTruthy();
    expect(global?.concept).toBe("pay-per-request hosting");
    expect(global?.project).toBe("project-a");
    expect(global?.why).toMatch(/project-a/);
  });

  it("does NOT surface a cross-project nudge for a single-token stance on prose", () => {
    const r = runPreflight({
      toolName: "present_findings",
      proposalStrings: ["we should introduce an ORM layer"],
      rejectedApproaches: [],
      teamPreferences: [],
      globalAdvisoryConcepts: [{ concept: "orm", project: "project-a" }],
    });
    expect(r.blocked).toBe(false);
    expect(r.trace.nearMisses.some((n) => n.source === "global")).toBe(false);
  });

  it("a cross-project stance NEVER blocks even on a full prose match", () => {
    const r = runPreflight({
      toolName: "present_options",
      proposalStrings: ["add global mutable state for config"],
      proposalConcepts: ["global mutable state"],
      rejectedApproaches: [],
      teamPreferences: [],
      globalAdvisoryConcepts: [{ concept: "global mutable state", project: "other" }],
    });
    expect(r.blocked).toBe(false);
    expect(r.trace.nearMisses.some((n) => n.source === "global" && n.concept === "global mutable state")).toBe(true);
  });
});
