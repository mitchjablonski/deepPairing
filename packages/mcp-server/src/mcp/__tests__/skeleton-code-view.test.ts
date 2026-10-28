/**
 * Skeleton plans, parity PR 2 — the skeleton AS CODE in the plan card.
 *
 * present_plan (and an ordinary revise_artifact supersede) of a plan with
 * `skelId` steps snapshots the FENCED files into annotated_code visuals keyed
 * by path; unfenced file_map "create" entries are listed by path only. Real
 * files in a temp project; no mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Artifact, PlanVisual } from "@deeppairing/shared";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import {
  buildSkeletonSnapshot,
  isDeniedPath,
  SKELETON_SNAPSHOT_LIMITS,
  stripForgedSkeleton,
  stripSkeletonVisuals,
  UNFENCED_VISUAL_ID,
} from "../skeleton-snapshot.js";
import { deriveReviseContent, finalizeReviseContent, reviseSnapshot } from "../proposal-resolution.js";

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
/** A file that WOULD qualify (it holds a claimed fence) — used to prove the
 *  denylist and confinement, not the allowlist, keep it out. */
const FENCED_LEAK = '// LEAK-MARKER\n// SKEL[1] x\nthrow new Error("SKEL_TODO");\n// /SKEL[1]\n';

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

const latestOf = (type: string) => store.getArtifacts().filter((a) => a.type === type).at(-1)!;
const latestPlan = () => latestOf("plan");
const visualsOf = (a: { content: unknown }) => ((a.content as { visuals?: PlanVisual[] }).visuals ?? []);
const write = (rel: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const trySymlink = (target: string, rel: string): boolean => {
  try {
    fs.symlinkSync(target, path.join(root, rel));
    return true;
  } catch {
    return false; // no symlink privilege on this runner
  }
};

async function presentSkeleton(extra: Record<string, unknown> = {}) {
  const res = await callTool("present_plan", { title: "Smoothing skeleton", steps: STEPS, estimatedChanges: 2, visuals: [DIAGRAM, FILE_MAP], ...extra });
  return { res, plan: latestPlan() };
}

describe("skeleton code view — the snapshot on present_plan", () => {
  it("attaches the fenced file as code and lists the unfenced 'create' file by path only", async () => {
    const { res, plan } = await presentSkeleton();
    expect(res.isError).toBeFalsy();
    const visuals = visualsOf(plan);
    // Agent visuals first, untouched; snapshot visuals added after them.
    expect(visuals.map((v) => v.id)).toEqual(["arch", "fm", "skelcode:a.ts", UNFENCED_VISUAL_ID]);
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

    // H1 — the unfenced file: its path, never its content.
    const u = visuals[3]!;
    expect(u.kind).toBe("file_map");
    expect(u.files).toEqual([{ path: "types.ts", change: "create", note: "no fence, content not shown" }]);
    expect(u.code).toBeUndefined();
    expect(JSON.stringify(plan.content)).not.toContain("interface Point");

    expect(res.text).toContain("Skeleton code view: attached 1 fenced file to the plan card");
    expect(res.text).toContain("listed 1 unfenced file by path only");
    // #606's own fence check still runs (from the same scan).
    expect(res.text).toContain("Skeleton check: 2 fences found on disk");
  });

  it("a plan without skelId steps is unchanged: the agent's visuals exactly, no snapshot, no note", async () => {
    const res = await callTool("present_plan", { title: "P", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1, visuals: [DIAGRAM, FILE_MAP] });
    expect(visualsOf(latestPlan())).toEqual([DIAGRAM, { ...FILE_MAP }]);
    expect(res.text).not.toContain("Skeleton");
    const bare = await callTool("present_plan", { title: "Q", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1 });
    expect(bare.isError).toBeFalsy();
    expect((latestPlan().content as Record<string, unknown>).visuals).toBeUndefined();
  });

  it("M2 present_plan: a supplied `skeleton` field and a forged skelcode: visual never reach the store", async () => {
    const forgedMeta = { id: "mine", kind: "annotated_code", code: "x", filePath: "x.ts", skeleton: { fences: [{ id: "9", openLine: 1, closeLine: 1, status: "filled" }] } };
    const forgedVisual = { id: "skelcode:a.ts", kind: "annotated_code", code: "FORGED-CODE", filePath: "a.ts" };
    await presentSkeleton({ visuals: [forgedMeta, forgedVisual] });
    const visuals = visualsOf(latestPlan());
    expect(visuals.find((v) => v.id === "mine")!.skeleton).toBeUndefined();
    expect(visuals.filter((v) => v.id === "skelcode:a.ts")).toHaveLength(1);
    expect(JSON.stringify(visuals)).not.toContain("FORGED-CODE");
    // Even a non-skeleton plan can't carry one.
    await callTool("present_plan", { title: "P", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1, visuals: [forgedMeta, forgedVisual] });
    expect(JSON.stringify(visualsOf(latestPlan()))).not.toMatch(/FORGED-CODE|"skeleton"/);
  });

  it("M1: a secret-shaped value withholds the WHOLE file — never stored, broadcast or exported", async () => {
    const token = ["gh", "p_", "Z".repeat(36)].join("");
    fs.writeFileSync(path.join(root, "a.ts"), SRC.replace("canvas.on", `const t = "${token}";\n  canvas.on`));
    const { res, plan } = await presentSkeleton();
    const a = visualsOf(plan).find((v) => v.id === "skelcode:a.ts")!;
    expect(a.code).toBeUndefined();
    expect(a.skeleton?.withheld).toContain("possible secret detected");
    expect(a.caption).toContain("Content withheld: possible secret detected");
    expect(JSON.stringify(plan)).not.toContain(token);
    expect(JSON.stringify(plan)).not.toContain("canvas.on");
    expect(plan.secretWarnings ?? []).toEqual([]);
    expect(res.text).toContain("content withheld (possible secret detected): a.ts");
    expect(res.text).not.toContain(token);
    for (const format of ["full", "pr-comments"]) {
      const exported = await callTool("export_session", { format });
      expect(exported.text).not.toContain(token);
    }
  });
});

describe("skeleton code view — allowlist, denylist and confinement (H1)", () => {
  const snap = (visuals: unknown[], limits = SKELETON_SNAPSHOT_LIMITS) =>
    buildSkeletonSnapshot({ steps: STEPS, visuals, root, limits });
  const declare = (...paths: string[]) => ({ id: "fm", kind: "file_map", files: paths.map((p) => ({ path: p, change: "modify" })) });

  it("never snapshots protected files, even when they hold a claimed fence", () => {
    write(".env", FENCED_LEAK);
    write(".ENV", FENCED_LEAK);
    write("examples/.env", FENCED_LEAK);
    write(".GIT/config", FENCED_LEAK);
    write(".npmrc", FENCED_LEAK);
    write("id_rsa", FENCED_LEAK);
    write(".ssh/notes.ts", FENCED_LEAK);
    write("credentials.json", FENCED_LEAK);
    write(".deeppairing/x.ts", FENCED_LEAK);
    write("server.pem", FENCED_LEAK);
    const out = snap([declare("a.ts", ".env", ".ENV", "examples/.env", ".GIT/config", ".npmrc", "id_rsa", ".ssh/notes.ts", "credentials.json", ".deeppairing/x.ts", "server.pem")]);
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(JSON.stringify(out.visuals)).not.toContain("LEAK-MARKER");
    for (const p of [".env", ".ENV", "examples/.env", ".GIT/config", ".npmrc", "id_rsa"]) {
      expect(out.note).toContain(`${p} (a protected path`);
    }
  });

  it("an in-root symlink to .env is judged by its REAL path", () => {
    write(".env", FENCED_LEAK);
    const linked = trySymlink(path.join(root, ".env"), "cfg.ts");
    const out = snap([declare("a.ts", "cfg.ts")]);
    expect(JSON.stringify(out.visuals)).not.toContain("LEAK-MARKER");
    if (linked) expect(out.note).toContain("cfg.ts (a protected path");
  });

  it("a symlink escaping the root, '..' and absolute paths are never read", () => {
    fs.writeFileSync(path.join(outside, "x.ts"), FENCED_LEAK);
    const linked = trySymlink(path.join(outside, "x.ts"), "esc.ts");
    const out = snap([
      declare("a.ts", "esc.ts", `../${path.basename(outside)}/x.ts`, path.join(outside, "x.ts")),
      { id: "fm2", kind: "file_map", files: [{ path: `../${path.basename(outside)}/y.ts`, change: "create" }] },
    ]);
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(JSON.stringify(out.visuals)).not.toContain("LEAK-MARKER");
    expect(out.note).toContain("outside the project");
    if (linked) expect(out.note).toContain("esc.ts (it resolves outside the project (symlink))");
  });

  it("an unfenced 'create' entry is listed by path only — never opened, even if it exists", () => {
    write("later.ts", "LEAK-MARKER unfenced content\n");
    const out = snap([{ id: "fm", kind: "file_map", files: [{ path: "a.ts", change: "modify" }, { path: "later.ts", change: "create" }, { path: "not-yet.ts", change: "create" }] }]);
    const unfenced = out.visuals.find((v) => v.id === UNFENCED_VISUAL_ID)!;
    expect(unfenced.files!.map((f) => f.path)).toEqual(["later.ts", "not-yet.ts"]);
    expect(JSON.stringify(out.visuals)).not.toContain("LEAK-MARKER");
  });

  it("a declared file without a claimed fence is not snapshotted (the allowlist)", () => {
    write("other.ts", "// SKEL[99] someone else's\nthrow new Error(\"SKEL_TODO\");\n// /SKEL[99]\n");
    const out = snap([declare("a.ts", "other.ts")]);
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
  });

  it("skips binary files", () => {
    write("bin.ts", Buffer.concat([Buffer.from([0x89, 0x00, 0x0a]), Buffer.from(FENCED_LEAK)]));
    const out = snap([declare("a.ts", "bin.ts")]);
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(out.note).toContain("bin.ts (binary");
  });

  it("isDeniedPath is case-insensitive on every segment", () => {
    for (const p of [".env.local", "a/.Env", "x/.SSH/k", ".DeepPairing/s.json", "k/ID_RSA.pub", "id_ed25519", ".NETRC", ".pypirc", "Credentials.yml", "c.KEY", "c.P12"]) {
      expect(isDeniedPath(p)).toBe(true);
    }
    for (const p of ["src/a.ts", "env.ts", "docs/keys.md", "src/git.ts"]) expect(isDeniedPath(p)).toBe(false);
  });
});

describe("skeleton code view — bounds", () => {
  const snap = (visuals: unknown[], limits = SKELETON_SNAPSHOT_LIMITS) =>
    buildSkeletonSnapshot({ steps: STEPS, visuals, root, limits });
  const fencedB = (filler = "") => `export function b() {\n${filler}  // SKEL[2] b\n  return 2;\n  // /SKEL[2]\n}\n`;

  it("caps the file count; the omitted files are named on the card and in the reply", () => {
    write("b.ts", fencedB());
    const out = snap([{ id: "fm", kind: "file_map", files: [{ path: "a.ts", change: "modify" }, { path: "b.ts", change: "modify" }] }], { ...SKELETON_SNAPSHOT_LIMITS, maxFiles: 1 });
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(out.visuals[0]!.caption).toContain("Not shown (snapshot cap): b.ts");
    expect(out.note).toContain("not shown (cap of 1 files");
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

  it("L3: once the total byte budget is spent, later files are omitted without being read", () => {
    write("b.ts", fencedB("  // filler\n".repeat(80)));
    const out = snap(
      [{ id: "fm", kind: "file_map", files: [{ path: "a.ts", change: "modify" }, { path: "b.ts", change: "modify" }] }],
      { ...SKELETON_SNAPSHOT_LIMITS, maxTotalBytes: Buffer.byteLength(SRC) + 100 },
    );
    expect(out.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
    expect(out.note).toContain("not shown");
    expect(out.note).toContain("b.ts");
  });

  it("stripSkeletonVisuals drops snapshot visuals and forged metadata, keeps everything else", () => {
    expect(
      stripSkeletonVisuals([DIAGRAM, { id: "skelcode:a.ts", kind: "annotated_code" }, { id: "x", kind: "annotated_code", skeleton: {} }]),
    ).toEqual([DIAGRAM, { id: "x", kind: "annotated_code" }]);
  });
});

describe("skeleton code view — revise paths (M2) and feedback", () => {
  it("an ordinary supersede re-reads the files: the same per-path ids, fresh status, no duplicates", async () => {
    const { plan: v1 } = await presentSkeleton();
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
    expect(visualsOf(v2).map((v) => v.id)).toEqual(["arch", "fm", "skelcode:a.ts", UNFENCED_VISUAL_ID]);
    const a = visualsOf(v2).find((v) => v.id === "skelcode:a.ts")!;
    expect(a.code).toContain("return [...new Set(raw)];");
    expect(a.skeleton?.fences.map((f) => f.status)).toEqual(["filled", "filled"]);
    expect(res.text).toContain("Skeleton code view: attached 1 fenced file");
  });

  it("a supersede of a NON-plan artifact strips forged skeleton metadata too", async () => {
    await callTool("present_findings", {
      title: "Research",
      summary: "s",
      findings: [{ category: "c", detail: "d", significance: "low" }],
    });
    const v1 = latestOf("research");
    const res = await callTool("revise_artifact", {
      artifactId: v1.id,
      mode: "supersede",
      reason: "add code",
      content: {
        summary: "s2",
        findings: [{ category: "c", detail: "d", significance: "low" }],
        visuals: [
          { id: "skelcode:a.ts", kind: "annotated_code", code: "FORGED-CODE", filePath: "a.ts", skeleton: { fences: [] } },
          { id: "mine", kind: "annotated_code", code: "ok", filePath: "m.ts", skeleton: { fences: [{ id: "1", openLine: 1, closeLine: 1, status: "filled" }] } },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const v2 = latestOf("research");
    expect(v2.id).not.toBe(v1.id);
    expect(visualsOf(v2).map((v) => v.id)).toEqual(["mine"]);
    expect(JSON.stringify(v2.content)).not.toMatch(/FORGED-CODE|"skeleton"/);
  });

  it("the stance-admission snapshot (digest-bound) carries no agent skeleton metadata, for plans and decisions", () => {
    const plan = { id: "art_p", type: "plan", title: "P", version: 1, status: "draft", content: { steps: STEPS, estimatedChanges: 1 } } as unknown as Artifact;
    const supplied = {
      steps: STEPS,
      estimatedChanges: 1,
      visuals: [DIAGRAM, { id: "skelcode:a.ts", kind: "annotated_code", code: "FORGED-CODE" }, { id: "m", kind: "annotated_code", code: "ok", skeleton: { fences: [] } }],
    };
    const content = finalizeReviseContent(plan, structuredClone(deriveReviseContent(plan, supplied)));
    const snapshot = reviseSnapshot(plan, "P", "why", content);
    expect(JSON.stringify(snapshot)).not.toMatch(/FORGED-CODE|"skeleton"|skelcode:/);
    // Deterministic: the same call yields the same snapshot (the digest holds).
    const again = reviseSnapshot(plan, "P", "why", finalizeReviseContent(plan, structuredClone(deriveReviseContent(plan, supplied))));
    expect(JSON.stringify(again)).toBe(JSON.stringify(snapshot));

    const decision = { id: "art_d", type: "decision", title: "D", version: 1, status: "draft", content: { context: "c", options: [] } } as unknown as Artifact;
    const dContent = deriveReviseContent(decision, {
      context: "c",
      options: [{ id: "o1", title: "A", visuals: [{ id: "v", kind: "annotated_code", code: "ok", skeleton: { fences: [] } }] }],
    });
    expect(JSON.stringify(dContent)).not.toContain('"skeleton"');
  });

  it("stripForgedSkeleton returns the same object when there is nothing to strip", () => {
    const c = { summary: "s", visuals: [DIAGRAM] };
    expect(stripForgedSkeleton(c)).toBe(c);
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
