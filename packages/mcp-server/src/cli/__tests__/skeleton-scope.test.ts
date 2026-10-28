/**
 * Skeleton plans — the fence gate. While a `skelId` plan step is in_progress
 * (.deeppairing/skeleton-scopes/<artifactId>.json, written by update_plan_progress), an
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
  bodyEscapesFence,
  evaluateSkeletonEdit,
  readSkeletonScopes,
  scanSkeletonFences,
  selectSkeletonScope,
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
const scope = (ids: string[], at = NOW - 60_000, artifactId = "art_plan"): SkeletonScope => ({
  artifactId,
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

  it("#606 review: refuses a new_string that smuggles markers and a new function past the close marker", () => {
    // The reviewer's exact payload: the stub becomes a return, the ORIGINAL
    // close marker now closes an injected second SKEL[1] fence.
    const injected = 'return 2;\n  // /SKEL[1]\n}\nexport function injected() {\n  // SKEL[1] extra\n  return 9;';
    const v = run("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: injected });
    expect(v?.reason).toMatch(/adds, removes or retitles SKEL markers/);
  });

  it("refuses a fill that closes the enclosing function without touching markers", () => {
    const escape = "return raw;\n}\nexport function injected() {\n  return [];";
    // A formatted escape trips the indentation rule first; either rule refusing is the point.
    expect(run("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: escape })?.reason).toMatch(/indented outside|closes the block/);
    expect(run("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: "return raw; } export function injected() { return [];" })?.reason)
      .toMatch(/closes the block/);
  });

  it("allows a real multi-line fill with nested blocks, strings and comments", () => {
    const fill = [
      "const out: Point[] = [];",
      "  for (const p of raw) {",
      "    // skip near-duplicates (don't sqrt: compare squared distance)",
      "    if (out.length && dist2(out[out.length - 1], p) < 0.25) continue;",
      '    out.push({ ...p, label: "}{)(" });',
      "  }",
      "  return out;",
    ].join("\n");
    expect(run("Edit", { old_string: 'throw new Error("SKEL_TODO");', new_string: fill })).toBeNull();
  });

  it("applies MultiEdit sequentially and checks each edit against the text it lands in", () => {
    expect(run("MultiEdit", { edits: [
      { old_string: 'throw new Error("SKEL_TODO");', new_string: "const a = raw;\n  return a;" },
      { old_string: "const a = raw;", new_string: "const a = [...raw];" },
    ] })).toBeNull();
    expect(run("MultiEdit", { edits: [
      { old_string: 'throw new Error("SKEL_TODO");', new_string: "return raw;" },
      { old_string: "return raw;\n  // /SKEL[1]", new_string: "return raw;" },
    ] })).not.toBeNull();
  });

  it("a whole-file Write is held to the same result checks", () => {
    const smuggled = SRC.replace('throw new Error("SKEL_TODO");', "return raw;\n  // /SKEL[1]\n}\nfunction x() {\n  // SKEL[1] again");
    expect(run("Write", { content: smuggled })).not.toBeNull();
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

describe("bodyEscapesFence", () => {
  it("catches the Python shape: a dedent past the marker", () => {
    expect(bodyEscapesFence("    return 1\ndef injected():\n    return 9", "    # SKEL[1] x", "f.py")).toMatch(/indented outside/);
    expect(bodyEscapesFence("    if x:\n        return 1\n    return 2  # don't", "    # SKEL[1] x", "f.py")).toBeNull();
  });

  it("flags a bracket left open past the fence", () => {
    expect(bodyEscapesFence("  if (x) {", "  // SKEL[1] x", "a.ts")).toMatch(/left a bracket open|leaves a bracket open/);
  });
});

describe("selectSkeletonScope (#606 review: per-plan ownership)", () => {
  const a = { ...scope(["1"], NOW, "art_a"), sessionId: "s_a", workspaceRoot: "/proj" };
  const b = { ...scope(["9"], NOW, "art_b"), sessionId: "s_b", workspaceRoot: "/proj" };
  const wt = { ...scope(["5"], NOW, "art_wt"), sessionId: "s_a", workspaceRoot: "/proj-wt" };

  it("applies only the edit's own session's scopes", () => {
    expect(selectSkeletonScope([a, b], { sessionId: "s_a", targetAbs: "/proj/src/a.ts" })?.activeSkelIds).toEqual(["1"]);
    expect(selectSkeletonScope([a, b], { sessionId: "s_b", targetAbs: "/proj/src/a.ts" })?.activeSkelIds).toEqual(["9"]);
    expect(selectSkeletonScope([a, b], { sessionId: "s_other", targetAbs: "/proj/src/a.ts" })).toBeNull();
  });

  it("with no session on the event, fences with every live scope for that tree (more, never less)", () => {
    expect(selectSkeletonScope([a, b], { targetAbs: "/proj/src/a.ts" })?.activeSkelIds).toEqual(["1", "9"]);
  });

  it("a scope governs only files in its own working tree", () => {
    expect(selectSkeletonScope([a, wt], { sessionId: "s_a", targetAbs: "/proj-wt/src/a.ts" })?.activeSkelIds).toEqual(["5"]);
    expect(selectSkeletonScope([wt], { sessionId: "s_a", targetAbs: "/proj/src/a.ts" })).toBeNull();
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
    expect(readSkeletonScopes(root, NOW)).toEqual([]);
    expect(hook({ old_string: "import", new_string: "x" }).fire).toBe(false);
    writeSkeletonScope(root, scope([]));
    expect(fs.existsSync(path.join(root, ".deeppairing", "skeleton-scopes", "art_plan.json"))).toBe(false);
  });

  it("#606 review: plan B finishing never removes plan A's fence", () => {
    writeSkeletonScope(root, scope(["1"], NOW - 60_000, "art_a"));
    writeSkeletonScope(root, scope(["2"], NOW - 60_000, "art_b"));
    writeSkeletonScope(root, scope([], NOW - 60_000, "art_b")); // B marks its step done
    expect(readSkeletonScopes(root, NOW).map((s) => s.artifactId)).toEqual(["art_a"]);
    expect(hook({ old_string: "smooth(raw", new_string: "smoothed(raw" }).fire).toBe(true);
  });

  it("routes by the hook event's Claude session id, derived the way the server derives it", () => {
    writeSkeletonScope(root, { ...scope(["1"]), sessionId: "session_other_deadbeef_x" });
    const d = evaluatePreflightHook({
      toolName: "Edit", toolInput: { file_path: file, old_string: "smooth(raw", new_string: "smoothed(raw" },
      projectRoot: root, now: NOW, env: {}, sessionId: "11111111-2222-3333-4444-555555555555",
    });
    expect(d.fire).toBe(false); // another session's plan doesn't fence this one
  });

  it("scanSkeletonFences reports repo-relative fences and malformed files", () => {
    fs.writeFileSync(path.join(root, "src", "bad.ts"), "// SKEL[9] open\n");
    const { fences, errors } = scanSkeletonFences(root);
    expect(fences.map((f) => `${f.file}:${f.id}`)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
    expect(errors[0]).toMatch(/src\/bad\.ts:1: SKEL\[9\] is never closed/);
  });
});
