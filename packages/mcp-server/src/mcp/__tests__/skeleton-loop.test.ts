/**
 * Skeleton plans, parity PR 4 — the fill loop's controls: the finalize check
 * (no SKEL markers or SKEL_TODO left before review), reshape as a supersede
 * that pauses fills, the #608 (a) notice when a fence is lifted without the
 * step being done, and the server-side cap on a comment's skeleton anchor.
 * Real files in a temp project; no mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKELETON_ANCHOR_LIMITS } from "@deeppairing/shared";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { skeletonLeftovers } from "../skeleton-finalize.js";

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
const FILLED = SRC.replace('throw new Error("SKEL_TODO");', "return [...new Set(raw)];");
const FINAL = "export function smooth(raw: number[]): number[] {\n  return [...new Set(raw)];\n}\n";
const STEPS = [{ description: "dedupe", reasoning: "r", skelId: "1", files: ["a.ts"] }];

beforeEach(() => {
  store = ctx.store;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skelloop-")));
  fs.writeFileSync(path.join(root, "a.ts"), SRC);
  prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
});
afterEach(() => {
  if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
  fs.rmSync(root, { recursive: true, force: true });
});

async function presentApproved() {
  await callTool("present_plan", { title: "Smoothing skeleton", steps: STEPS, estimatedChanges: 1 });
  const plan = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
  store.updateArtifactStatus(plan.id, "approved", "ui_approve_button");
  return plan.id;
}
const progress = (artifactId: string, stepIndex: number, status: string) =>
  callTool("update_plan_progress", { artifactId, updates: [{ stepIndex, status }] });
const changeset = () =>
  callTool("present_changeset", {
    title: "Stroke smoothing",
    files: [{ path: "a.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 2 }] }] }],
  });

describe("finalize check", () => {
  it("the last 'done' lists every marker and SKEL_TODO left, with locations", async () => {
    const id = await presentApproved();
    await progress(id, 0, "in_progress");
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    const res = await progress(id, 0, "done");
    expect(res.text).toContain(`Skeleton markers remain in "Smoothing skeleton"'s files`);
    expect(res.text).toContain("a.ts:2 SKEL[1], a.ts:4 /SKEL[1]");
    expect(res.text).not.toContain("SKEL_TODO,"); // filled: no stub left
  });

  it("present_changeset and present_debrief warn while markers remain, and go quiet once stripped", async () => {
    const id = await presentApproved();
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    await progress(id, 0, "done");
    const early = await changeset();
    expect(early.text).toContain("Skeleton markers remain");
    expect(early.text).toContain("a.ts:2 SKEL[1]");
    const debrief = await callTool("present_debrief", { title: "Smoothing", summary: "Done." });
    expect(debrief.text).toContain("Skeleton markers remain");

    fs.writeFileSync(path.join(root, "a.ts"), FINAL);
    const clean = await callTool("present_changeset", {
      title: "Stroke smoothing v2",
      files: [{ path: "a.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "y", newLine: 2 }] }] }],
    });
    expect(clean.text).not.toContain("Skeleton markers remain");
  });

  it("a stray SKEL_TODO outside any fence is caught too; a clean finish says what's next", async () => {
    fs.writeFileSync(path.join(root, "a.ts"), FINAL + 'throw new Error("SKEL_TODO");\n');
    expect(skeletonLeftovers(root, { steps: STEPS }).leftovers).toEqual([{ file: "a.ts", line: 4, what: "SKEL_TODO" }]);
    fs.writeFileSync(path.join(root, "a.ts"), FINAL);
    const id = await presentApproved();
    const res = await progress(id, 0, "done");
    expect(res.text).toContain("Every skeleton step is done and no SKEL markers remain");
  });

  it("an unfinished skeleton plan, or no skeleton at all, adds nothing", async () => {
    await presentApproved(); // step still pending
    expect((await changeset()).text).not.toContain("Skeleton markers");
  });
});

describe("reshape and lifted fences", () => {
  it("superseding a skeleton plan is a skeleton change: the reply says fills pause until approval", async () => {
    const id = await presentApproved();
    const res = await callTool("revise_artifact", {
      artifactId: id,
      mode: "supersede",
      reason: "Skeleton change: smooth() needs a tension parameter",
      content: { steps: STEPS, estimatedChanges: 1 },
    });
    expect(res.text).toContain("Skeleton change: your pair re-reviews the reshaped skeleton");
    const v2 = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    expect(v2.parentId).toBe(id);
    expect(v2.agentReasoning).toBe("Skeleton change: smooth() needs a tension parameter");
    const paused = await progress(v2.id, 0, "in_progress");
    expect(paused.text).toContain("reshaped skeleton awaiting re-review: fills are paused");
    expect(paused.text).toContain("Skeleton fence NOT opened");
  });

  it("#608 (a): leaving in_progress without done posts a notice on the plan and warns the agent", async () => {
    const id = await presentApproved();
    await progress(id, 0, "in_progress");
    const res = await progress(id, 0, "pending");
    expect(res.text).toContain("Fence lifted without done: SKEL[1] (step 1, now pending)");
    const notice = store.getComments().find((c) => c.target.artifactId === id && c.author === "agent" && c.content.includes("Fence lifted"));
    expect(notice?.content).toContain("Fence lifted without completing the step: SKEL[1] (step 1, now pending)");
    // done is the normal exit: no notice.
    await progress(id, 0, "in_progress");
    const ok = await progress(id, 0, "done");
    expect(ok.text).not.toContain("Fence lifted");
  });
});

describe("comment skeleton anchor (server-side cap)", () => {
  it("caps lineText and other strings, and drops a malformed anchor", async () => {
    const id = await presentApproved();
    const long = "x".repeat(2000);
    const c = store.addComment({
      id: "cmt_cap",
      artifactId: id,
      content: "long line",
      author: "human",
      target: { visualId: "skelcode:a.ts", filePath: "a.ts", lineStart: 2, skeletonAnchor: { snapshot: "live", lineText: long, fenceId: "f".repeat(400), takenAt: "t".repeat(200), readAt: 5, extra: "dropped" } },
    });
    const a = c.target.skeletonAnchor!;
    expect(a.lineText).toHaveLength(SKELETON_ANCHOR_LIMITS.lineText);
    expect(a.fenceId).toHaveLength(SKELETON_ANCHOR_LIMITS.fenceId);
    expect(a.takenAt).toHaveLength(SKELETON_ANCHOR_LIMITS.takenAt);
    expect(a).not.toHaveProperty("extra");
    expect(a.readAt).toBe(5);

    const bad = store.addComment({
      id: "cmt_bad",
      artifactId: id,
      content: "bad anchor",
      author: "human",
      target: { visualId: "skelcode:a.ts", filePath: "a.ts", lineStart: 2, skeletonAnchor: { snapshot: "elsewhere", lineText: "x" } },
    });
    expect(bad.target).not.toHaveProperty("skeletonAnchor");
    expect(bad.target.visualId).toBe("skelcode:a.ts");

    const plain = store.addComment({ id: "cmt_plain", artifactId: id, content: "plain", author: "human", target: { lineStart: 1, filePath: "a.ts" } });
    expect(plain.target).toEqual({ artifactId: id, lineStart: 1, filePath: "a.ts" });
  });
});
