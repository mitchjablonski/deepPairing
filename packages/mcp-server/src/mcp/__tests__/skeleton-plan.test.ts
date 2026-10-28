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

const scopeFile = () => path.join(root, ".deeppairing", "skeleton-scope.json");

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
    expect(fs.existsSync(scopeFile())).toBe(false);
  });

  it("in_progress opens the fence; done with SKEL_TODO left warns; done after the fill closes it", async () => {
    const presented = await callTool("present_plan", {
      title: "Smoothing skeleton",
      steps: [{ description: "dedupe", reasoning: "r", skelId: "1" }],
      estimatedChanges: 1,
    });
    expect(presented.text).toContain("Skeleton check: 1 fence found on disk");
    const plan = store.getArtifacts().find((a) => a.type === "plan")!;

    const started = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "in_progress" }] });
    expect(started.text).toContain("Skeleton fence active");
    expect(JSON.parse(fs.readFileSync(scopeFile(), "utf-8"))).toMatchObject({ artifactId: plan.id, activeSkelIds: ["1"], planTitle: "Smoothing skeleton" });

    const early = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "done" }] });
    expect(early.text).toContain("SKEL[1] still has SKEL_TODO at a.ts:2");
    expect(fs.existsSync(scopeFile())).toBe(false);

    fs.writeFileSync(path.join(root, "a.ts"), SRC.replace('throw new Error("SKEL_TODO");', "return [...new Set(raw)];"));
    await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "in_progress" }] });
    const done = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "done" }] });
    expect(done.text).not.toContain("SKEL_TODO");
    expect(fs.existsSync(scopeFile())).toBe(false);
  });
});
