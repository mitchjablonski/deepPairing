/**
 * Skeleton plans — present_plan with `skelId` steps checks the fences exist on
 * disk; update_plan_progress turns in_progress skelId steps into the hook's
 * fence scope and refuses to stay quiet about a "done" step that still holds
 * SKEL_TODO.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

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
`;

beforeEach(() => {
  store = ctx.store;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skelplan-")));
  fs.writeFileSync(path.join(root, "a.ts"), SRC);
  prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
});
afterEach(() => {
  if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
  fs.rmSync(root, { recursive: true, force: true });
});

const scopeFile = (artifactId: string) => path.join(root, ".deeppairing", "skeleton-scopes", `${artifactId}.json`);
const presentSkeleton = async (title: string, skelId: string) => {
  await callTool("present_plan", { title, steps: [{ description: "fill", reasoning: "r", skelId }], estimatedChanges: 1 });
  const plan = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
  store.updateArtifactStatus(plan.id, "approved", "ui_approve_button");
  return plan;
};

describe("skeleton plans", () => {
  it("persists skelId and reports the on-disk fence check", async () => {
    const res = await callTool("present_plan", {
      title: "Smoothing skeleton",
      steps: [
        { description: "dedupe", reasoning: "r", skelId: "1" },
        { description: "wire it", reasoning: "r", skelId: "7" },
      ],
      estimatedChanges: 1,
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('step skelId "7" has no SKEL[7] fence on disk');
    const plan = store.getArtifacts().find((a) => a.type === "plan")!;
    expect((plan.content as any).steps.map((s: any) => s.skelId)).toEqual(["1", "7"]);
  });

  it("an ordinary plan says nothing about skeletons and writes no scope", async () => {
    const res = await callTool("present_plan", { title: "P", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1 });
    expect(res.text).not.toContain("Skeleton");
    const plan = store.getArtifacts().find((a) => a.type === "plan")!;
    await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "in_progress" }] });
    expect(fs.existsSync(path.join(root, ".deeppairing", "skeleton-scopes"))).toBe(false);
  });

  it("in_progress opens the fence; done with SKEL_TODO left warns; done after the fill closes it", async () => {
    const presented = await callTool("present_plan", {
      title: "Smoothing skeleton",
      steps: [{ description: "dedupe", reasoning: "r", skelId: "1" }],
      estimatedChanges: 1,
    });
    expect(presented.text).toContain("Skeleton check: 1 fence found on disk");
    const plan = store.getArtifacts().find((a) => a.type === "plan")!;
    store.updateArtifactStatus(plan.id, "approved", "ui_approve_button");

    const started = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "in_progress" }] });
    expect(started.text).toContain("Skeleton fence active");
    expect(JSON.parse(fs.readFileSync(scopeFile(plan.id), "utf-8"))).toMatchObject({
      artifactId: plan.id, activeSkelIds: ["1"], planTitle: "Smoothing skeleton", sessionId: store.getSessionId(), workspaceRoot: root,
    });

    const early = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "done" }] });
    expect(early.text).toContain("SKEL[1] still has SKEL_TODO at a.ts:2");
    expect(fs.existsSync(scopeFile(plan.id))).toBe(false);

    fs.writeFileSync(path.join(root, "a.ts"), SRC.replace('throw new Error("SKEL_TODO");', "return [...new Set(raw)];"));
    await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "in_progress" }] });
    const done = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "done" }] });
    expect(done.text).not.toContain("SKEL_TODO");
    expect(fs.existsSync(scopeFile(plan.id))).toBe(false);
  });

  it("#606 review: a second plan's progress (even a draft's) never replaces or removes the first plan's fence", async () => {
    fs.writeFileSync(path.join(root, "b.ts"), "export function g() {\n  // SKEL[2] g\n  throw new Error(\"SKEL_TODO\");\n  // /SKEL[2]\n}\n");
    const a = await presentSkeleton("Plan A", "1");
    await callTool("update_plan_progress", { artifactId: a.id, updates: [{ stepIndex: 0, status: "in_progress" }] });

    await callTool("present_plan", { title: "Plan B (draft)", steps: [{ description: "g", reasoning: "r", skelId: "2" }], estimatedChanges: 1 });
    const b = store.getArtifacts().filter((x) => x.type === "plan").at(-1)!;
    expect(b.status).toBe("draft");
    await callTool("update_plan_progress", { artifactId: b.id, updates: [{ stepIndex: 0, status: "in_progress" }] });
    await callTool("update_plan_progress", { artifactId: b.id, updates: [{ stepIndex: 0, status: "done" }] });

    expect(fs.existsSync(scopeFile(b.id))).toBe(false);
    expect(JSON.parse(fs.readFileSync(scopeFile(a.id), "utf-8")).activeSkelIds).toEqual(["1"]);
  });
});
