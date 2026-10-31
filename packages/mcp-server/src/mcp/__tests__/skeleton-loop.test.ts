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
import { writeReshapeScope } from "../skeleton-reshape.js";

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

  it("#610 L3: prose files are checked only for this plan's own fences, never for a stray SKEL_TODO", () => {
    fs.writeFileSync(path.join(root, "a.ts"), FINAL);
    fs.writeFileSync(path.join(root, "README.md"), "Example:\n// SKEL[9] demo\nthrow new Error(\"SKEL_TODO\");\n// /SKEL[9]\n");
    const steps = [{ ...STEPS[0]!, files: ["a.ts", "README.md"] }];
    expect(skeletonLeftovers(root, { steps }).leftovers).toEqual([]);
    // A fence the plan claims is real even in a prose file.
    fs.writeFileSync(path.join(root, "README.md"), "// SKEL[1] doc step\nfilled\n// /SKEL[1]\n");
    expect(skeletonLeftovers(root, { steps }).leftovers.map((l) => l.what)).toEqual(["SKEL[1]", "/SKEL[1]"]);
  });

  it("#610 L3: only the CURRENT finished plan warns, not an older one", async () => {
    fs.writeFileSync(path.join(root, "old.ts"), "// SKEL[1] old\nx\n// /SKEL[1]\n");
    await callTool("present_plan", { title: "Old skeleton", steps: [{ description: "old", reasoning: "r", skelId: "1", files: ["old.ts"] }], estimatedChanges: 1 });
    const old = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    store.updateArtifactStatus(old.id, "approved", "ui_approve_button");
    await progress(old.id, 0, "done");
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(path.join(root, "a.ts"), FINAL);
    const id = await presentApproved();
    await progress(id, 0, "done");
    const res = await changeset();
    expect(res.text).not.toContain("Old skeleton");
    expect(res.text).not.toContain("Skeleton markers remain");
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
    // #610 M1 — the pause is ENFORCED: v2's scope file carries the reshape.
    const scopeFile = path.join(root, ".deeppairing", "skeleton-scopes", `${v2.id}.json`);
    const written = JSON.parse(fs.readFileSync(scopeFile, "utf-8"));
    expect(written).toMatchObject({
      artifactId: v2.id,
      activeSkelIds: [],
      sessionId: store.getSessionId(),
      workspaceRoot: root,
      reshape: { fromId: id, restoreApproved: true, restoreSkelIds: [] },
    });
    expect(written.reshape.files).toContain("a.ts");
    const paused = await progress(v2.id, 0, "in_progress");
    expect(paused.text).toContain("reshaped skeleton awaiting re-review: fills are paused");
    expect(paused.text).toContain("the preflight hook asks before any edit to this plan's files");
    expect(paused.text).toContain("Skeleton fence NOT opened");
    // Progress on the draft never lifts the pause.
    expect(JSON.parse(fs.readFileSync(scopeFile, "utf-8")).reshape.fromId).toBe(id);
  });

  it("the restore record reflects v1: in-progress fences, and whether it was approved", async () => {
    const id = await presentApproved();
    await progress(id, 0, "in_progress");
    await callTool("revise_artifact", { artifactId: id, mode: "supersede", reason: "Skeleton change: x", content: { steps: STEPS, estimatedChanges: 1 } });
    const v2 = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    const r1 = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing", "skeleton-scopes", `${v2.id}.json`), "utf-8")).reshape;
    expect(r1).toMatchObject({ restoreApproved: true, restoreSkelIds: ["1"] });
    // A never-approved plan revised in review: nothing to restore.
    await callTool("present_plan", { title: "Draft skeleton", steps: STEPS, estimatedChanges: 1 });
    const d1 = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    await callTool("revise_artifact", { artifactId: d1.id, mode: "supersede", reason: "address comments", content: { steps: STEPS, estimatedChanges: 1 } });
    const d2 = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    expect(JSON.parse(fs.readFileSync(path.join(root, ".deeppairing", "skeleton-scopes", `${d2.id}.json`), "utf-8")).reshape.restoreApproved).toBe(false);
  });

  it("#611: v1's progress after a rejected reshape refreshes the restore, and v1 completing clears it", async () => {
    const id = await presentApproved();
    await progress(id, 0, "in_progress");
    await callTool("revise_artifact", { artifactId: id, mode: "supersede", reason: "Skeleton change: x", content: { steps: STEPS, estimatedChanges: 1 } });
    const v2 = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    store.updateArtifactStatus(v2.id, "rejected", "ui_reject_button");
    const scopeFile = path.join(root, ".deeppairing", "skeleton-scopes", `${v2.id}.json`);
    const read = () => JSON.parse(fs.readFileSync(scopeFile, "utf-8"));
    expect(read().reshape).toMatchObject({ fromId: id, restoreApproved: true, restoreSkelIds: ["1"] });
    // v1 resets its step: nothing in progress to restore.
    await progress(id, 0, "pending");
    expect(read().reshape).toMatchObject({ restoreApproved: true, restoreSkelIds: [] });
    // v1 resumes: the restore follows it.
    await progress(id, 0, "in_progress");
    expect(read().reshape).toMatchObject({ restoreApproved: true, restoreSkelIds: ["1"] });
    // v1 completes: the restore is cleared.
    fs.writeFileSync(path.join(root, "a.ts"), FILLED);
    await progress(id, 0, "done");
    expect(read().reshape).toMatchObject({ fromId: id, restoreApproved: false, restoreSkelIds: [] });
  });

  it("#611: superseding the same version again takes over the restore", async () => {
    const id = await presentApproved();
    await progress(id, 0, "in_progress");
    await callTool("revise_artifact", { artifactId: id, mode: "supersede", reason: "Skeleton change: x", content: { steps: STEPS, estimatedChanges: 1 } });
    const v2 = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    const v1 = store.getArtifacts().find((a) => a.id === id)!;
    writeReshapeScope({ sessionId: store.getSessionId(), oldPlan: { id, status: "approved", content: v1.content }, newId: "art_v3", newTitle: "v3", newContent: { steps: STEPS } });
    const dir = path.join(root, ".deeppairing", "skeleton-scopes");
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${v2.id}.json`), "utf-8")).reshape).toMatchObject({ restoreApproved: false, restoreSkelIds: [] });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "art_v3.json"), "utf-8")).reshape).toMatchObject({ fromId: id, restoreApproved: true, restoreSkelIds: ["1"] });
  });

  it("#608 (a): leaving in_progress without done posts a notice on the plan and warns the agent", async () => {
    const id = await presentApproved();
    await progress(id, 0, "in_progress");
    const res = await progress(id, 0, "pending");
    expect(res.text).toContain("Fence lifted without done: SKEL[1] (step 1, now pending)");
    const notice = store.getComments().find((c) => c.target.artifactId === id && c.author === "agent" && c.content.includes("Fence lifted"));
    expect(notice?.content).toContain("Fence lifted without completing the step: SKEL[1] (step 1, now pending)");
    // #610 L2 — skipped is a legitimate exit: no notice.
    await progress(id, 0, "in_progress");
    const skipped = await progress(id, 0, "skipped");
    expect(skipped.text).not.toContain("Fence lifted");
    expect(store.getComments().filter((c) => c.author === "agent" && c.content.includes("Fence lifted"))).toHaveLength(1);
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
