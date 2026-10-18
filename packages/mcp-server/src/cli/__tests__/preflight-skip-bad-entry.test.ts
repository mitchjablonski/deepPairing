/**
 * #557 — one malformed ledger entry must not disable every stance.
 *
 * Before: a single `preferences.json` entry with a non-string `concept` made
 * runPreflight throw, the hook failed open, and NO stance enforced. Now the
 * unusable concept is ignored (or, for `{ name }`, coerced), so the entry still
 * matches on its description; an entry the matcher still throws on is skipped.
 * Either way it is recorded by index + class (no content) and every valid
 * stance still asks — or, in strict-stop, denies. Both emitters, real
 * processes, real files; no mocks.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePreflightHook } from "../setup-tasks.js";
import { runPreflightSkippingBadEntries } from "../preflight-hook-core.js";
import { PREFLIGHT_FAILURE_INDICES_CAP, type PreflightFailureSink } from "../../hooks/preflight-diagnostics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..", "..");
const distBuilt = fs.existsSync(path.join(pkgRoot, "dist", "cli", "preflight-hook-core.js")) &&
  fs.existsSync(path.join(pkgRoot, "dist", "hooks", "preflight-diagnostics.js"));
const SECRET = "sk-ant-api03-SKIPPED-ENTRY-CONTENT";

let base = "";
let pluginHook = "";
let n = 0;
beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-557-")));
  pluginHook = path.join(base, "bundle", "preflight.mjs");
  await build({
    entryPoints: [path.join(pkgRoot, "src", "cli", "preflight-hook-entry.ts")],
    outfile: pluginHook, bundle: true, platform: "node", format: "esm", target: "node20",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "silent",
  });
});
afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const VALID = { description: "global mutable state", reason: "Keep configuration explicit" };
const BAD = (i: number) => ({ description: `${SECRET} ${i}`, concept: [42, {}, ["a"], true][i % 4] });

function setup(copy: "init" | "plugin", entries: unknown[]) {
  const root = path.join(base, `p${++n}`);
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions", "s1"), { recursive: true });
  fs.writeFileSync(path.join(root, ".deeppairing", "sessions", "s1", "artifacts.json"), "[]");
  fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: entries }));
  let script = pluginHook;
  if (copy === "init") {
    expect(ensurePreflightHook(root).ok).toBe(true);
    script = path.join(root, ".deeppairing", "hooks", "preflight.mjs");
  }
  const run = (content: string, mode?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: base, FORCE_COLOR: "0", NO_COLOR: "1", CLAUDE_PROJECT_DIR: root };
    delete env.DEEPPAIRING_PROJECT_ROOT;
    delete env.DEEPPAIRING_PREFLIGHT_MODE;
    delete env.DEEPPAIRING_GUARDRAIL_BACKSTOP;
    if (mode) env.DEEPPAIRING_PREFLIGHT_MODE = mode;
    const r = spawnSync(process.execPath, [script], {
      cwd: root, env, encoding: "utf8", timeout: 15_000,
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(root, "src", "a.ts"), content } }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const stateText = () => fs.readFileSync(path.join(root, ".deeppairing", "hooks-state.json"), "utf8");
  const skipped = () => JSON.parse(stateText()).preflightFailures?.ledger_entry_invalid;
  return { root, run, stateText, skipped };
}

describe.skipIf(!distBuilt).each(["init", "plugin"] as const)("#557 (%s copy)", (copy) => {
  it.each([
    { mode: undefined, decision: "ask" },
    { mode: "strict-stop", decision: "deny" },
  ])("one bad entry beside a matching valid stance now fires (mode=$mode)", ({ mode, decision }) => {
    const f = setup(copy, [BAD(0), VALID]);
    const out = f.run("global mutable state", mode);
    expect(out.hookSpecificOutput.permissionDecision).toBe(decision);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("REJECTED_APPROACH_BLOCKED");
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain(SECRET);
    expect(f.skipped()).toMatchObject({ count: 1, detail: "preferences:concept", indices: [0] });
    expect(f.stateText()).not.toContain(SECRET);
    expect(JSON.parse(f.stateText()).preflightFailures.evaluator_threw).toBeUndefined();
  });

  it.each([
    { mode: undefined, decision: "ask" },
    { mode: "strict-stop", decision: "deny" },
  ])("a bad concept is ignored, not the entry: it still enforces on its description (mode=$mode)", ({ mode, decision }) => {
    const f = setup(copy, [{ description: "global mutable state", concept: 42, reason: "explicit" }]);
    expect(f.run("global mutable state", mode).hookSpecificOutput.permissionDecision).toBe(decision);
    expect(f.run("const n = 1", mode)).toBeNull();
    expect(f.skipped()).toMatchObject({ count: 2, detail: "preferences:concept", indices: [0] });
  });

  it("the option-schema shape { name } is coerced to its name and matched", () => {
    const f = setup(copy, [{ description: "an unrelated description", concept: { name: "global mutable state", rationale: "x" } }]);
    const out = f.run("global mutable state");
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("global mutable state");
    expect(f.skipped()).toMatchObject({ detail: "preferences:concept", indices: [0] });
  });

  it("several bad entries are made matchable; each valid stance still enforces", () => {
    const f = setup(copy, [BAD(0), { description: "redis cache layer", reason: "heavy" }, BAD(1), VALID, BAD(2), BAD(3)]);
    expect(f.run("global mutable state").hookSpecificOutput.permissionDecision).toBe("ask");
    expect(f.run("add a redis cache layer here").hookSpecificOutput.permissionDecision).toBe("ask");
    expect(f.run("const n = 1")).toBeNull(); // a genuine non-match stays silent
    expect(f.skipped()).toMatchObject({ count: 3, indices: [0, 2, 4, 5] });
  });

  it("an all-bad ledger whose descriptions match nothing stays silent, recording the entries", () => {
    const f = setup(copy, [BAD(0), BAD(1)]);
    expect(f.run("global mutable state")).toBeNull();
    expect(f.skipped()).toMatchObject({ count: 1, indices: [0, 1] });
  });

  it("an all-valid ledger records nothing new", () => {
    const f = setup(copy, ["bare string stance", { ...VALID, concept: null }]);
    expect(f.run("global mutable state").hookSpecificOutput.permissionDecision).toBe("ask");
    expect(JSON.parse(f.stateText()).preflightFailures).toBeUndefined();
  });

  it("recording stays bounded with many bad entries", () => {
    const f = setup(copy, [...Array.from({ length: 200 }, (_, i) => BAD(i)), VALID]);
    expect(f.run("global mutable state").hookSpecificOutput.permissionDecision).toBe("ask");
    const rec = f.skipped();
    expect(rec.indices).toEqual(Array.from({ length: PREFLIGHT_FAILURE_INDICES_CAP }, (_, i) => i));
    expect(JSON.stringify(JSON.parse(f.stateText()).preflightFailures).length).toBeLessThan(400);
  });
});

describe("#557 per-entry guard (an entry that passes the type check but still throws)", () => {
  const base = { toolName: "Write", proposalStrings: ["global mutable state"], proposalPaths: [], teamPreferences: [] };
  // A real object whose description read throws — the shape a future
  // normalisation gap could produce. Not a mock: runPreflight reads it as-is.
  const hostile = { get description(): string { throw new TypeError("boom"); }, concept: "x y" } as never;

  it("probes entries one by one, skips the thrower, and still matches the rest", () => {
    const failures: PreflightFailureSink = [];
    const r = runPreflightSkippingBadEntries({ ...base, entries: [{ entry: hostile, index: 3 }, { entry: VALID, index: 7 }], failures });
    expect(r.blocked).toBe(true);
    expect(failures).toEqual([{ cls: "ledger_entry_invalid", source: "preferences", tag: "skipped", indices: [3] }]);
  });

  it("an all-valid ledger takes the single original call and notes nothing", () => {
    const failures: PreflightFailureSink = [];
    const r = runPreflightSkippingBadEntries({ ...base, entries: [{ entry: VALID, index: 0 }], failures });
    expect(r.blocked).toBe(true);
    expect(failures).toEqual([]);
  });
});
