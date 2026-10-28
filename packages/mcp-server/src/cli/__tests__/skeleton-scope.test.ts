/**
 * Skeleton plans — the fence gate. While a `skelId` plan step is in_progress
 * (.deeppairing/skeleton-scope.json, written by update_plan_progress), an
 * Edit/Write/MultiEdit that touches code outside that step's SKEL fence asks
 * the human: it's a skeleton change. Pure evaluator first, then through
 * evaluatePreflightHook against a real temp project.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SKELETON_SCOPE_MAX_AGE_MS,
  evaluateSkeletonEdit,
  readSkeletonScope,
  scanSkeletonFences,
  scanSkeletonText,
  writeSkeletonScope,
  type SkeletonScope,
} from "../../skeleton-scope.js";
import { evaluatePreflightHook, hookGateRecord, skeletonScopeActive } from "../preflight-hook-core.js";

const SRC = `import { Point } from "./types";

export function smooth(raw: Point[]): Point[] {
  // SKEL[1] drop near-duplicate points
  throw new Error("SKEL_TODO");
  // /SKEL[1]
}

export function interpolate(a: Point, b: Point): Point[] {
  // SKEL[2] catmull-rom between a and b
  throw new Error("SKEL_TODO");
  // /SKEL[2]
}
`;

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const scope = (ids: string[], at = NOW - 60_000): SkeletonScope => ({
  artifactId: "art_plan",
  planTitle: "Stroke smoothing",
  activeSkelIds: ids,
  updatedAt: new Date(at).toISOString(),
});

describe("scanSkeletonText", () => {
  it("finds fences with lines, titles and status, across comment styles", () => {
    expect(scanSkeletonText(SRC, "a.ts").map(({ id, title, openLine, closeLine, status }) => ({ id, title, openLine, closeLine, status }))).toEqual([
      { id: "1", title: "drop near-duplicate points", openLine: 4, closeLine: 6, status: "todo" },
      { id: "2", title: "catmull-rom between a and b", openLine: 10, closeLine: 12, status: "todo" },
    ]);
    expect(scanSkeletonText("def f():\n    # SKEL[a.1] x\n    return 1\n    # /SKEL[a.1]\n", "f.py")[0]).toMatchObject({ id: "a.1", status: "filled" });
    expect(scanSkeletonText("<!-- SKEL[3] markup -->\n<p/>\n<!-- /SKEL[3] -->\n", "x.html")[0]).toMatchObject({ id: "3", title: "markup" });
  });

  it("throws on unclosed, mismatched and nested fences", () => {
    expect(() => scanSkeletonText("// SKEL[1] x\n", "a")).toThrow(/never closed/);
    expect(() => scanSkeletonText("// SKEL[1] x\n// /SKEL[2]\n", "a")).toThrow(/closes SKEL\[1\]/);
    expect(() => scanSkeletonText("// SKEL[1] x\n// SKEL[2] y\n", "a")).toThrow(/opened inside/);
  });
});

describe("evaluateSkeletonEdit (pure)", () => {
  const root = "/proj";
  const file = "/proj/src/a.ts";
  const run = (toolName: string, toolInput: Record<string, unknown>, ids = ["1"], text: string | null = SRC) =>
    evaluateSkeletonEdit({ toolName, toolInput: { file_path: file, ...toolInput }, projectRoot: root, scope: scope(ids), readFile: (abs) => (abs === file ? text : null) });

  it("has no opinion with no scope, or for non-edit tools", () => {
    expect(evaluateSkeletonEdit({ toolName: "Edit", toolInput: { file_path: file, old_string: "import" }, projectRoot: root, scope: null, readFile: () => SRC })).toBeNull();
    expect(run("Read", {})).toBeNull();
  });

  it("allows replacing the stub inside the active fence", () => {
    expect(run("Edit", { old_string: '  throw new Error("SKEL_TODO");\n', new_string: "  return raw;\n" })).toBeNull();
  });

  it("asks for a signature change, a marker edit, another step's fence, an unfenced file, and a new file", () => {
    expect(run("Edit", { old_string: "smooth(raw: Point[])", new_string: "smooth(raw: Point[], k: number)" })?.reason).toMatch(/src\/a\.ts:3/);
    expect(run("Edit", { old_string: "  // SKEL[1] drop near-duplicate points\n", new_string: "" })).not.toBeNull();
    // The first SKEL_TODO occurrence is step 1's, so with only step 2 active it is out of scope.
    expect(run("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: "x" }, ["2"])).not.toBeNull();
    expect(run("Edit", { old_string: "const", new_string: "let" }, ["1"], "const x = 1;\n")?.reason).toMatch(/no step SKEL\[1\] fence/);
    expect(run("Write", { content: "new" }, ["1"], null)?.reason).toMatch(/creates a new file/);
  });

  it("checks every replace_all occurrence and every MultiEdit edit", () => {
    expect(run("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: "x", replace_all: true })).not.toBeNull();
    expect(run("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: "x", replace_all: true }, ["1", "2"])).toBeNull();
    expect(run("MultiEdit", { edits: [
      { old_string: 'throw new Error("SKEL_TODO");', new_string: "return raw;" },
      { old_string: "interpolate(a: Point", new_string: "lerp(a: Point" },
    ] })).not.toBeNull();
  });

  it("allows a whole-file Write that only changes the active fence body", () => {
    const filled = SRC.replace('throw new Error("SKEL_TODO");', "return raw.filter(Boolean);");
    expect(run("Write", { content: filled })).toBeNull();
    expect(run("Write", { content: filled.replace("export function interpolate", "export async function interpolate") })).not.toBeNull();
  });

  it("leaves deepPairing's own state to its own class", () => {
    expect(evaluateSkeletonEdit({ toolName: "Write", toolInput: { file_path: "/proj/.deeppairing/x.json", content: "{}" }, projectRoot: root, scope: scope(["1"]), readFile: () => null })).toBeNull();
  });

  it("speaks to the human first and carries a greppable agent line", () => {
    const v = run("Edit", { old_string: "import", new_string: "x" })!;
    expect(v.reason.startsWith("Allow this edit outside the skeleton?")).toBe(true);
    expect(v.reason).toContain("[SKELETON_SCOPE");
    expect(v.reason).toContain('"Stroke smoothing"');
  });
});

describe("through evaluatePreflightHook", () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skel-")));
    fs.mkdirSync(path.join(root, "src"));
    file = path.join(root, "src", "a.ts");
    fs.writeFileSync(file, SRC);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const hook = (toolInput: Record<string, unknown>, toolName = "Edit") =>
    evaluatePreflightHook({ toolName, toolInput: { file_path: file, ...toolInput }, projectRoot: root, now: NOW, env: {} });

  it("is silent with no scope file — fills the fast path, too", () => {
    expect(skeletonScopeActive(root, NOW)).toBe(false);
    expect(hook({ old_string: "import", new_string: "x" }).fire).toBe(false);
  });

  it("fires on an out-of-fence edit while a step is in progress, and passes the fill", () => {
    writeSkeletonScope(root, scope(["1"]));
    expect(skeletonScopeActive(root, NOW)).toBe(true);
    const d = hook({ old_string: "smooth(raw", new_string: "smoothed(raw" });
    expect(d).toMatchObject({ fire: true, source: "skeleton", skeleton: { skelIds: ["1"] }, toolName: "Edit", target: "src/a.ts" });
    expect(hook({ old_string: '  throw new Error("SKEL_TODO");\n', new_string: "  return raw;\n" }).fire).toBe(false);
  });

  it("fires on a pure deletion outside the fence (no proposal strings)", () => {
    writeSkeletonScope(root, scope(["1"]));
    expect(hook({ old_string: 'import { Point } from "./types";\n', new_string: "" }).fire).toBe(true);
  });

  it("logs a fence fire as its own guardrail class for the companion", () => {
    writeSkeletonScope(root, scope(["2"]));
    const rec = hookGateRecord(hook({ old_string: "import", new_string: "x" }));
    expect(rec).toMatchObject({ source: "guardrail", guardrail: "skeleton-scope", concept: "Skeleton fence SKEL[2]", target: "src/a.ts" });
  });

  it("ignores a stale scope and removes the file when nothing is in progress", () => {
    writeSkeletonScope(root, scope(["1"], NOW - SKELETON_SCOPE_MAX_AGE_MS - 1));
    expect(readSkeletonScope(root, NOW)).toBeNull();
    expect(hook({ old_string: "import", new_string: "x" }).fire).toBe(false);
    writeSkeletonScope(root, scope([]));
    expect(fs.existsSync(path.join(root, ".deeppairing", "skeleton-scope.json"))).toBe(false);
  });

  it("scanSkeletonFences reports repo-relative fences and malformed files", () => {
    fs.writeFileSync(path.join(root, "src", "bad.ts"), "// SKEL[9] open\n");
    const { fences, errors } = scanSkeletonFences(root);
    expect(fences.map((f) => `${f.file}:${f.id}`)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
    expect(errors[0]).toMatch(/src\/bad\.ts:1: SKEL\[9\] is never closed/);
  });
});
