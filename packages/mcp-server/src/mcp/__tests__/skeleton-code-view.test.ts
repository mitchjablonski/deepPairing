/**
 * Skeleton plans, parity PR 2 — the skeleton AS CODE in the plan card.
 *
 * present_plan (and a revise_artifact supersede) of a plan with `skelId` steps
 * snapshots the fenced files, plus the file_map's unfenced "create" files,
 * into annotated_code visuals keyed by path. Real files in a temp project; no
 * mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanVisual } from "@deeppairing/shared";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { buildSkeletonSnapshot, SKELETON_SNAPSHOT_LIMITS, stripSkeletonVisuals } from "../skeleton-snapshot.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let root: string;
let outside: string;
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
const TYPES = "export interface Point {\n  x: number;\n  y: number;\n}\n";

const DIAGRAM = { id: "arch", kind: "diagram", title: "Shape", source: "graph TD; A-->B" };
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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skelview-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skelview-out-")));
  fs.writeFileSync(path.join(root, "a.ts"), SRC);
  fs.writeFileSync(path.join(root, "types.ts"), TYPES);
  prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
});
afterEach(() => {
  if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const latestPlan = () => store.getArtifacts().filter((a) => a.type === "plan").at(-1)!;
const visualsOf = (a: { content: unknown }) => ((a.content as { visuals?: PlanVisual[] }).visuals ?? []);

async function presentSkeleton(extra: Record<string, unknown> = {}) {
  const res = await callTool("present_plan", { title: "Smoothing skeleton", steps: STEPS, estimatedChanges: 2, visuals: [DIAGRAM, FILE_MAP], ...extra });
  return { res, plan: latestPlan() };
}

describe("skeleton code view — the snapshot on present_plan", () => {
  it("attaches the fenced file and the unfenced file_map 'create' file after the agent's visuals", async () => {
    const { res, plan } = await presentSkeleton();
    expect(res.isError).toBeFalsy();
    const visuals = visualsOf(plan);
    // Agent visuals first, untouched; snapshot visuals added after them.
    expect(visuals.map((v) => v.id)).toEqual(["arch", "fm", "skelcode:a.ts", "skelcode:types.ts"]);
    expect(visuals[0]).toEqual(DIAGRAM);

    const a = visuals[2]!;
    expect(a.kind).toBe("annotated_code");
    expect(a.filePath).toBe("a.ts");
    expect(a.lineStart).toBe(1);
    expect(a.code).toBe(SRC.replace(/\n$/, ""));
    expect(a.skeleton?.fences).toEqual([
      { id: "1", title: "drop duplicates", openLine: 2, closeLine: 4, status: "todo" },
      { id: "2", title: "connect the canvas", openLine: 8, closeLine: 10, status: "filled" },
    ]);
    expect(a.skeleton?.tracked).toBeUndefined();

    const t = visuals[3]!;
    expect(t.code).toBe(TYPES.replace(/\n$/, ""));
    expect(t.skeleton).toEqual({ fences: [], tracked: true });

    expect(res.text).toContain("Skeleton code view: attached 2 files to the plan card");
    // #606's own fence check still runs (from the same scan).
    expect(res.text).toContain("Skeleton check: 2 fences found on disk");
  });

  it("a plan without skelId steps is unchanged: the agent's visuals exactly, no snapshot, no note", async () => {
    const res = await callTool("present_plan", { title: "P", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1, visuals: [DIAGRAM, FILE_MAP] });
    const plan = latestPlan();
    expect(visualsOf(plan)).toEqual([DIAGRAM, { ...FILE_MAP }]);
    expect(res.text).not.toContain("Skeleton");
    const bare = await callTool("present_plan", { title: "Q", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1 });
    expect(bare.isError).toBeFalsy();
    expect((latestPlan().content as Record<string, unknown>).visuals).toBeUndefined();
  });

  it("an agent can't forge snapshot metadata: a supplied `skeleton` field never reaches the stored visual", async () => {
    const forged = { id: "mine", kind: "annotated_code", code: "x", filePath: "x.ts", skeleton: { fences: [{ id: "9", openLine: 1, closeLine: 1, status: "filled" }] } };
    await presentSkeleton({ visuals: [forged] });
    const mine = visualsOf(latestPlan()).find((v) => v.id === "mine")!;
    expect(mine.code).toBe("x");
    expect(mine.skeleton).toBeUndefined();
  });

  it("the store's secret scan covers the snapshot code (field path names the visual)", async () => {
    const token = ["gh", "p_", "Z".repeat(36)].join("");
    fs.writeFileSync(path.join(root, "a.ts"), SRC.replace("canvas.on", `const t = "${token}";\n  canvas.on`));
    const { plan } = await presentSkeleton();
    const warnings = plan.secretWarnings ?? [];
    expect(warnings.some((w) => w.pattern === "ghp_" && w.field === "visuals[2].code")).toBe(true);
    // Locations only — the value itself is never copied into the warning.
    expect(JSON.stringify(warnings)).not.toContain(token);
  });
});

describe("skeleton code view — bounds and confinement", () => {
  const snap = (visuals: unknown[], limits = SKELETON_SNAPSHOT_LIMITS) =>
    buildSkeletonSnapshot({ steps: STEPS, visuals, root, limits });

  it("caps the file count; the omitted files are named on the card and in the reply", () => {
    fs.writeFileSync(path.join(root, "b.ts"), "export const b = 1;\n");
    const out = snap([{ id: "fm", kind: "file_map", files: [{ path: "a.ts", change: "modify" }, { path: "types.ts", change: "create" }, { path: "b.ts", change: "create" }] }], { ...SKELETON_SNAPSHOT_LIMITS, maxFiles: 2 });
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts", "skelcode:types.ts"]);
    expect(out.visuals[1]!.caption).toContain("Not shown (snapshot cap): b.ts");
    expect(out.note).toContain("not shown (cap of 2 files");
  });

  it("truncates a file over the per-file cap at a line boundary, marked, with fences past the cut dropped", () => {
    const out = snap([], { ...SKELETON_SNAPSHOT_LIMITS, maxFileBytes: 120 });
    const a = out.visuals[0]!;
    expect(Buffer.byteLength(a.code!, "utf-8")).toBeLessThanOrEqual(120);
    expect(a.skeleton?.truncated).toEqual({ shownLines: a.code!.split("\n").length, totalLines: 11 });
    expect(a.skeleton?.fences.map((f) => f.id)).toEqual(["1"]);
    expect(a.caption).toMatch(/Truncated: lines 1–\d+ of 11 shown/);
    expect(out.note).toContain("truncated");
  });

  it("stops at the total byte cap", () => {
    const big = "// filler\n".repeat(80); // ~800 bytes
    fs.writeFileSync(path.join(root, "types.ts"), big);
    const out = snap([FILE_MAP], { ...SKELETON_SNAPSHOT_LIMITS, maxTotalBytes: Buffer.byteLength(SRC) + 100 });
    const total = out.visuals.reduce((n, v) => n + Buffer.byteLength(v.code ?? "", "utf-8"), 0);
    expect(total).toBeLessThanOrEqual(Buffer.byteLength(SRC) + 100);
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(out.note).toContain("types.ts");
  });

  it("never reads outside the project: '..', absolute paths and symlink escapes are skipped", () => {
    fs.writeFileSync(path.join(outside, "secret.ts"), "export const leaked = 1;\n");
    let linked = true;
    try {
      fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
    } catch {
      linked = false; // no symlink privilege on this runner
    }
    const out = snap([
      {
        id: "fm",
        kind: "file_map",
        files: [
          { path: "a.ts", change: "modify" },
          { path: "../" + path.basename(outside) + "/secret.ts", change: "create" },
          { path: path.join(outside, "secret.ts"), change: "create" },
          { path: "link.ts", change: "create" },
        ],
      },
    ]);
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(JSON.stringify(out.visuals)).not.toContain("leaked");
    expect(out.note).toContain("outside the project");
    if (linked) expect(out.note).toContain("link.ts (it resolves outside the project (symlink))");
  });

  it("skips binary files, secrets paths and deepPairing state", () => {
    fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=x\n");
    fs.mkdirSync(path.join(root, ".deeppairing"), { recursive: true });
    fs.writeFileSync(path.join(root, ".deeppairing", "daemon.json"), "{}");
    const out = snap([
      {
        id: "fm",
        kind: "file_map",
        files: [
          { path: "a.ts", change: "modify" },
          { path: "logo.png", change: "create" },
          { path: ".env", change: "create" },
          { path: ".deeppairing/daemon.json", change: "create" },
        ],
      },
    ]);
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(out.note).toContain("logo.png (binary");
    expect(out.note).toContain(".env (a secrets path");
    expect(out.note).toContain(".deeppairing/daemon.json (git/deepPairing state");
  });

  it("a tracked file the agent hasn't written yet is reported, not fatal", () => {
    const out = snap([{ id: "fm", kind: "file_map", files: [{ path: "a.ts", change: "modify" }, { path: "later.ts", change: "create" }] }]);
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(out.note).toContain("later.ts (not on disk)");
  });

  it("stripSkeletonVisuals drops snapshot visuals and forged metadata, keeps everything else", () => {
    expect(
      stripSkeletonVisuals([DIAGRAM, { id: "skelcode:a.ts", kind: "annotated_code" }, { id: "x", kind: "annotated_code", skeleton: {} }]),
    ).toEqual([DIAGRAM, { id: "x", kind: "annotated_code" }]);
  });
});

describe("skeleton code view — revise and feedback", () => {
  it("a supersede re-reads the files: the same per-path ids, fresh status, no duplicates", async () => {
    const { plan: v1 } = await presentSkeleton();
    // The agent fills fence 1 on disk, then revises, echoing v1's visuals back.
    fs.writeFileSync(path.join(root, "a.ts"), SRC.replace('throw new Error("SKEL_TODO");', "return [...new Set(raw)];"));
    const res = await callTool("revise_artifact", {
      artifactId: v1.id,
      mode: "supersede",
      reason: "fence 1 filled",
      content: { steps: STEPS, estimatedChanges: 2, visuals: visualsOf(v1) },
    });
    expect(res.isError).toBeFalsy();
    const v2 = latestPlan();
    expect(v2.id).not.toBe(v1.id);
    const ids = visualsOf(v2).map((v) => v.id);
    expect(ids).toEqual(["arch", "fm", "skelcode:a.ts", "skelcode:types.ts"]);
    const a = visualsOf(v2).find((v) => v.id === "skelcode:a.ts")!;
    expect(a.code).toContain("return [...new Set(raw)];");
    expect(a.skeleton?.fences.map((f) => f.status)).toEqual(["filled", "filled"]);
    expect(res.text).toContain("Skeleton code view: attached 2 files");
  });

  it("a line comment on the skeleton code reaches check_feedback with file, line and fence", async () => {
    const { plan } = await presentSkeleton();
    await store.addComment({
      id: "cmt_skel_in",
      artifactId: plan.id,
      content: "dedupe by distance, not equality",
      author: "human",
      target: { visualId: "skelcode:a.ts", filePath: "a.ts", lineStart: 3, lineEnd: 3 },
    } as any);
    await store.addComment({
      id: "cmt_skel_out",
      artifactId: plan.id,
      content: "rename this export",
      author: "human",
      target: { visualId: "skelcode:a.ts", filePath: "a.ts", lineStart: 1, lineEnd: 1 },
    } as any);
    const res = await callTool("check_feedback");
    expect(res.text).toContain("a.ts:3 (inside the SKEL[1] fence, step 1 — pending)");
    expect(res.text).toContain("dedupe by distance, not equality");
    expect(res.text).toContain("a.ts:1 (skeleton code, outside any fence — a structural line)");
    const sc = res.structuredContent as any;
    const entry = sc.comments.find((c: any) => c.id === "cmt_skel_in");
    expect(entry).toMatchObject({ filePath: "a.ts", lineStart: 3 });
  });

  it("an in_progress step's fence reads as active in the delivered anchor", async () => {
    const { plan } = await presentSkeleton();
    store.updateArtifactStatus(plan.id, "approved", "ui_approve_button");
    await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 1, status: "in_progress" }] });
    await store.addComment({
      id: "cmt_skel_active",
      artifactId: plan.id,
      content: "debounce this",
      author: "human",
      target: { visualId: "skelcode:a.ts", filePath: "a.ts", lineStart: 9, lineEnd: 9 },
    } as any);
    const res = await callTool("check_feedback");
    expect(res.text).toContain("a.ts:9 (inside the SKEL[2] fence, step 2 — active)");
  });

  it("an ordinary annotated_code line comment is delivered exactly as before", async () => {
    await callTool("present_plan", {
      title: "P",
      steps: [{ description: "s", reasoning: "r" }],
      estimatedChanges: 1,
      visuals: [{ id: "ac", kind: "annotated_code", code: "a\nb", filePath: "x.ts" }],
    });
    const plan = latestPlan();
    await store.addComment({
      id: "cmt_plain",
      artifactId: plan.id,
      content: "why b?",
      author: "human",
      target: { visualId: "ac", filePath: "x.ts", lineStart: 2, lineEnd: 2 },
    } as any);
    const res = await callTool("check_feedback");
    expect(res.text).toContain("x.ts:2");
    expect(res.text).not.toContain("SKEL[");
    expect(res.text).not.toContain("structural line");
  });
});
