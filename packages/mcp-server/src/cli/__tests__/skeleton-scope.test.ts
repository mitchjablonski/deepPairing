/**
 * Skeleton plans — the fence gate. While an APPROVED plan's `skelId` step is
 * in_progress (.deeppairing/skeleton-scopes/<artifactId>.json, written by
 * update_plan_progress), an Edit/Write/MultiEdit from that plan's own session
 * whose RESULT changes code outside the step's SKEL fence asks the human: it's
 * a skeleton change. Pure evaluator, then evaluatePreflightHook against a real
 * temp project, then both real hook emitters spawned (#606 review M6).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SKELETON_SCOPE_MAX_AGE_MS,
  bodyEscapesFence,
  evaluateSkeletonEdit,
  planDeclaredFiles,
  readSkeletonScopes,
  refreshReshapeRestores,
  scanSkeletonFences,
  scanSkeletonText,
  selectSkeletonScope,
  writeSkeletonScope,
  type SkeletonScope,
} from "../../skeleton-scope.js";
import { deriveSessionId } from "../../session-id.js";
import { GUARDRAIL_BACKSTOP_ENV, evaluatePreflightHook, hookGateRecord, skeletonScopeActive } from "../preflight-hook-core.js";
import { ensurePreflightHook } from "../setup-tasks.js";

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
const STUB = 'throw new Error("SKEL_TODO");';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const scope = (ids: string[], over: Partial<SkeletonScope> = {}): SkeletonScope => ({
  artifactId: "art_plan",
  planTitle: "Stroke smoothing",
  activeSkelIds: ids,
  updatedAt: new Date(NOW - 60_000).toISOString(),
  ...over,
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
  const run = (toolName: string, toolInput: Record<string, unknown>, ids = ["1"], text: string | null = SRC, strict = false) =>
    evaluateSkeletonEdit({ toolName, toolInput: { file_path: file, ...toolInput }, projectRoot: root, scope: scope(ids), strict, readFile: (abs) => (abs === file ? text : null) });

  it("has no opinion with no scope, or for non-edit tools", () => {
    expect(evaluateSkeletonEdit({ toolName: "Edit", toolInput: { file_path: file, old_string: "import" }, projectRoot: root, scope: null, readFile: () => SRC })).toBeNull();
    expect(run("Read", {})).toBeNull();
  });

  it("allows replacing the stub inside the active fence", () => {
    expect(run("Edit", { old_string: STUB, new_string: "return raw;" })).toBeNull();
  });

  it("#606 H1: allows the realistic unique old_string that includes the fence's own marker line", () => {
    // Two fences share an identical stub, so Edit needs the SKEL[2] marker to be unique.
    const anchored = `  // SKEL[2] catmull-rom between a and b\n  ${STUB}`;
    expect(run("Edit", { old_string: anchored, new_string: "  // SKEL[2] catmull-rom between a and b\n  return [a, b];" }, ["2"])).toBeNull();
    // …but the marker line itself must survive intact: no suffix, no retitle.
    expect(run("Edit", { old_string: anchored, new_string: "  // SKEL[2] catmull-rom between a and b; export const leak = 1;\n  return [a, b];" }, ["2"]))
      .not.toBeNull();
    const closing = `  ${STUB}\n  // /SKEL[2]`;
    expect(run("Edit", { old_string: closing, new_string: "  return [a, b];\n  // /SKEL[2]" }, ["2"])).toBeNull();
    expect(run("Edit", { old_string: closing, new_string: "  return [a, b];\n  // /SKEL[2] export const leak = 1;" }, ["2"])).not.toBeNull();
  });

  it("asks for a signature change, another step's fence, an unfenced file, and a new file", () => {
    expect(run("Edit", { old_string: "smooth(raw: Point[])", new_string: "smooth(raw: Point[], k: number)" })?.reason).toMatch(/src\/a\.ts:3/);
    // The first stub occurrence is step 1's, so with only step 2 active it is out of scope.
    expect(run("Edit", { old_string: STUB, new_string: "x" }, ["2"])).not.toBeNull();
    expect(run("Edit", { old_string: "const", new_string: "let" }, ["1"], "const x = 1;\n")?.reason).toMatch(/no step SKEL\[1\] fence/);
    expect(run("Write", { content: "new" }, ["1"], null)?.reason).toMatch(/creates a new file/);
  });

  it("#606 review: refuses a new_string that smuggles markers and a new function past the close marker", () => {
    const injected = "return 2;\n  // /SKEL[1]\n}\nexport function injected() {\n  // SKEL[1] extra\n  return 9;";
    expect(run("Edit", { old_string: STUB, new_string: injected })?.reason).toMatch(/adds, removes or retitles SKEL markers/);
  });

  it("refuses a fill that closes the enclosing function without touching markers", () => {
    // A formatted escape trips the indentation rule first; either rule refusing is the point.
    expect(run("Edit", { old_string: STUB, new_string: "return raw;\n}\nexport function injected() {\n  return [];" })?.reason)
      .toMatch(/indented outside|closes the block/);
    expect(run("Edit", { old_string: STUB, new_string: "return raw; } export function injected() { return [];" })?.reason).toMatch(/closes the block/);
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
    expect(run("Edit", { old_string: STUB, new_string: fill })).toBeNull();
  });

  it("checks replace_all across fences and applies MultiEdit sequentially (M1)", () => {
    expect(run("Edit", { old_string: STUB, new_string: "x", replace_all: true })).not.toBeNull();
    expect(run("Edit", { old_string: STUB, new_string: "return [];", replace_all: true }, ["1", "2"])).toBeNull();
    expect(run("MultiEdit", { edits: [
      { old_string: STUB, new_string: "const a = raw;\n  return a;" },
      { old_string: "const a = raw;", new_string: "const a = [...raw];" },
    ] })).toBeNull();
    // Edit 2's old_string only exists after edit 1 — it must still be checked.
    expect(run("MultiEdit", { edits: [
      { old_string: STUB, new_string: "return TOKEN;" },
      { old_string: "return TOKEN;\n  // /SKEL[1]\n}\n", new_string: "return raw;\n  // /SKEL[1]\n}\nexport const leak = 1;\n" },
    ] })).not.toBeNull();
  });

  it("holds a whole-file Write to the same result checks", () => {
    expect(run("Write", { content: SRC.replace(STUB, "return raw.filter(Boolean);") })).toBeNull();
    expect(run("Write", { content: SRC.replace(STUB, "return raw;").replace("export function interpolate", "export async function interpolate") })).not.toBeNull();
    expect(run("Write", { content: SRC.replace(STUB, "return raw;\n  // /SKEL[1]\n}\nfunction x() {\n  // SKEL[1] again") })).not.toBeNull();
  });

  it("leaves deepPairing's own state to its own class", () => {
    expect(evaluateSkeletonEdit({ toolName: "Write", toolInput: { file_path: "/proj/.deeppairing/x.json", content: "{}" }, projectRoot: root, scope: scope(["1"]), readFile: () => null })).toBeNull();
  });

  it("speaks to the human first with a greppable agent line; strict-stop words it as a stop (M2)", () => {
    const v = run("Edit", { old_string: "import", new_string: "x" })!;
    expect(v.reason.startsWith("Allow this edit outside the skeleton?")).toBe(true);
    expect(v.reason).toContain("[SKELETON_SCOPE");
    expect(v.reason).toContain('"Stroke smoothing"');
    const strict = run("Edit", { old_string: "import", new_string: "x" }, ["1"], SRC, true)!;
    expect(strict.reason).toMatch(/^Edit to src\/a\.ts stopped before execution \(strict-stop mode\)\./);
    expect(strict.reason).not.toContain("Allow this edit");
    expect(strict.reason).toContain("[SKELETON_SCOPE]");
  });
});

describe("bodyEscapesFence", () => {
  it("catches the Python shape: a dedent past the marker", () => {
    expect(bodyEscapesFence("    return 1\ndef injected():\n    return 9", "    # SKEL[1] x", "f.py")).toMatch(/indented outside/);
    expect(bodyEscapesFence("    if x:\n        return 1\n    return 2  # don't", "    # SKEL[1] x", "f.py")).toBeNull();
  });

  it("flags a bracket left open past the fence", () => {
    expect(bodyEscapesFence("  if (x) {", "  // SKEL[1] x", "a.ts")).toMatch(/leaves a bracket open/);
  });
});

describe("selectSkeletonScope (#606 H2: owned by one session and one tree)", () => {
  const a = scope(["1"], { artifactId: "art_a", sessionId: "s_a", workspaceRoot: "/proj" });
  const b = scope(["9"], { artifactId: "art_b", sessionId: "s_b", workspaceRoot: "/proj" });
  const wt = scope(["5"], { artifactId: "art_wt", sessionId: "s_a", workspaceRoot: "/proj-wt" });

  it("applies only the edit's own session's scopes — never another session's", () => {
    expect(selectSkeletonScope([a, b], { sessionId: "s_a", targetAbs: "/proj/src/a.ts" })?.activeSkelIds).toEqual(["1"]);
    expect(selectSkeletonScope([a, b], { sessionId: "s_b", targetAbs: "/proj/src/a.ts" })?.activeSkelIds).toEqual(["9"]);
    expect(selectSkeletonScope([a, b], { sessionId: "s_other", targetAbs: "/proj/src/a.ts" })).toBeNull();
  });

  it("a scope governs only files in its own working tree", () => {
    expect(selectSkeletonScope([a, wt], { sessionId: "s_a", targetAbs: "/proj-wt/src/a.ts" })?.activeSkelIds).toEqual(["5"]);
    expect(selectSkeletonScope([wt], { sessionId: "s_a", targetAbs: "/proj/src/a.ts" })).toBeNull();
  });
});

describe("planDeclaredFiles + scanSkeletonFences (M3/M4)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skelscan-")));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), SRC);
    fs.writeFileSync(path.join(root, "README.md"), "```ts\n// SKEL[7] example\nthrow new Error(\"SKEL_TODO\");\n// /SKEL[7]\n```\n");
    fs.writeFileSync(path.join(root, "src", "bad.ts"), "// SKEL[9] open\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("collects step files and file_map paths", () => {
    expect(planDeclaredFiles({
      steps: [{ files: ["src/a.ts", { filePath: "src/b.ts" }] }, {}],
      visuals: [{ kind: "file_map", files: [{ path: "src/c.ts" }, { path: "src/a.ts" }] }, { kind: "diagram" }],
    })).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("reads only the declared files when there are any", () => {
    const { fences, errors } = scanSkeletonFences(root, { files: ["src/a.ts"] });
    expect(fences.map((f) => `${f.file}:${f.id}`)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
    expect(errors).toEqual([]);
  });

  it("falls back to a walk that skips prose examples and reports malformed files", () => {
    const { fences, errors } = scanSkeletonFences(root);
    expect(fences.map((f) => f.id).sort()).toEqual(["1", "2"]); // README's SKEL[7] example is ignored
    expect(errors[0]).toMatch(/src\/bad\.ts:1: SKEL\[9\] is never closed/);
  });
});

// ---- the hook, in-process and spawned ----

function seedPlan(root: string, sessionId: string, artifactId: string, status: string, content?: unknown): void {
  const dir = path.join(root, ".deeppairing", "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "artifacts.json");
  const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as Array<{ id: string }>) : [];
  fs.writeFileSync(file, JSON.stringify([...existing.filter((a) => a.id !== artifactId), { id: artifactId, type: "plan", status, createdAt: new Date(NOW).toISOString(), ...(content ? { content } : {}) }]));
}

describe("through evaluatePreflightHook", () => {
  let root: string;
  let file: string;
  let fallbackSession: string;
  const CLAUDE_SID = "11111111-2222-3333-4444-555555555555";
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skel-")));
    fs.mkdirSync(path.join(root, "src"));
    file = path.join(root, "src", "a.ts");
    fs.writeFileSync(file, SRC);
    fallbackSession = deriveSessionId(root).sessionId;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const live = (ids: string[], over: Partial<SkeletonScope> = {}, status = "approved") => {
    const s = scope(ids, { sessionId: fallbackSession, workspaceRoot: root, ...over });
    seedPlan(root, s.sessionId!, s.artifactId, status);
    writeSkeletonScope(root, s);
  };
  const hook = (toolInput: Record<string, unknown>, extra: { sessionId?: string; mode?: "ask" | "strict-stop" } = {}) =>
    evaluatePreflightHook({ toolName: "Edit", toolInput: { file_path: file, ...toolInput }, projectRoot: root, now: NOW, env: {}, ...extra });
  const OUTSIDE = { old_string: "smooth(raw", new_string: "smoothed(raw" };

  it("is silent with no scope (and the fast path says so)", () => {
    expect(skeletonScopeActive(root, NOW)).toBe(false);
    expect(hook({ old_string: "import", new_string: "x" }).fire).toBe(false);
  });

  it("fires on an out-of-fence edit from the owning session, and passes the fill", () => {
    live(["1"]);
    expect(skeletonScopeActive(root, NOW)).toBe(true);
    expect(hook(OUTSIDE)).toMatchObject({ fire: true, source: "skeleton", skeleton: { skelIds: ["1"] }, toolName: "Edit", target: "src/a.ts" });
    expect(hook({ old_string: STUB, new_string: "return raw;" }).fire).toBe(false);
  });

  it("fires on a pure deletion outside the fence (no proposal strings)", () => {
    live(["1"]);
    expect(hook({ old_string: 'import { Point } from "./types";\n', new_string: "" }).fire).toBe(true);
  });

  it("#606 H2: never fences another session — split-mode owner vs. an event with no identity, and vice versa", () => {
    const owner = deriveSessionId(root, CLAUDE_SID).sessionId;
    live(["1"], { sessionId: owner });
    expect(hook(OUTSIDE, { sessionId: CLAUDE_SID }).fire).toBe(true);
    expect(hook(OUTSIDE).fire).toBe(false); // no identity → fallback id ≠ owner
    expect(hook(OUTSIDE, { sessionId: "99999999-2222-3333-4444-555555555555" }).fire).toBe(false);
  });

  it("#606 M5: the fence is live only while the plan is approved in the store", () => {
    live(["1"]);
    expect(hook(OUTSIDE).fire).toBe(true);
    for (const status of ["draft", "revised", "superseded", "rejected", "retracted"]) {
      seedPlan(root, fallbackSession, "art_plan", status);
      expect(hook(OUTSIDE).fire, status).toBe(false);
    }
    fs.rmSync(path.join(root, ".deeppairing", "sessions"), { recursive: true });
    expect(hook(OUTSIDE).fire).toBe(false); // unreadable store → fail open
  });

  it("#606 review: plan B finishing never removes plan A's fence", () => {
    live(["1"], { artifactId: "art_a" });
    live(["2"], { artifactId: "art_b" });
    writeSkeletonScope(root, scope([], { artifactId: "art_b", sessionId: fallbackSession })); // B marks its step done
    expect(readSkeletonScopes(root, NOW).map((s) => s.artifactId)).toEqual(["art_a"]);
    expect(hook(OUTSIDE).fire).toBe(true);
  });

  it("strict-stop gets the strict wording; a guardrail path keeps its reason on the same ask (L2)", () => {
    live(["1"]);
    expect(hook(OUTSIDE, { mode: "strict-stop" }).reason).toMatch(/stopped before execution \(strict-stop mode\)/);
    const mig = path.join(root, "migrations", "001.sql");
    fs.mkdirSync(path.dirname(mig));
    fs.writeFileSync(mig, "select 1;\n");
    const d = evaluatePreflightHook({ toolName: "Edit", toolInput: { file_path: mig, old_string: "select 1;", new_string: "select 2;" }, projectRoot: root, now: NOW, env: {} });
    expect(d.source).toBe("skeleton");
    expect(d.reason).toContain("[SKELETON_SCOPE");
    expect(d.reason).toContain("GUARDRAIL_ESCALATION");
  });

  it("logs a fence fire as its own guardrail class for the companion", () => {
    live(["2"]);
    expect(hookGateRecord(hook({ old_string: "import", new_string: "x" }))).toMatchObject({
      source: "guardrail", guardrail: "skeleton-scope", concept: "Skeleton fence SKEL[2]", target: "src/a.ts",
    });
  });

  describe("parity PR 4 (#610 M1): a reshape awaiting approval PAUSES fills", () => {
    const V2 = "art_v2";
    const reshape = (over: Partial<NonNullable<SkeletonScope["reshape"]>> = {}, v2Status = "draft", v2Content?: unknown, owner = fallbackSession) => {
      seedPlan(root, owner, V2, v2Status, v2Content);
      writeSkeletonScope(root, scope([], {
        artifactId: V2,
        sessionId: owner,
        workspaceRoot: root,
        reshape: { fromId: "art_plan", files: ["src/a.ts", "src/new.ts"], restoreApproved: true, restoreSkelIds: ["1"], ...over },
      }));
    };
    const STUB_FILL = { old_string: STUB, new_string: "return raw;" };

    it("asks on ANY edit to the plan's declared files — even a fill inside a fence — and stops under strict-stop", () => {
      live(["1"], {}, "superseded"); // v1's own scope no longer counts
      reshape();
      expect(skeletonScopeActive(root, NOW)).toBe(true); // the fast path keeps going
      const d = hook(STUB_FILL);
      expect(d).toMatchObject({ fire: true, source: "skeleton", skeleton: { skelIds: [], paused: true }, target: "src/a.ts" });
      expect(d.reason).toContain("[SKELETON_PAUSED");
      expect(d.reason).toContain("Allow this edit while the skeleton change awaits your approval?");
      const w = evaluatePreflightHook({ toolName: "Write", toolInput: { file_path: path.join(root, "src", "new.ts"), content: "x" }, projectRoot: root, now: NOW, env: {} });
      expect(w.fire).toBe(true);
      expect(hook(STUB_FILL, { mode: "strict-stop" }).reason).toMatch(/stopped before execution \(strict-stop mode\).*fills are paused/);
      expect(hookGateRecord(d)).toMatchObject({ guardrail: "skeleton-paused", concept: "Skeleton change awaiting approval", target: "src/a.ts" });
    });

    it("files outside the plan aren't paused, and another session is never affected", () => {
      reshape();
      const other = path.join(root, "src", "other.ts");
      fs.writeFileSync(other, "export const x = 1;\n");
      expect(evaluatePreflightHook({ toolName: "Edit", toolInput: { file_path: other, old_string: "1", new_string: "2" }, projectRoot: root, now: NOW, env: {} }).fire).toBe(false);
      expect(hook(STUB_FILL, { sessionId: "99999999-2222-3333-4444-555555555555" }).fire).toBe(false);
      // …and a reshape owned by another session doesn't pause this one.
      fs.rmSync(path.join(root, ".deeppairing"), { recursive: true, force: true });
      reshape({}, "draft", undefined, deriveSessionId(root, CLAUDE_SID).sessionId);
      expect(hook(STUB_FILL).fire).toBe(false);
    });

    it("approving v2 replaces the pause with v2's own in-progress fences", () => {
      reshape({}, "approved", { steps: [{ skelId: "1", status: "pending" }, { skelId: "2", status: "in_progress" }] });
      expect(hook({ old_string: "smooth(raw", new_string: "smoothed(raw" })).toMatchObject({ fire: true, skeleton: { skelIds: ["2"] } });
      expect(hook({ old_string: "smooth(raw", new_string: "smoothed(raw" }).reason).toContain("[SKELETON_SCOPE");
      // Approved with nothing in progress: no fence, no pause.
      reshape({}, "approved", { steps: [{ skelId: "2", status: "pending" }] });
      expect(hook(STUB_FILL).fire).toBe(false);
    });

    it("rejecting or retracting v2 restores v1's approved fences; never when v1 wasn't approved", () => {
      for (const status of ["rejected", "retracted"]) {
        reshape({}, status);
        expect(hook({ old_string: "interpolate(a", new_string: "interp(a" }), status).toMatchObject({ fire: true, skeleton: { skelIds: ["1"] } });
        expect(hook(STUB_FILL).fire, status).toBe(false); // the restored fence-1 fill is allowed
      }
      reshape({ restoreApproved: false }, "rejected");
      expect(hook({ old_string: "interpolate(a", new_string: "interp(a" }).fire).toBe(false);
    });

    it("a reshape scope survives with no active ids (written and read back)", () => {
      reshape();
      expect(readSkeletonScopes(root, NOW).find((x) => x.artifactId === V2)?.reshape).toMatchObject({ fromId: "art_plan", restoreApproved: true, restoreSkelIds: ["1"] });
    });

    describe("#611: a rejected reshape restores v1's CURRENT fences, not the ones frozen at pause time", () => {
      type Step = { skelId: string; status: string };
      const v1 = (steps: Step[], status = "superseded", owner = fallbackSession) => seedPlan(root, owner, "art_plan", status, { steps });
      const SIG = { old_string: "interpolate(a", new_string: "interp(a" };
      const FILL2 = {
        old_string: '// SKEL[2] catmull-rom between a and b\n  throw new Error("SKEL_TODO");',
        new_string: "// SKEL[2] catmull-rom between a and b\n  return [a, b];",
      };
      const done = (id: string): Step => ({ skelId: id, status: "done" });

      it("v1 moved on to step 2: fence 2 is enforced (ask and strict-stop), the frozen fence 1 is not", () => {
        v1([done("1"), { skelId: "2", status: "in_progress" }]);
        reshape({ restoreSkelIds: ["1"] }, "rejected"); // frozen at pause time: step 1
        expect(hook(SIG)).toMatchObject({ fire: true, source: "skeleton", skeleton: { skelIds: ["2"] } });
        expect(hook(SIG).reason).toContain("[SKELETON_SCOPE");
        expect(hook(SIG, { mode: "strict-stop" })).toMatchObject({ fire: true, skeleton: { skelIds: ["2"] } });
        expect(hook(SIG, { mode: "strict-stop" }).reason).toMatch(/stopped before execution \(strict-stop mode\)/);
        expect(hook(FILL2).fire).toBe(false); // the current step's fill passes
        // Step 1 is done: its old fence is no longer the one being filled.
        expect(hook(STUB_FILL)).toMatchObject({ fire: true, skeleton: { skelIds: ["2"] } });
      });

      it("v1 complete, skipped or reset: no stale ask, and no stale deny under strict-stop", () => {
        const cases: Step[][] = [
          [done("1"), done("2")],
          [done("1"), { skelId: "2", status: "skipped" }],
          [{ skelId: "1", status: "pending" }, { skelId: "2", status: "pending" }],
        ];
        for (const steps of cases) {
          v1(steps);
          reshape({ restoreSkelIds: ["1"] }, "rejected");
          for (const mode of ["ask", "strict-stop"] as const) {
            expect(hook(SIG, { mode }).fire, `${JSON.stringify(steps)} ${mode}`).toBe(false);
            expect(hook(OUTSIDE, { mode }).fire, `${JSON.stringify(steps)} ${mode}`).toBe(false);
          }
        }
        // The same frozen record WITH v1 still on step 1 does fence (control).
        v1([{ skelId: "1", status: "in_progress" }, { skelId: "2", status: "pending" }]);
        expect(hook(SIG, { mode: "strict-stop" })).toMatchObject({ fire: true, skeleton: { skelIds: ["1"] } });
      });

      it("v1 retracted or obsolete, or superseded again by a later version: nothing is restored", () => {
        for (const status of ["retracted", "obsolete"]) {
          v1([{ skelId: "1", status: "in_progress" }], status);
          reshape({}, "rejected");
          expect(hook(SIG).fire, status).toBe(false);
        }
        reshape({}, "rejected");
        const file = path.join(root, ".deeppairing", "sessions", fallbackSession, "artifacts.json");
        fs.writeFileSync(file, JSON.stringify([
          { id: "art_plan", type: "plan", status: "superseded", content: { steps: [{ skelId: "1", status: "in_progress" }] } },
          { id: V2, type: "plan", status: "rejected", parentId: "art_plan" },
          { id: "art_v3", type: "plan", status: "approved", parentId: "art_plan", content: { steps: [{ skelId: "1", status: "pending" }] } },
        ]));
        expect(hook(SIG).fire).toBe(false);
      });

      it("v1 not in this session's file (cross-session revise): the record is used, and v1's progress refreshes or clears it", () => {
        reshape({ restoreSkelIds: ["1"] }, "rejected");
        expect(hook(SIG)).toMatchObject({ fire: true, skeleton: { skelIds: ["1"] } });
        const plan = (steps: Step[], status = "superseded") => ({ id: "art_plan", status, content: { steps } });
        refreshReshapeRestores(root, plan([done("1"), { skelId: "2", status: "in_progress" }]), NOW);
        expect(readSkeletonScopes(root, NOW).find((x) => x.artifactId === V2)?.reshape).toMatchObject({ restoreApproved: true, restoreSkelIds: ["2"] });
        expect(hook(SIG)).toMatchObject({ fire: true, skeleton: { skelIds: ["2"] } });
        refreshReshapeRestores(root, plan([done("1"), done("2")]), NOW);
        expect(readSkeletonScopes(root, NOW).find((x) => x.artifactId === V2)?.reshape).toMatchObject({ restoreApproved: false, restoreSkelIds: [] });
        expect(hook(SIG, { mode: "strict-stop" }).fire).toBe(false);
        // Retracting v1 clears it too.
        reshape({ restoreSkelIds: ["1"] }, "rejected");
        refreshReshapeRestores(root, plan([{ skelId: "1", status: "in_progress" }], "retracted"), NOW);
        expect(hook(SIG).fire).toBe(false);
      });

      it("no cross-session effect: another session's restore never fences this one, and another plan's progress never touches it", () => {
        const owner = deriveSessionId(root, CLAUDE_SID).sessionId;
        v1([{ skelId: "1", status: "in_progress" }], "superseded", owner);
        reshape({}, "rejected", undefined, owner);
        expect(hook(SIG, { sessionId: CLAUDE_SID })).toMatchObject({ fire: true, skeleton: { skelIds: ["1"] } });
        expect(hook(SIG).fire).toBe(false); // the fallback session
        expect(hook(SIG, { sessionId: "99999999-2222-3333-4444-555555555555", mode: "strict-stop" }).fire).toBe(false);
        const before = fs.readFileSync(path.join(root, ".deeppairing", "skeleton-scopes", `${V2}.json`), "utf-8");
        refreshReshapeRestores(root, { id: "art_other", status: "approved", content: { steps: [{ skelId: "1", status: "done" }] } }, NOW);
        expect(fs.readFileSync(path.join(root, ".deeppairing", "skeleton-scopes", `${V2}.json`), "utf-8")).toBe(before);
      });
    });
  });

  it("ignores a stale scope and removes the file when nothing is in progress", () => {
    live(["1"], { updatedAt: new Date(NOW - SKELETON_SCOPE_MAX_AGE_MS - 1).toISOString() });
    expect(readSkeletonScopes(root, NOW)).toEqual([]);
    expect(hook(OUTSIDE).fire).toBe(false);
    writeSkeletonScope(root, scope([]));
    expect(fs.existsSync(path.join(root, ".deeppairing", "skeleton-scopes", "art_plan.json"))).toBe(false);
  });
});

// #606 review M6 — both real emitters, spawned, in a ledger-free project where
// the fence is the ONLY reason past the fast path.
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginBundle = path.resolve(here, "../../../../../claude-plugin/server/preflight.mjs");
const distCore = path.resolve(here, "../../../dist/cli/preflight-hook-core.js");

describe.each([
  ["init-generated .deeppairing/hooks/preflight.mjs", "init", fs.existsSync(distCore)],
  ["plugin bundle server/preflight.mjs", "plugin", fs.existsSync(pluginBundle)],
] as const)("real hook launch: %s", (_name, kind, built) => {
  let parent: string;
  let dir: string;
  let home: string;
  beforeEach(() => {
    parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skelspawn-")));
    dir = path.join(parent, "project");
    home = path.join(parent, "home");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    fs.writeFileSync(path.join(dir, "src", "a.ts"), SRC);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  const command = () => {
    if (kind === "plugin") return `node "${pluginBundle}"`;
    expect(ensurePreflightHook(dir).ok).toBe(true);
    return JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
  };
  const launch = (cmd: string, payload: unknown, mode?: "strict-stop") => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: dir, FORCE_COLOR: "0", [GUARDRAIL_BACKSTOP_ENV]: "" };
    delete env.DEEPPAIRING_PREFLIGHT_MODE;
    if (mode) env.DEEPPAIRING_PREFLIGHT_MODE = mode;
    const r = spawnSync("/bin/sh", ["-c", cmd], {
      cwd: parent,
      env,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim() ? (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }) : null;
  };

  it.skipIf(!built)("asks on an out-of-fence edit, stays silent on the fill, and only for the owning session", () => {
    const cmd = command();
    const sid = "11111111-2222-3333-4444-555555555555";
    const owner = deriveSessionId(dir, sid).sessionId;
    seedPlan(dir, owner, "art_plan", "approved");
    writeSkeletonScope(dir, { ...scope(["1"]), updatedAt: new Date().toISOString(), sessionId: owner, workspaceRoot: dir });
    const file = path.join(dir, "src", "a.ts");
    const ev = (old_string: string, new_string: string, session_id?: string) => ({ tool_name: "Edit", session_id, tool_input: { file_path: file, old_string, new_string } });

    const out = launch(cmd, ev("smooth(raw", "smoothed(raw", sid));
    expect(out?.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain("[SKELETON_SCOPE");
    expect(launch(cmd, ev(STUB, "return raw;", sid))).toBeNull();
    expect(launch(cmd, ev("smooth(raw", "smoothed(raw", "99999999-2222-3333-4444-555555555555"))).toBeNull();
  }, 120_000);

  it.skipIf(!built)("parity PR 4: a reshape awaiting approval asks even on a fill, only for the owning session", () => {
    const cmd = command();
    const sid = "11111111-2222-3333-4444-555555555555";
    const owner = deriveSessionId(dir, sid).sessionId;
    seedPlan(dir, owner, "art_plan", "superseded");
    seedPlan(dir, owner, "art_v2", "draft");
    writeSkeletonScope(dir, {
      ...scope([], { artifactId: "art_v2" }),
      updatedAt: new Date().toISOString(),
      sessionId: owner,
      workspaceRoot: dir,
      reshape: { fromId: "art_plan", files: ["src/a.ts"], restoreApproved: true, restoreSkelIds: ["1"] },
    });
    const file = path.join(dir, "src", "a.ts");
    const ev = (session_id?: string) => ({ tool_name: "Edit", session_id, tool_input: { file_path: file, old_string: STUB, new_string: "return raw;" } });
    const out = launch(cmd, ev(sid));
    expect(out?.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain("[SKELETON_PAUSED");
    expect(launch(cmd, ev("99999999-2222-3333-4444-555555555555"))).toBeNull();
  }, 120_000);

  it.skipIf(!built)("#611: a rejected reshape fences v1's CURRENT step; once v1 moves on, no stale ask or strict-stop deny", () => {
    const cmd = command();
    const sid = "11111111-2222-3333-4444-555555555555";
    const owner = deriveSessionId(dir, sid).sessionId;
    seedPlan(dir, owner, "art_plan", "superseded", { steps: [{ skelId: "1", status: "done" }, { skelId: "2", status: "in_progress" }] });
    seedPlan(dir, owner, "art_v2", "rejected");
    writeSkeletonScope(dir, {
      ...scope([], { artifactId: "art_v2" }),
      updatedAt: new Date().toISOString(),
      sessionId: owner,
      workspaceRoot: dir,
      // Frozen at pause time: step 1. v1 has since moved on to step 2.
      reshape: { fromId: "art_plan", files: ["src/a.ts"], restoreApproved: true, restoreSkelIds: ["1"] },
    });
    const file = path.join(dir, "src", "a.ts");
    const ev = (old_string: string, new_string: string, session_id?: string) => ({ tool_name: "Edit", session_id, tool_input: { file_path: file, old_string, new_string } });
    const SIG = ev("interpolate(a", "interp(a", sid);

    const asked = launch(cmd, SIG);
    expect(asked?.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(asked?.hookSpecificOutput.permissionDecisionReason).toContain("[SKELETON_SCOPE");
    expect(asked?.hookSpecificOutput.permissionDecisionReason).toContain("SKEL[2]");
    expect(launch(cmd, SIG, "strict-stop")?.hookSpecificOutput.permissionDecision).toBe("deny");
    // The current step's fill passes.
    expect(launch(cmd, ev('// SKEL[2] catmull-rom between a and b\n  throw new Error("SKEL_TODO");', "// SKEL[2] catmull-rom between a and b\n  return [a, b];", sid))).toBeNull();
    // Another session is never fenced.
    expect(launch(cmd, ev("interpolate(a", "interp(a", "99999999-2222-3333-4444-555555555555"), "strict-stop")).toBeNull();

    // v1 completes: no stale ask, no stale deny.
    seedPlan(dir, owner, "art_plan", "superseded", { steps: [{ skelId: "1", status: "done" }, { skelId: "2", status: "done" }] });
    expect(launch(cmd, SIG)).toBeNull();
    expect(launch(cmd, SIG, "strict-stop")).toBeNull();
  }, 120_000);
});
