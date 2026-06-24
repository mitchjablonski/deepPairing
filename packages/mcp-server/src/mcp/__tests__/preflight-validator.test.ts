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
