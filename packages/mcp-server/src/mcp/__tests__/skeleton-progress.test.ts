/**
 * Skeleton plans, parity PR 3 — progress read from the code. Each
 * update_plan_progress on a skeleton plan re-reads its fenced files (the same
 * bounds and allowlist as present_plan), so the code view and diagram follow
 * the fills; the reply warns when the checklist and the code disagree. Real
 * files in a temp project; no mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanVisual } from "@deeppairing/shared";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { UNFENCED_VISUAL_ID } from "../skeleton-snapshot.js";
import { skeletonProgressMismatches } from "../skeleton-line.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let root: string;
let prevProjectDir: string | undefined;

const SRC = `export function smooth(raw: number[]): number[] {
  // SKEL[1] drop duplicates
  throw new Error("SKEL_TODO");
  // /SKEL[1]
}

export function wire(): void {
  // SKEL[2] connect the canvas
  canvas.on("stroke", smooth);
  // /SKEL[2]
}
`;
const FILLED = SRC.replace('throw new Error("SKEL_TODO");', "return [...new Set(raw)];");
const DIAGRAM = { id: "arch", kind: "diagram", title: "Shape", source: "graph TD; step_1-->step_2" };
const FILE_MAP = {
  id: "fm",
  kind: "file_map",
  files: [
    { path: "a.ts", change: "modify" },
    { path: "types.ts", change: "create" },
  ],
};
const STEPS = [
  { description: "dedupe", reasoning: "r", skelId: "1" },
  { description: "wire it", reasoning: "r", skelId: "2" },
];

beforeEach(() => {
  store = ctx.store;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skelprog-")));
  fs.writeFileSync(path.join(root, "a.ts"), SRC);
  fs.writeFileSync(path.join(root, "types.ts"), "export interface Point { x: number }\n");
  prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
});
afterEach(() => {
  if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
  fs.rmSync(root, { recursive: true, force: true });
});

const planOf = (id: string) => store.getArtifacts().find((a) => a.id === id)!;
const visualsOf = (id: string) => ((planOf(id).content as { visuals?: PlanVisual[] }).visuals ?? []);
/** The APPROVED snapshot (what the human reviewed) and the LIVE progress snapshot. */
const approvedView = (id: string) => visualsOf(id).find((v) => v.id === "skelcode:a.ts")!;
const liveView = (id: string) => visualsOf(id).find((v) => v.id === "skelcode-live:a.ts");

async function presentApproved(visuals: unknown[] = [DIAGRAM, FILE_MAP]) {
  await callTool("present_plan", { title: "Smoothing skeleton", steps: STEPS, estimatedChanges: 2, visuals });
  const plan = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
  store.updateArtifactStatus(plan.id, "approved", "ui_approve_button");
  return plan.id;
}
const progress = (artifactId: string, stepIndex: number, status: string) =>
  callTool("update_plan_progress", { artifactId, updates: [{ stepIndex, status }] });

describe("skeleton progress — re-read on update_plan_progress", () => {
  it("the LIVE view follows the fill; the APPROVED snapshot stays exactly what was reviewed", async () => {
    const id = await presentApproved();
    const approved = structuredClone(approvedView(id));
    expect(approved.skeleton?.fences.map((f) => f.status)).toEqual(["todo", "filled"]);
    expect(liveView(id)).toBeUndefined(); // nothing live until the first progress call
    await progress(id, 0, "in_progress");
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    await progress(id, 0, "done");
    const live = liveView(id)!;
    expect(live.code).toContain("return [...new Set(raw)];");
    expect(live.skeleton?.fences.map((f) => f.status)).toEqual(["filled", "filled"]);
    expect(typeof live.skeleton?.readAt).toBe("number");
    // The approved record is byte-identical to what the human approved.
    expect(approvedView(id)).toEqual(approved);
    expect(visualsOf(id).map((v) => v.id)).toEqual(["arch", "fm", "skelcode:a.ts", UNFENCED_VISUAL_ID, "skelcode-live:a.ts"]);
    expect(visualsOf(id)[0]).toEqual(DIAGRAM);
  });

  it("keeps #607's bounds and allowlist: protected files never appear, unfenced files stay path-only", async () => {
    // A protected file holding a claimed fence: never shown, before or after a re-read.
    fs.writeFileSync(path.join(root, ".env"), '// LEAK-MARKER\n// SKEL[2] x\nthrow new Error("SKEL_TODO");\n// /SKEL[2]\n');
    const id = await presentApproved([DIAGRAM, { ...FILE_MAP, files: [...FILE_MAP.files, { path: ".env", change: "modify" }] }]);
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    await progress(id, 0, "in_progress");
    const json = JSON.stringify(planOf(id).content);
    expect(json).not.toContain("LEAK-MARKER");
    expect(json).not.toContain("interface Point");
    expect(visualsOf(id).filter((v) => v.kind === "annotated_code").map((v) => v.id)).toEqual(["skelcode:a.ts", "skelcode-live:a.ts"]);
    expect(visualsOf(id).find((v) => v.id === UNFENCED_VISUAL_ID)!.files!.map((f) => f.path)).toEqual(["types.ts"]);
  });

  it("a secret written mid-fill is withheld on the re-read (never stored), with fence status kept", async () => {
    const id = await presentApproved();
    const token = ["gh", "p_", "Q".repeat(36)].join("");
    fs.writeFileSync(path.join(root, "a.ts"), FILLED.replace("canvas.on", `const k = "${token}";\n  canvas.on`));
    const res = await progress(id, 0, "in_progress");
    const a = liveView(id)!;
    expect(a.code).toBeUndefined();
    expect(a.skeleton?.withheld).toContain("possible secret detected");
    // Status still comes from the code, without fence titles (a marker line could hold the value).
    expect(a.skeleton?.fences).toEqual([
      { id: "1", openLine: 2, closeLine: 4, status: "filled" },
      { id: "2", openLine: 8, closeLine: 11, status: "filled" },
    ]);
    expect(JSON.stringify(planOf(id))).not.toContain(token);
    expect(res.text).not.toContain(token);
  });

  it("an unchanged file keeps its takenAt (its line comments aren't flagged as moved)", async () => {
    const id = await presentApproved();
    const first = approvedView(id).skeleton?.takenAt;
    expect(first).toBeTruthy();
    await progress(id, 0, "in_progress");
    expect(liveView(id)!.skeleton?.takenAt).toBe(first);
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    await progress(id, 0, "done");
    expect(liveView(id)!.code).toContain("return [...new Set(raw)];");
    expect(liveView(id)!.skeleton?.takenAt).toBeTruthy();
  });

  for (const status of ["superseded", "rejected", "retracted", "obsolete"] as const) {
    it(`a ${status} plan is never re-read: its code stays as reviewed`, async () => {
      const id = await presentApproved();
      await progress(id, 0, "in_progress"); // a live snapshot exists while live
      const before = structuredClone(visualsOf(id));
      // Set directly: the transition path to each status differs, the rule doesn't.
      (planOf(id) as { status: string }).status = status;
      fs.writeFileSync(path.join(root, "a.ts"), FILLED);
      await progress(id, 0, "done");
      expect(visualsOf(id)).toEqual(before);
      expect(JSON.stringify(visualsOf(id))).not.toContain("new Set(raw)");
    });
  }

  it("a version with a successor is not live, even before its status flips (enforced in the store)", async () => {
    const id = await presentApproved();
    const before = structuredClone(visualsOf(id));
    // A v2 naming v1 as parent, status still draft on v1's side of the race.
    await store.createArtifact({ id: "art_v2race", type: "plan", title: "v2", content: { steps: STEPS, estimatedChanges: 1 }, parentId: id, version: 2 } as any);
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    const fresh = [{ id: "skelcode-live:a.ts", kind: "annotated_code", code: "x", filePath: "a.ts", skeleton: { fences: [], readAt: 1 } }];
    store.updatePlanProgress(id, [{ stepIndex: 0, status: "in_progress" }], { skeletonVisuals: fresh, skeletonReadAt: 1 });
    expect(visualsOf(id)).toEqual(before);
  });

  it("a line comment on the LIVE view is delivered against the live fences, separate from the approved view's", async () => {
    const id = await presentApproved();
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    await progress(id, 0, "in_progress");
    await store.addComment({
      id: "cmt_live",
      artifactId: id,
      content: "is Set order stable here?",
      author: "human",
      target: { visualId: "skelcode-live:a.ts", filePath: "a.ts", lineStart: 3, lineEnd: 3 },
    } as any);
    const res = await callTool("check_feedback");
    expect(res.text).toContain("a.ts:3 (inside the SKEL[1] fence, step 1 — active)");
  });

  it("M2: an approved-skeleton comment is named as such and stays exact after fills", async () => {
    const id = await presentApproved();
    await store.addComment({
      id: "cmt_appr",
      artifactId: id,
      content: "dedupe by distance",
      author: "human",
      target: {
        visualId: "skelcode:a.ts",
        filePath: "a.ts",
        lineStart: 3,
        lineEnd: 3,
        skeletonAnchor: { snapshot: "approved", fenceId: "1", lineText: '  throw new Error("SKEL_TODO");' },
      },
    } as any);
    fs.writeFileSync(path.join(root, "a.ts"), "// moved\n// moved\n" + FILLED);
    await progress(id, 0, "in_progress");
    const res = await callTool("check_feedback");
    expect(res.text).toContain("a.ts:3 (inside the SKEL[1] fence, step 1 — active) — on the approved skeleton");
    expect(res.text).not.toContain("changed since");
  });

  it("M2: a live comment keeps its anchor across a re-read, names its view, and says the code changed since", async () => {
    const id = await presentApproved();
    await progress(id, 0, "in_progress");
    const live = liveView(id)!;
    const line3 = live.code!.split("\n")[2]!;
    await store.addComment({
      id: "cmt_live_anchor",
      artifactId: id,
      content: "is this the right error?",
      author: "human",
      target: {
        visualId: "skelcode-live:a.ts",
        filePath: "a.ts",
        lineStart: 3,
        lineEnd: 3,
        skeletonAnchor: { snapshot: "live", takenAt: live.skeleton!.takenAt, readAt: live.skeleton!.readAt, fenceId: "1", lineText: line3 },
      },
    } as any);
    // Unchanged so far: named, no "changed since".
    const first = await callTool("check_feedback", { peek: true });
    expect(first.text).toContain(`a.ts:3 (inside the SKEL[1] fence, step 1 — active) — on the live view as of ${new Date(Math.floor(live.skeleton!.readAt!)).toISOString()}`);
    expect(first.text).not.toContain("changed since");
    // Two lines inserted above: live line 3 is now a different line; the anchor still names fence 1.
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(path.join(root, "a.ts"), "// added\n// added\n" + SRC);
    await progress(id, 0, "in_progress");
    expect(liveView(id)!.code!.split("\n")[2]).not.toBe(line3);
    await store.addComment({
      id: "cmt_nudge",
      artifactId: id,
      content: "and this one?",
      author: "human",
      target: {
        visualId: "skelcode-live:a.ts",
        filePath: "a.ts",
        lineStart: 3,
        lineEnd: 3,
        skeletonAnchor: { snapshot: "live", takenAt: live.skeleton!.takenAt, readAt: live.skeleton!.readAt, fenceId: "1", lineText: line3 },
      },
    } as any);
    const res = await callTool("check_feedback");
    expect(res.text).toContain("a.ts:3 (inside the SKEL[1] fence, step 1 — active) — on the live view as of");
    expect(res.text).toContain('the code has changed since, so this line may have moved — when commented it read "throw new Error(\\"SKEL_TODO\\");"');
  });

  it("the live swap is atomic per plan and keeps the NEWEST read (a stale concurrent read is dropped)", async () => {
    const id = await presentApproved();
    const snap = (code: string, readAt: number) => [
      { id: "skelcode-live:a.ts", kind: "annotated_code", code, filePath: "a.ts", skeleton: { fences: [], readAt } },
      { id: "skelcode-live:b.ts", kind: "annotated_code", code, filePath: "b.ts", skeleton: { fences: [], readAt } },
    ];
    store.updatePlanProgress(id, [{ stepIndex: 0, status: "in_progress" }], { skeletonVisuals: snap("newer", 20), skeletonReadAt: 20 });
    // The older read lands second: the step update applies, the stale code does not.
    const after = store.updatePlanProgress(id, [{ stepIndex: 1, status: "in_progress" }], { skeletonVisuals: snap("older", 10), skeletonReadAt: 10 })!;
    const steps = (after.content as { steps: Array<{ status?: string }> }).steps;
    expect(steps.map((st) => st.status)).toEqual(["in_progress", "in_progress"]);
    const live = visualsOf(id).filter((v) => v.id.startsWith("skelcode-live:"));
    expect(live.map((v) => v.code)).toEqual(["newer", "newer"]); // all-or-nothing, never mixed
    // Only live ids are accepted: an approved-id visual in the payload is ignored.
    store.updatePlanProgress(id, [{ stepIndex: 0, status: "in_progress" }], {
      skeletonVisuals: [{ id: "skelcode:a.ts", kind: "annotated_code", code: "FORGED" }],
      skeletonReadAt: 30,
    });
    expect(approvedView(id).code).not.toBe("FORGED");
  });

  it("a non-skeleton plan's progress leaves its content exactly as it was", async () => {
    await callTool("present_plan", { title: "P", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1, visuals: [DIAGRAM] });
    const plan = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    const before = structuredClone((plan.content as { visuals?: unknown }).visuals);
    const res = await progress(plan.id, 0, "in_progress");
    expect((planOf(plan.id).content as { visuals?: unknown }).visuals).toEqual(before);
    expect(res.text).not.toContain("disagree");
  });
});

describe("skeleton progress — the checklist vs the code", () => {
  it("warns when a step is pending but its fence is already filled", async () => {
    const id = await presentApproved();
    // SKEL[2] is filled on disk from the start; step 2 is still pending.
    const res = await progress(id, 0, "in_progress");
    expect(res.text).toContain("The checklist and the code disagree");
    expect(res.text).toContain("step 2 (SKEL[2]) is still pending, but its fence is already filled in the code");
  });

  it("warns when an earlier 'done' step still has SKEL_TODO — without repeating #606's same-call warning", async () => {
    const id = await presentApproved();
    await progress(id, 1, "done"); // SKEL[2]: filled, so done is honest
    const early = await progress(id, 0, "done"); // SKEL[1]: still SKEL_TODO
    expect(early.text).toContain("SKEL[1] still has SKEL_TODO at a.ts:2"); // #606's line
    expect(early.text).not.toContain("step 1 (SKEL[1]) is marked done");
    // A later call names the stale "done" step from the code.
    const later = await progress(id, 1, "done");
    expect(later.text).toContain("step 1 (SKEL[1]) is marked done, but SKEL_TODO is still in the code at a.ts:2");
  });

  it("skeletonProgressMismatches is quiet when the checklist and code agree", () => {
    const fences = [
      { id: "1", file: "a.ts", openLine: 2, status: "filled" as const },
      { id: "2", file: "a.ts", openLine: 8, status: "todo" as const },
    ];
    expect(skeletonProgressMismatches([{ skelId: "1", status: "done" }, { skelId: "2", status: "in_progress" }], fences)).toEqual([]);
    expect(skeletonProgressMismatches([{ skelId: "1", status: "in_progress" }, { skelId: "2", status: "pending" }], fences)).toEqual([]);
  });
});
