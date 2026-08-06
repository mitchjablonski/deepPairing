/**
 * J2a (#210) — the debrief-owed nag scales with task SIZE.
 *
 * Round-5 interaction-model lens: a trivial single-file surgical fix must not be
 * pushed through "an enterprise review board". So check_feedback's H1
 * debrief-owed nag ("no present_debrief yet") fires ONLY when the session shape
 * has escalated past the trivial case:
 *
 *   1 code_change only             → NO nag (trivial — it self-summarizes)
 *   2+ code_changes                → nag  (escalated)
 *   1 changeset                    → nag  (multi-file)
 *   1 code_change + 1 decision     → nag  (a real decision escalates)
 *
 * The gate still requires the run to be WINDING DOWN (review drained, nothing
 * freshly rejected, no unanswered question) — those pre-conditions are pinned by
 * check-feedback-changeset.test.ts; here we isolate the SHAPE dimension by
 * approving every artifact so only the size-of-work varies.
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

async function presentCodeChange(filePath: string): Promise<string> {
  await callTool("present_code_change", {
    filePath,
    changeType: "modify",
    before: "const x = 1;",
    after: "const x = 2;",
    reasoning: `tweak ${filePath}`,
    confidence: "high",
  });
  const arts = store.getArtifacts().filter((a) => a.type === "code_change");
  return arts[arts.length - 1]!.id;
}

async function approve(id: string): Promise<void> {
  await store.updateArtifactStatus(id, "approved", "ui_approve_button" as any);
}

const NAG = "no present_debrief yet";

describe("check_feedback — J2a debrief-owed scales with task size", () => {
  it("TRIVIAL: a single approved code_change does NOT nag for a debrief", async () => {
    const id = await presentCodeChange("lib/a.ts");
    await approve(id);
    const res = await callTool("check_feedback");
    expect(res.text).not.toContain(NAG);
  });

  it("ESCALATED: two approved code_changes DO nag for a debrief", async () => {
    await approve(await presentCodeChange("lib/a.ts"));
    await approve(await presentCodeChange("lib/b.ts"));
    const res = await callTool("check_feedback");
    expect(res.text).toContain(NAG);
    expect(res.text).toContain("present_debrief");
  });

  it("ESCALATED: a single approved changeset DOES nag for a debrief", async () => {
    await callTool("present_changeset", {
      title: "Move TTL refresh into middleware",
      files: [
        { path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 26 }] }] },
      ],
    });
    const id = store.getArtifacts().find((a) => a.type === "changeset")!.id;
    await approve(id);
    const res = await callTool("check_feedback");
    expect(res.text).toContain(NAG);
  });

  it("ESCALATED: a single code_change + a plan DOES nag (F1 — planned work isn't a surgical fix)", async () => {
    await callTool("present_plan", {
      title: "Refactor pipeline",
      steps: [{ description: "extract helper", reasoning: "reuse" }],
      estimatedChanges: 1,
    });
    await approve(store.getArtifacts().find((a) => a.type === "plan")!.id);
    await approve(await presentCodeChange("lib/a.ts"));
    const res = await callTool("check_feedback");
    expect(res.text).toContain(NAG);
  });

  it("ESCALATED: a single code_change + a spec DOES nag (F1 — specced work isn't a surgical fix)", async () => {
    await callTool("present_spec", {
      title: "Auth spec",
      objective: "ship login",
      requirements: [{ id: "REQ-1", statement: "users log in", rationale: "core", acceptanceCriteria: ["works"] }],
    });
    await approve(store.getArtifacts().find((a) => a.type === "spec")!.id);
    await approve(await presentCodeChange("lib/a.ts"));
    const res = await callTool("check_feedback");
    expect(res.text).toContain(NAG);
  });

  it("TRIVIAL: a code_change SUPERSEDED by its live revision is ONE live change → no nag (F2)", async () => {
    // v1 gets tweaked into v2 — v1 flips to superseded, v2 is the live change.
    const v1 = await presentCodeChange("lib/a.ts");
    await store.updateArtifactStatus(v1, "superseded", "ui_supersede" as any);
    const v2 = await presentCodeChange("lib/a.ts");
    await approve(v2);
    const res = await callTool("check_feedback");
    // One superseded + one live code_change = ONE live change → still trivial.
    expect(res.text).not.toContain(NAG);
  });

  it("ESCALATED: a single code_change + a decision DOES nag (a real decision escalates)", async () => {
    // A decision moment happened — even a single-file fix owes the full arc.
    await callTool("present_options", {
      context: "Which cache strategy should we use?",
      options: [
        { id: "a", title: "Redis", description: "network cache", pros: ["fast"], cons: ["ops"], effort: "medium", risk: "medium", recommendation: true, concept: { name: "redis for caching" } },
        { id: "b", title: "In-process LRU", description: "no extra service", pros: ["simple"], cons: ["per-node"], effort: "low", risk: "low", recommendation: false, concept: { name: "in-process lru cache" } },
      ],
    });
    const decisionId = store.getArtifacts().find((a) => a.type === "decision")!.id;
    // Approve the decision so it's drained from the pending review queue — the
    // nag must fire on SHAPE (the decision exists), not because a draft is open.
    await approve(decisionId);
    await approve(await presentCodeChange("lib/a.ts"));
    const res = await callTool("check_feedback");
    expect(res.text).toContain(NAG);
  });
});
