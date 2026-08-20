import { describe, it, expect } from "vitest";
import type { IStore } from "../../store/store-interface.js";
import { getGlobalStore } from "../../store/global-store.js";
import { preflightRejectedApproaches, formatPreflightTraceSummary } from "../tool-helpers.js";

/**
 * Q2 — THE CROSS-PROJECT NUDGE ACTUALLY REACHES THE AGENT.
 *
 * Round-12's HIGH: the advisory was computed, persisted into
 * preflight-traces.json and broadcast to the UI breadcrumb — but
 * formatPreflightTraceSummary bailed on `consideredCount === 0`, and
 * consideredCount counts LOCAL stances only (session rejections + team prefs;
 * see runPreflight's `considered` list — global advisory hits deliberately do
 * not appear there). A FRESH project has zero local stances, which is exactly
 * the case cross-project memory exists for, so the promised sentence
 * ("You avoided this in projA — still want it here?") never reached the model
 * in its canonical scenario.
 *
 * These pins run the REAL preflight (tool-helpers → advisory-recall adapter →
 * runPreflight) and assert on the REAL return string an agent would see. The
 * bootstrap quiet case the zero-guard was originally protecting is held too,
 * so the fix can't regress into a standing banner on every first artifact.
 *
 * Fakes-not-mocks: a minimal IStore fake for getSessionMemory. The global-store
 * singleton is redirected to an isolated tmp ledger per test by the server
 * vitest guard (global-store-guard.setup.ts), so seeding here is safe.
 */

const CONCEPT = "pay-per-request hosting";
/** Prose that fully contains the concept's stemmed tokens → advisory hit. */
const MATCHING_PROSE = "switch to pay-per-request hosting for the service";

function fakeStore(memory: {
  rejectedApproaches?: Array<{ description: string; reason?: string; concept?: string }>;
  approvedPatterns?: string[];
}): IStore {
  return {
    async getSessionMemory() {
      return {
        rejectedApproaches: memory.rejectedApproaches ?? [],
        approvedPatterns: memory.approvedPatterns ?? [],
      };
    },
  } as unknown as IStore;
}

function seedGlobalAvoid(reason = "expensive at scale") {
  getGlobalStore().recordInstance(CONCEPT, {
    project: "project-a",
    sessionId: "s1",
    verdict: "rejected",
    reason,
  });
}

const noopBroadcast = () => {};

/** A LOCAL stance strong enough to hard-block, for the H1 block+advisory pin. */
const LOCAL_STANCE_FOR_BLOCK = {
  description: "use a global mutable config singleton",
  concept: "global mutable state for config",
  reason: "test order-dependence",
};

describe("Q2 — the cross-project nudge is DELIVERED, not merely traced", () => {
  it("fresh project (0 local stances) + published global stance + adjacent proposal → the response carries the nudge sentence", async () => {
    seedGlobalAvoid();
    const res = await preflightRejectedApproaches(
      fakeStore({}), // fresh: no local rejections, no local approvals
      noopBroadcast,
      "present_code_change",
      [MATCHING_PROSE],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The precondition that made this bug invisible: nothing LOCAL considered.
    expect(res.trace.consideredCount).toBe(0);
    expect(res.trace.nearMisses.some((n) => n.source === "global")).toBe(true);

    const summary = formatPreflightTraceSummary(res.trace);
    expect(summary).not.toBe("");
    expect(summary).toContain(`You avoided "${CONCEPT}" in "project-a"`);
    expect(summary).toContain("still want it here?");
    expect(summary).toContain('your reason: "expensive at scale"');
    // Advisory — never mistakable for a block.
    expect(summary).toContain("not a block");
    // ...and without resurrecting the noisy bootstrap prefix.
    expect(summary).not.toContain("considered 0");
  });

  it("bootstrap quiet case preserved: genuinely-empty ledger + no near-miss → still silent", async () => {
    const res = await preflightRejectedApproaches(
      fakeStore({}),
      noopBroadcast,
      "present_code_change",
      ["add a small pure helper for date formatting"],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.consideredCount).toBe(0);
    expect(res.trace.nearMisses).toEqual([]);
    expect(formatPreflightTraceSummary(res.trace)).toBe("");
  });

  it("a seeded global stance the proposal does NOT brush stays silent (targeted nudge, not a standing banner)", async () => {
    seedGlobalAvoid();
    const res = await preflightRejectedApproaches(
      fakeStore({}),
      noopBroadcast,
      "present_code_change",
      ["rename the logger module and tidy its imports"],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.nearMisses.filter((n) => n.source === "global")).toEqual([]);
    expect(formatPreflightTraceSummary(res.trace)).toBe("");
  });

  it("no project attribution on the global instance → the 'another project' branch still delivers", async () => {
    getGlobalStore().recordInstance(CONCEPT, {
      project: "manual",
      sessionId: "s1",
      verdict: "rejected",
    });
    const res = await preflightRejectedApproaches(
      fakeStore({}),
      noopBroadcast,
      "present_code_change",
      [MATCHING_PROSE],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const summary = formatPreflightTraceSummary(res.trace);
    expect(summary).toContain(`You avoided "${CONCEPT}" in another project`);
    expect(summary).toContain("still want it here?");
  });

  it("a locally-approved concept still suppresses the nudge (the dedup survives the delivery fix)", async () => {
    seedGlobalAvoid();
    const res = await preflightRejectedApproaches(
      fakeStore({ approvedPatterns: [CONCEPT] }),
      noopBroadcast,
      "present_code_change",
      [MATCHING_PROSE],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.nearMisses.filter((n) => n.source === "global")).toEqual([]);
    expect(formatPreflightTraceSummary(res.trace)).toBe("");
  });

  it("a hard LOCAL block still reports its consult (the CC1 block-summary lane is untouched)", async () => {
    const res = await preflightRejectedApproaches(
      fakeStore({
        rejectedApproaches: [
          { description: "use a global mutable config singleton", concept: "global mutable state for config", reason: "test order-dependence" },
        ],
      }),
      noopBroadcast,
      "present_code_change",
      ["add a global mutable state for config singleton"],
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.trace.decision).toBe("blocked");
    const text = res.response.content[0]?.text ?? "";
    expect(text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(text).toContain("Preflight: considered 1 past stance");
  });

  /**
   * Q2 review item 12 — the COMPREHENSION tools never draw a cross-project
   * nudge. An explainer teaches how existing code works and a debrief accounts
   * for work already done; neither proposes an approach, so "you avoided this
   * in projA — still want it here?" is advising on a decision nobody is making.
   * Mirrors LEDGER_EXEMPT_REJECT_TYPES on the write side.
   */
  it.each(["present_explainer", "present_debrief"])(
    "item 12: %s draws NO cross-project nudge even on a matching proposal",
    async (toolName) => {
      seedGlobalAvoid();
      const res = await preflightRejectedApproaches(
        fakeStore({}),
        noopBroadcast,
        toolName,
        [MATCHING_PROSE],
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.trace.nearMisses.filter((n) => n.source === "global")).toEqual([]);
      expect(formatPreflightTraceSummary(res.trace)).toBe("");
    },
  );

  it("item 12: the SAME proposal on a proposing tool still nudges (proves the exemption, not absence)", async () => {
    seedGlobalAvoid();
    const res = await preflightRejectedApproaches(
      fakeStore({}),
      noopBroadcast,
      "present_plan",
      [MATCHING_PROSE],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.nearMisses.some((n) => n.source === "global")).toBe(true);
  });

  it("item 12: a LOCAL stance still hard-blocks a comprehension tool (only the advisory lane is exempt)", async () => {
    const res = await preflightRejectedApproaches(
      fakeStore({ rejectedApproaches: [LOCAL_STANCE_FOR_BLOCK] }),
      noopBroadcast,
      "present_explainer",
      ["add a global mutable state for config singleton"],
    );
    expect(res.ok).toBe(false);
  });

  it("LOCAL-only consults keep their pre-Q2 wording byte-for-byte (no collateral drift)", () => {
    expect(
      formatPreflightTraceSummary({
        decision: "admitted",
        consideredCount: 3,
        consideredConcepts: [],
        nearMisses: [],
      }),
    ).toBe(" Preflight: considered 3 past stances.");
    expect(
      formatPreflightTraceSummary({
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [],
        nearMisses: [
          { source: "session", concept: "global mutable state", why: "Partial token overlap." },
        ],
      }),
    ).toBe(' Preflight: considered 1 past stance; near-miss: "global mutable state".');
  });
});

/**
 * Q2 — THE BLOCK IS HANDED TO THE DAEMON, not shouted into a no-op.
 *
 * The structural hole round 12 exposed: standalone.ts constructs the MCP server
 * with `broadcast = noop` (the daemon broadcasts its own mutations, and a block
 * is not one of them), so `broadcast(result.block.broadcastEvent)` reached NO
 * client on the production install path. Only the daemon-side DEMO ever
 * produced the hero toast — which is why the demo's replay felt like a
 * guarantee production never made. The fix routes the block over the same F1
 * seam the metric already uses; these pin the hand-off at its truth point.
 */
describe("Q2 — a real block is routed to the daemon for broadcast + durable persistence", () => {
  const LOCAL_STANCE = {
    description: "use a global mutable config singleton",
    concept: "global mutable state for config",
    reason: "test order-dependence",
  };
  const BLOCKING_PROPOSAL = "add a global mutable state for config singleton";

  function blockingStore(recorded: unknown[]): IStore {
    return {
      async getSessionMemory() {
        return { rejectedApproaches: [LOCAL_STANCE], approvedPatterns: [] };
      },
      recordPreflightBlock(event: unknown) {
        recorded.push(event);
      },
    } as unknown as IStore;
  }

  it("hands the SAME broadcastEvent to store.recordPreflightBlock when the gate fires", async () => {
    const recorded: unknown[] = [];
    const res = await preflightRejectedApproaches(
      blockingStore(recorded),
      noopBroadcast, // exactly what standalone.ts passes in production
      "present_code_change",
      [BLOCKING_PROPOSAL],
    );
    expect(res.ok).toBe(false);
    expect(recorded).toHaveLength(1);
    const event = recorded[0] as {
      type: string;
      source: string;
      match: { concept?: string; reason?: string };
    };
    expect(event.type).toBe("preflight_blocked");
    expect(event.source).toBe("session");
    expect(event.match.concept).toBe("global mutable state for config");
    expect(event.match.reason).toBe("test order-dependence");
  });

  it("does NOT route anything when the proposal is ADMITTED", async () => {
    const recorded: unknown[] = [];
    const res = await preflightRejectedApproaches(
      blockingStore(recorded),
      noopBroadcast,
      "present_code_change",
      ["rename the logger module and tidy its imports"],
    );
    expect(res.ok).toBe(true);
    expect(recorded).toEqual([]);
  });

  /**
   * Q2 review H1 — the summary is appended to the BLOCK message too (the CC1
   * lane), so a hardcoded "you have no local stance on this here" made a
   * blocked call contradict itself in the same sentence: "which the user
   * previously rejected" AND "you have no local stance". The reassurance is
   * only true on an admit with nothing local considered, so it is derived now.
   */
  it("H1: a BLOCK that also brushed a cross-project stance never claims 'no local stance'", async () => {
    seedGlobalAvoid();
    const res = await preflightRejectedApproaches(
      fakeStore({ rejectedApproaches: [LOCAL_STANCE_FOR_BLOCK] }),
      noopBroadcast,
      "present_code_change",
      // Blocks on the LOCAL stance, and separately brushes the GLOBAL one.
      ["add a global mutable state for config singleton using pay-per-request hosting"],
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const text = res.response.content[0]?.text ?? "";
    expect(text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(text).toContain("previously rejected");
    // The advisory still says what it is...
    expect(text).toContain("Cross-project advisory (not a block)");
    // ...without the self-contradiction.
    expect(text).not.toContain("you have no local stance");
  });

  it("H1: an ADMIT with local stances considered also drops the 'no local stance' clause", () => {
    const summary = formatPreflightTraceSummary({
      decision: "admitted",
      consideredCount: 2,
      consideredConcepts: [],
      nearMisses: [{ source: "global", concept: "pay-per-request hosting", project: "project-a" }],
    });
    expect(summary).toContain("Cross-project advisory (not a block)");
    expect(summary).not.toContain("no local stance");
  });

  it("H1: the reassurance IS kept where it's true — an admit with nothing local considered", () => {
    const summary = formatPreflightTraceSummary({
      decision: "admitted",
      consideredCount: 0,
      consideredConcepts: [],
      nearMisses: [{ source: "global", concept: "pay-per-request hosting", project: "project-a" }],
    });
    expect(summary).toContain("not a block, and you have no local stance on this here");
  });

  it("LOW: the nudge concatenation is capped — 2 spelled out, the rest counted", () => {
    const many = ["alpha beta", "gamma delta", "epsilon zeta", "eta theta"].map((concept) => ({
      source: "global" as const,
      concept,
      project: "project-a",
    }));
    const summary = formatPreflightTraceSummary({
      decision: "admitted",
      consideredCount: 0,
      consideredConcepts: [],
      nearMisses: many,
    });
    expect(summary).toContain('You avoided "alpha beta"');
    expect(summary).toContain('You avoided "gamma delta"');
    expect(summary).not.toContain('You avoided "epsilon zeta"');
    expect(summary).toContain("(and 2 more)");
  });

  it("a store WITHOUT the optional method still blocks cleanly (surfacing must never break the refusal)", async () => {
    const res = await preflightRejectedApproaches(
      fakeStore({ rejectedApproaches: [LOCAL_STANCE] }),
      noopBroadcast,
      "present_code_change",
      [BLOCKING_PROPOSAL],
    );
    expect(res.ok).toBe(false);
  });
});
