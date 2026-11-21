/**
 * #686 P1b (warn mode) — exterior drift in the tool replies: an approved
 * skeleton plan's fenced files, minus the fence bodies, must still match the
 * approved `skelcode:` snapshot. update_plan_progress, present_changeset and
 * present_debrief warn; nothing is refused. Real files in a temp project.
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
const FILLED = SRC.replace('throw new Error("SKEL_TODO");', "const seen = new Set(raw);\n  return [...seen];");
const FINAL = "export function smooth(raw: number[]): number[] {\n  const seen = new Set(raw);\n  return [...seen];\n}\n";
const STEPS = [{ description: "dedupe", reasoning: "r", skelId: "1", files: ["a.ts"] }];

beforeEach(() => {
  store = ctx.store;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skeldrift-")));
  fs.writeFileSync(path.join(root, "a.ts"), SRC);
  prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
});
afterEach(() => {
  if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
  fs.rmSync(root, { recursive: true, force: true });
});

async function presentPlan(approve = true) {
  await callTool("present_plan", { title: "Smoothing skeleton", steps: STEPS, estimatedChanges: 1 });
  const plan = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
  if (approve) store.updateArtifactStatus(plan.id, "approved", "ui_approve_button");
  return plan.id;
}
const progress = (artifactId: string, stepIndex: number, status: string) =>
  callTool("update_plan_progress", { artifactId, updates: [{ stepIndex, status }] });
const changeset = () =>
  callTool("present_changeset", {
    title: "Stroke smoothing",
    files: [{ path: "a.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 2 }] }] }],
  });
const write = (text: string) => fs.writeFileSync(path.join(root, "a.ts"), text);

describe("exterior drift — update_plan_progress", () => {
  it("a fill inside the fence is quiet", async () => {
    const id = await presentPlan();
    await progress(id, 0, "in_progress");
    write(FILLED);
    const res = await progress(id, 0, "done");
    expect(res.isError).toBeFalsy();
    expect(res.text).not.toContain("Exterior drift");
  });

  it("an edit outside the fence warns with the file and line, and the progress is still recorded", async () => {
    const id = await presentPlan();
    await progress(id, 0, "in_progress");
    write(FILLED.replace("raw: number[]): number[]", "raw: number[], limit = 10): number[]"));
    const res = await progress(id, 0, "done");
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("Plan progress recorded: 1/1");
    expect(res.text).toContain("⚠ Exterior drift since approval: a.ts line 1.");
    expect(res.text).toContain("skeleton changes");
    expect((store.getArtifacts().find((a) => a.id === id)!.content as { steps: Array<{ status: string }> }).steps[0]!.status).toBe("done");
  });

  it("a deleted declared file is named", async () => {
    const id = await presentPlan();
    fs.rmSync(path.join(root, "a.ts"));
    const res = await progress(id, 0, "in_progress");
    expect(res.text).toContain("Exterior drift since approval: a.ts (deleted)");
  });

  it("an unapproved plan is not checked", async () => {
    const id = await presentPlan(false);
    write(`// new header\n${SRC}`);
    const res = await progress(id, 0, "in_progress");
    expect(res.text).not.toContain("Exterior drift");
  });
});

describe("exterior drift — a version restored after a rejected reshape (#611)", () => {
  it("v1 keeps being checked: progress on v1 and present_changeset both warn", async () => {
    const id = await presentPlan();
    await progress(id, 0, "in_progress");
    await callTool("revise_artifact", { artifactId: id, mode: "supersede", reason: "Skeleton change: x", content: { steps: STEPS, estimatedChanges: 1 } });
    const v2 = store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
    store.updateArtifactStatus(v2.id, "rejected", "ui_reject_button");
    expect(store.getArtifacts().find((a) => a.id === id)!.status).toBe("superseded");
    write(`${FILLED}export const extra = 1;\n`);
    const res = await progress(id, 0, "done");
    expect(res.text).toContain("Exterior drift since approval: a.ts line 7.");
    write(`${FINAL}export const extra = 1;\n`);
    const cs = await changeset();
    expect(cs.text).toContain("Exterior drift since approval: a.ts (markers stripped");
  });
});

describe("exterior drift — finalize notes", () => {
  it("present_changeset and present_debrief warn on drift once the markers are stripped", async () => {
    const id = await presentPlan();
    await progress(id, 0, "in_progress");
    write(FILLED);
    await progress(id, 0, "done");
    write(FINAL.replace("export function smooth", "export async function smooth"));
    const cs = await changeset();
    expect(cs.text).not.toContain("Skeleton markers remain");
    expect(cs.text).toContain("⚠ Exterior drift since approval: a.ts (markers stripped; the approved structure no longer matches near line 1)");
    const debrief = await callTool("present_debrief", { title: "Smoothing", summary: "Done." });
    expect(debrief.text).toContain("Exterior drift since approval");
  });

  it("a clean finalize (fills only, markers stripped) is quiet", async () => {
    const id = await presentPlan();
    await progress(id, 0, "in_progress");
    write(FILLED);
    await progress(id, 0, "done");
    write(FINAL);
    const cs = await changeset();
    expect(cs.text).not.toContain("Exterior drift");
    expect(cs.text).not.toContain("Skeleton markers remain");
  });

  it("names not-checked files at finalize even without drift, but not in progress replies", async () => {
    const token = ["gh", "p_", "Q".repeat(36)].join("");
    write(`const k = "${token}";\n${SRC}`);
    const id = await presentPlan();
    await progress(id, 0, "in_progress");
    write(`const k = "${token}";\n${FILLED}`);
    const done = await progress(id, 0, "done");
    expect(done.text).not.toContain("Exterior drift");
    write(`const k = "${token}";\n${FINAL}`);
    const cs = await changeset();
    expect(cs.text).not.toContain("Exterior drift since approval");
    expect(cs.text).toContain("Exterior drift not checked for: a.ts (markers stripped; withheld from the approved snapshot, so only a digest was kept)");
    expect(cs.text).not.toContain(token);
  });

  it("drift is reported alongside leftover markers", async () => {
    const id = await presentPlan();
    await progress(id, 0, "in_progress");
    write(`${FILLED}export const extra = 1;\n`);
    await progress(id, 0, "done");
    const cs = await changeset();
    expect(cs.text).toContain("Skeleton markers remain");
    expect(cs.text).toContain("Exterior drift since approval: a.ts line 7.");
  });
});
