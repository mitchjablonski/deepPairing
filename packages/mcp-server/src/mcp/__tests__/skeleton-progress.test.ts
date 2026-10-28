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
const codeView = (id: string) => visualsOf(id).find((v) => v.id === "skelcode:a.ts")!;

async function presentApproved(visuals: unknown[] = [DIAGRAM, FILE_MAP]) {
  await callTool("present_plan", { title: "Smoothing skeleton", steps: STEPS, estimatedChanges: 2, visuals });
  const plan = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
  store.updateArtifactStatus(plan.id, "approved", "ui_approve_button");
  return plan.id;
}
const progress = (artifactId: string, stepIndex: number, status: string) =>
  callTool("update_plan_progress", { artifactId, updates: [{ stepIndex, status }] });

describe("skeleton progress — re-read on update_plan_progress", () => {
  it("the code view follows the fill: new text, fence status from disk, agent visuals untouched", async () => {
    const id = await presentApproved();
    expect(codeView(id).skeleton?.fences.map((f) => f.status)).toEqual(["todo", "filled"]);
    await progress(id, 0, "in_progress");
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    await progress(id, 0, "done");
    const a = codeView(id);
    expect(a.code).toContain("return [...new Set(raw)];");
    expect(a.skeleton?.fences.map((f) => f.status)).toEqual(["filled", "filled"]);
    expect(visualsOf(id).map((v) => v.id)).toEqual(["arch", "fm", "skelcode:a.ts", UNFENCED_VISUAL_ID]);
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
    expect(visualsOf(id).filter((v) => v.kind === "annotated_code").map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(visualsOf(id).find((v) => v.id === UNFENCED_VISUAL_ID)!.files!.map((f) => f.path)).toEqual(["types.ts"]);
  });

  it("a secret written mid-fill is withheld on the re-read (never stored), with fence status kept", async () => {
    const id = await presentApproved();
    const token = ["gh", "p_", "Q".repeat(36)].join("");
    fs.writeFileSync(path.join(root, "a.ts"), FILLED.replace("canvas.on", `const k = "${token}";\n  canvas.on`));
    const res = await progress(id, 0, "in_progress");
    const a = codeView(id);
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
    const first = codeView(id).skeleton?.takenAt;
    expect(first).toBeTruthy();
    await progress(id, 0, "in_progress");
    expect(codeView(id).skeleton?.takenAt).toBe(first);
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    await progress(id, 0, "done");
    expect(codeView(id).code).toContain("return [...new Set(raw)];");
    expect(codeView(id).skeleton?.takenAt).toBeTruthy();
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
