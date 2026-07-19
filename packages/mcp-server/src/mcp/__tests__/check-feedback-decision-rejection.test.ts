/**
 * #169 — check_feedback must not tell the agent "You may proceed with
 * implementation." when the poll carries a WHOLE-CARD-rejected decision.
 * Pre-fix `freshlyRejected` excluded `decision`, so a rejected decision fell
 * straight through to the "proceed" suggestedAction — while the same poll
 * reported the rejection verdict. This asserts a rejected decision now gets the
 * same "Do NOT apply / address the rejection" posture every other rejected type
 * gets.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

async function presentAndRejectDecision(): Promise<string> {
  await callTool("present_options", {
    context: "Which cache strategy should we use?",
    options: [
      { id: "a", title: "Redis", description: "network cache", pros: ["fast"], cons: ["ops"], effort: "medium", risk: "medium", recommendation: true, concept: { name: "redis for caching" } },
      { id: "b", title: "In-process LRU", description: "no extra service", pros: ["simple"], cons: ["per-node"], effort: "low", risk: "low", recommendation: false, concept: { name: "in-process lru cache" } },
    ],
  });
  const art = store.getArtifacts().find((a) => a.type === "decision")!;
  // Whole-card rejection: the human rejects the framing (status → rejected).
  await store.updateArtifactStatus(art.id, "rejected", "ui_reject_button" as any);
  return art.id;
}

describe("check_feedback — rejected decision suggestedAction (#169)", () => {
  it("does NOT say 'You may proceed' — it says do NOT apply", async () => {
    const artId = await presentAndRejectDecision();

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;

    expect(sc.suggestedAction).not.toContain("You may proceed");
    expect(sc.suggestedAction).toContain("Do NOT apply");
    expect(sc.suggestedAction).toContain("REJECTED");
    // The rejected decision is machine-readable in structuredContent.
    expect(sc.status).toBe("feedback");
    expect(sc.rejected.map((r: any) => r.id)).toContain(artId);
    expect(sc.rejected.find((r: any) => r.id === artId).type).toBe("decision");
    // And the prose carries the unmissable ❌ REJECTED block.
    expect(res.text).toContain("❌ REJECTED");
  });

  it("reports the rejected decision verdict exactly once (reportedRejectedVerdicts dedupe)", async () => {
    await presentAndRejectDecision();
    const first = await callTool("check_feedback");
    expect((first.structuredContent as any).rejected).toHaveLength(1);
    // Second poll: already reported → no longer in the fresh rejected set,
    // and the suggestedAction no longer re-fires the rejection posture.
    const second = await callTool("check_feedback");
    expect((second.structuredContent as any).rejected).toHaveLength(0);
    expect((second.structuredContent as any).suggestedAction).not.toContain("Do NOT apply");
  });
});
