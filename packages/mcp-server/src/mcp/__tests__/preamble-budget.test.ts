/**
 * R5 (round-13 MED) — THE AGENT-CONTEXT BUDGET OWNER.
 *
 * Round-13's fresh structural concern: the agent-facing first-call context had
 * no budget owner. PROTOCOL_PREAMBLE grew +111% across four releases (8,135
 * chars at the census) as pure paragraph accretion, and it is EXPLICITLY exempt
 * from HINT_BUDGET_CHARS (it rides the uncapped prefix). Round 5's felt-weight
 * discipline was applied to the HUMAN's per-poll payload and never to the agent.
 *
 * This test is that owner: the assembled VANILLA first-call hint — the
 * supervised/rich default every session pays — must stay under
 * VANILLA_FIRST_CALL_BUDGET_CHARS, so the preamble cannot silently regrow. It is
 * a SIZE guard only; every load-bearing RULE (the floor, the three risk classes,
 * the guardrail backstop, the trivial-fix carve-out, the ESCALATED-only tags) is
 * pinned independently by guidance-flip-drift.test.ts. The two are orthogonal:
 * you may not delete a rule to fit the budget, and you may not grow the budget
 * to fit an un-reviewed rule — raising the ceiling is a deliberate, reviewed act.
 *
 * Fakes-not-mocks: real FileStore over a tmp dir; the global-store singleton is
 * an isolated empty tmp ledger (so no welcome-back / seeds inflate the vanilla
 * measure).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildFirstCallHint,
  PROTOCOL_PREAMBLE,
  VANILLA_FIRST_CALL_BUDGET_CHARS,
} from "../first-call-hint.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let store: FileStore;

beforeEach(() => {
  fx = withGlobalStore("dp-preamble-budget-");
  store = fx.track(new FileStore(fx.dir, "preamble_budget_session"));
});

afterEach(() => {
  fx.dispose();
});

describe("R5 — agent-context budget owner", () => {
  it("the assembled VANILLA (supervised/rich) first-call hint stays under the declared ceiling", async () => {
    // A fresh project: no memory, no guardrails, no team prefs, no seeds,
    // supervised autonomy, rich detail — the default every session pays.
    const hint = await buildFirstCallHint(store, 4000);
    expect(
      hint.length,
      `The vanilla first-call hint is ${hint.length} chars, over the ${VANILLA_FIRST_CALL_BUDGET_CHARS} ceiling.\n` +
        `This budget governs SIZE. Do NOT raise it to fit new prose — trim redundancy instead, keeping every rule pinned by guidance-flip-drift.test.ts. Raise it only with a reviewed reason.`,
    ).toBeLessThanOrEqual(VANILLA_FIRST_CALL_BUDGET_CHARS);
  });

  it("PROTOCOL_PREAMBLE itself stays under its share of the ceiling (the dominant term)", () => {
    // The preamble is the uncapped prefix's dominant term. Bound it directly so a
    // future paragraph-accretion PR trips THIS test, not a downstream one. Kept
    // strictly below the assembled ceiling (header + optional plugin tip ride on
    // top of it).
    expect(
      PROTOCOL_PREAMBLE.length,
      `PROTOCOL_PREAMBLE is ${PROTOCOL_PREAMBLE.length} chars.`,
    ).toBeLessThanOrEqual(6800);
  });
});
