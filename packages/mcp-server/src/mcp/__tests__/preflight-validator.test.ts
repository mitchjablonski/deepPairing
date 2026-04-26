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
});
