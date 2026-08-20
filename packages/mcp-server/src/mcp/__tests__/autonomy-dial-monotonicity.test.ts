import { describe, it, expect } from "vitest";
import { AUTONOMY_POLICY_LINE } from "../autonomy-policy.js";

/**
 * Q2 review item 10 — THE DIAL MUST BE MONOTONE.
 *
 * Naming the architectural floor in `autonomous` (so Minimal stops agreeing
 * with "not an autonomous agent" only in the README) briefly INVERTED the
 * ladder on the check_feedback surface: Minimal's options trigger became
 * {architectural fork} ∪ {high-risk / irreversible} while Light's was only
 * {architectural choices} — making the QUIETER setting a strict superset of
 * the louder one. A user dialing Full → Light → Minimal must never find the
 * agent getting MORE talkative on the way down.
 *
 * `balanced` now names the same two triggers, so the two are equal on options
 * and Light stays strictly more talkative overall — it still posts findings for
 * non-simple tasks and plans for multi-file changes, both of which Minimal
 * skips outright.
 */
describe("autonomy dial — Full ⊃ Light ⊃ Minimal", () => {
  const light = AUTONOMY_POLICY_LINE.balanced;
  const minimal = AUTONOMY_POLICY_LINE.autonomous;

  it("every options trigger Minimal names is also named by Light", () => {
    // The two triggers that decide whether a fork reaches the human.
    for (const trigger of [/architectural/i, /high-risk or irreversible/i]) {
      expect(minimal, `Minimal should name ${trigger}`).toMatch(trigger);
      expect(light, `Light must not be quieter than Minimal on ${trigger}`).toMatch(trigger);
    }
  });

  it("Light is strictly louder: it keeps findings, Minimal explicitly skips the ceremony", () => {
    expect(minimal).toMatch(/skip the findings\/plan ceremony/i);
    expect(light).toMatch(/skip findings for simple tasks/i);
    // "simple tasks" is a NARROWER exemption than "the ceremony" wholesale —
    // that difference is what keeps the ladder strict.
    expect(light).not.toMatch(/skip the findings\/plan ceremony/i);
  });

  it("Minimal still names the floor (it is not an autonomous agent)", () => {
    expect(minimal).toMatch(/floor still holds/i);
    expect(minimal).toMatch(/present_options/);
    // The repudiated wording must never come back.
    expect(minimal).not.toMatch(/Only present decisions for high-risk or irreversible/i);
  });
});
