import { describe, it, expect } from "vitest";
import type { IStore } from "../../store/store-interface.js";
import { getGlobalStore } from "../../store/global-store.js";
import { preflightRejectedApproaches } from "../tool-helpers.js";

/**
 * Finding-2 dedup — INTEGRATION test for the tool-helpers advisory path.
 *
 * The validator suite exercises runPreflight directly and bypasses the
 * tool-helpers `localKeys` construction (rejections + approvals), so the
 * suppression of a cross-project nudge for a LOCALLY-APPROVED concept was only
 * verified by reading. This proves it end-to-end:
 *
 *   - a concept X is an 'avoid' stance in the GLOBAL ledger, AND
 *   - the current project has X in its LOCAL approvedPatterns
 *   ⇒ preflightRejectedApproaches yields NO source:"global" advisory for X.
 *
 * Companion assertion: WITHOUT the local approval, X DOES yield the advisory —
 * so the test proves the dedup, not merely absence.
 *
 * Fakes-not-mocks: a minimal IStore fake whose getSessionMemory returns the
 * configured memory. The global-store singleton is redirected to an isolated
 * tmp ledger by the server vitest guard (global-store-guard.setup.ts), so
 * seeding it here is safe.
 */

const CONCEPT = "pay-per-request hosting";
// Prose that fully contains the concept's stemmed tokens (pay, request, host)
// → isCrossProjectAdvisoryHit fires (≥2 tokens, full containment).
const MATCHING_PROSE = "switch to pay-per-request hosting for the service";

/** Minimal fake IStore — only getSessionMemory is exercised by this path. */
function fakeStore(approvedPatterns: string[]): IStore {
  return {
    async getSessionMemory() {
      return { rejectedApproaches: [], approvedPatterns };
    },
    // getTeamPreferences / recordMetric are optional and unused here.
  } as unknown as IStore;
}

/** Seed a single-rejection global 'avoid' stance for CONCEPT. */
function seedGlobalAvoid() {
  getGlobalStore().recordInstance(CONCEPT, {
    project: "project-a",
    sessionId: "s1",
    verdict: "rejected",
    reason: "expensive at scale",
  });
}

const noopBroadcast = () => {};

describe("preflightRejectedApproaches — finding-2 dedup (locally-approved concept suppresses the cross-project nudge)", () => {
  it("does NOT surface a source:'global' advisory when the concept is in the project's approvedPatterns", async () => {
    seedGlobalAvoid();
    const store = fakeStore([CONCEPT]); // locally approved
    const res = await preflightRejectedApproaches(store, noopBroadcast, "present_code_change", [MATCHING_PROSE]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const globalHits = res.trace.nearMisses.filter((n) => n.source === "global");
      expect(globalHits).toEqual([]);
    }
  });

  it("DOES surface the source:'global' advisory when the concept is NOT locally approved (proves the dedup, not absence)", async () => {
    seedGlobalAvoid();
    const store = fakeStore([]); // no local approval
    const res = await preflightRejectedApproaches(store, noopBroadcast, "present_code_change", [MATCHING_PROSE]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const globalHit = res.trace.nearMisses.find((n) => n.source === "global" && n.concept === CONCEPT);
      expect(globalHit).toBeTruthy();
      expect(globalHit?.project).toBe("project-a");
    }
  });
});
