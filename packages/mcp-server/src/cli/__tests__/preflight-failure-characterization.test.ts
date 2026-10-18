/**
 * #546 step 1 — CHARACTERIZATION of every preflight path where a read, import,
 * parse or evaluation fault produces a silent outcome today.
 *
 * Both emitters run as real processes: the plugin `preflight.mjs` (bundled from
 * this tree's source with esbuild, exactly as bundle-plugin.mjs ships it) and
 * the init-generated `.deeppairing/hooks/preflight.mjs` (written by the real
 * ensurePreflightHook, importing the built dist core). Every input is a real
 * file on disk; nothing is mocked.
 *
 * Each case pins what the hook does today: its stdout (the decision), its
 * stderr and its exit status. These pins are the "default enforcement does not
 * change" half of #546 — a fault that is a no-fire today stays a no-fire.
 *
 * #546 step 2 adds one thing per case: the bounded diagnostic it now leaves in
 * hooks-state's `preflightFailures` field (`diag`). The decision pins above it
 * are untouched from the step-1 commit, and every control records nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePreflightHook } from "../setup-tasks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..", "..");
const distBuilt = fs.existsSync(path.join(pkgRoot, "dist", "cli", "preflight-hook-core.js")) &&
  fs.existsSync(path.join(pkgRoot, "dist", "guardrail-rules.js"));
const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

let base = "";
let pluginHook = "";

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-546-char-")));
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

const REJECTED = "global mutable state";
let n = 0;

/** A project with a session store and a seeded rejection, unless `bare`. */
function makeProject(opts: { bare?: boolean } = {}): string {
  const root = path.join(base, `p${++n}`);
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions", "s1"), { recursive: true });
  fs.writeFileSync(path.join(root, ".deeppairing", "sessions", "s1", "artifacts.json"), "[]");
  if (!opts.bare) {
    fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), JSON.stringify({
      rejectedApproaches: [{ description: REJECTED, reason: "Keep configuration explicit" }],
    }));
  }
  return root;
}

function scriptFor(copy: "init" | "plugin", root: string): string {
  if (copy === "plugin") return pluginHook;
  expect(ensurePreflightHook(root).ok).toBe(true);
  return path.join(root, ".deeppairing", "hooks", "preflight.mjs");
}

function hookEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: base, USERPROFILE: base, FORCE_COLOR: "0", NO_COLOR: "1", CLAUDE_PROJECT_DIR: root };
  delete env.DEEPPAIRING_PROJECT_ROOT;
  delete env.DEEPPAIRING_PREFLIGHT_MODE;
  delete env.DEEPPAIRING_GUARDRAIL_BACKSTOP;
  return { ...env, ...extra };
}

function run(script: string, root: string, input: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [script], { cwd: root, env: hookEnv(root, extra), input, encoding: "utf8", timeout: 15_000 });
  expect(r.error).toBeUndefined();
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function write(root: string, file = "src/config.ts", content = REJECTED): string {
  return JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(root, file), content } });
}

function statePath(root: string): string {
  return path.join(root, ".deeppairing", "hooks-state.json");
}
function readState(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(root), "utf8"));
  } catch {
    return null;
  }
}

const ERROR_LINE = /^\[deepPairing\] preflight hook error: [^\n]+\n$/;

interface Case {
  name: string;
  /** Arrange the project; return the stdin to feed. */
  setup: (root: string) => string;
  stdout: "" | "ask";
  stderr: "" | "error";
  /** The fault is in the init-generated copy's import seam only. */
  initOnly?: boolean;
  /** Edits the generated script after install (init copy only). */
  patchScript?: (src: string, root: string) => string;
  /** #546 — the [class, detail] the fault now records, or null for none. */
  diag: [string, string] | null;
}

/**
 * The characterized list (mirrored in the PR body). Every one of these is a
 * silent outcome today: no decision, or a decision with no record of the fault.
 */
const CASES: Case[] = [
  {
    name: "C1 stdin is not JSON",
    setup: () => "{ not json",
    stdout: "", stderr: "error", diag: ["input_malformed", "stdin:SyntaxError"],
  },
  {
    name: "C2 stdin is JSON null (not an event object)",
    setup: () => "null",
    stdout: "", stderr: "error", diag: ["input_malformed", "stdin:TypeError"],
  },
  {
    name: "C3 stdin is a JSON string (not an event object)",
    setup: () => JSON.stringify("Write"),
    stdout: "", stderr: "", diag: ["input_malformed", "stdin:shape"],
  },
  {
    name: "C4 preferences.json unparseable, no team file: fast path exits",
    setup: (root) => {
      fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), "{ \"rejectedApproaches\": [ trailing");
      return write(root);
    },
    stdout: "", stderr: "", diag: ["ledger_corrupt", "preferences:SyntaxError"],
  },
  {
    name: "C5 preferences.json unparseable beside a valid team file: matcher sees []",
    setup: (root) => {
      fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), "{ broken");
      fs.writeFileSync(path.join(root, ".deeppairing", "team.json"), JSON.stringify({ version: 1, preferences: [
        { id: "t1", kind: "avoid", concept: "unrelated vendor lockin", rationale: "x" },
      ] }));
      return write(root);
    },
    stdout: "", stderr: "", diag: ["ledger_corrupt", "preferences:SyntaxError"],
  },
  {
    name: "C6 preferences.json unreadable (a directory, EISDIR)",
    setup: (root) => {
      fs.rmSync(path.join(root, ".deeppairing", "preferences.json"));
      fs.mkdirSync(path.join(root, ".deeppairing", "preferences.json"));
      return write(root);
    },
    stdout: "", stderr: "", diag: ["ledger_unreadable", "preferences:EISDIR"],
  },
  {
    name: "C7 preferences.json rejectedApproaches is not an array",
    setup: (root) => {
      fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: { description: REJECTED } }));
      return write(root);
    },
    stdout: "", stderr: "", diag: ["ledger_corrupt", "preferences:schema"],
  },
  {
    name: "C8 team.json unparseable (a block comment), team-only rule",
    setup: (root) => {
      fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), "{}");
      fs.writeFileSync(path.join(root, ".deeppairing", "team.json"),
        `/* team rules */\n${JSON.stringify({ version: 1, preferences: [{ id: "t1", kind: "avoid", concept: REJECTED, rationale: "x" }] })}`);
      return write(root);
    },
    stdout: "", stderr: "", diag: ["ledger_corrupt", "team:SyntaxError"],
  },
  {
    name: "C9 team.json fails the all-or-nothing schema (one bad entry)",
    setup: (root) => {
      fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), "{}");
      fs.writeFileSync(path.join(root, ".deeppairing", "team.json"), JSON.stringify({ version: 1, preferences: [
        { id: "t1", kind: "avoid", concept: REJECTED, rationale: "x" },
        { id: "t2", kind: "forbid", concept: "y", rationale: "z" },
      ] }));
      return write(root);
    },
    stdout: "", stderr: "", diag: ["ledger_corrupt", "team:schema"],
  },
  {
    name: "C10 team.json unreadable (a directory, EISDIR)",
    setup: (root) => {
      fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), "{}");
      fs.mkdirSync(path.join(root, ".deeppairing", "team.json"));
      return write(root);
    },
    stdout: "", stderr: "", diag: ["ledger_unreadable", "team:EISDIR"],
  },
  {
    name: "C11 a parseable ledger entry with a non-string concept makes the evaluator throw",
    setup: (root) => {
      fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: [
        { description: REJECTED, reason: "Keep configuration explicit" },
        { description: "another stance", concept: 42 },
      ] }));
      return write(root);
    },
    stdout: "", stderr: "error", diag: ["evaluator_threw", "matcher:TypeError"],
  },
  {
    name: "C12 guardrail path, every session store unparseable: backstop fails open",
    setup: (root) => {
      fs.rmSync(path.join(root, ".deeppairing", "preferences.json"));
      fs.writeFileSync(path.join(root, ".deeppairing", "sessions", "s1", "artifacts.json"), "[ torn");
      return write(root, ".github/workflows/ci.yml", "name: ci");
    },
    stdout: "", stderr: "", diag: ["session_store_unreadable", "sessions:corrupt"],
  },
  {
    name: "C13 init: the stamped matcher core cannot be imported",
    initOnly: true,
    setup: (root) => write(root),
    patchScript: (src, root) => src.replace(/const CORE_URL = "[^"]+";/, `const CORE_URL = ${JSON.stringify("file://" + path.join(root, "missing-core.js"))};`),
    stdout: "", stderr: "error", diag: ["matcher_import_failed", "core:ERR_MODULE_NOT_FOUND"],
  },
  {
    name: "C14 init: the guardrail rule leaf cannot be imported (fail safe: the core still decides)",
    initOnly: true,
    setup: (root) => {
      fs.rmSync(path.join(root, ".deeppairing", "preferences.json"));
      return write(root, ".github/workflows/ci.yml", "name: ci");
    },
    patchScript: (src, root) => src.replace(/const RULES_URL = "[^"]+";/, `const RULES_URL = ${JSON.stringify("file://" + path.join(root, "missing-rules.js"))};`),
    stdout: "ask", stderr: "", diag: ["matcher_import_failed", "rules:ERR_MODULE_NOT_FOUND"],
  },
];

/** Controls — expected non-matches and absent inputs, which are NOT faults. */
const CONTROLS: Case[] = [
  { name: "K1 valid ledger, unrelated edit", setup: (root) => write(root, "src/safe.ts", "const n = 1"), stdout: "", stderr: "", diag: null },
  {
    name: "K2 no preferences.json or team.json at all",
    setup: (root) => {
      fs.rmSync(path.join(root, ".deeppairing", "preferences.json"));
      return write(root);
    },
    stdout: "", stderr: "", diag: null,
  },
  { name: "K3 a non-write tool", setup: () => JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }), stdout: "", stderr: "", diag: null },
  { name: "K4 empty stdin", setup: () => "", stdout: "", stderr: "", diag: null },
  { name: "K5 a genuine match", setup: (root) => write(root), stdout: "ask", stderr: "", diag: null },
];

function arrange(copy: "init" | "plugin", c: Case) {
  const root = makeProject();
  const script = scriptFor(copy, root);
  if (c.patchScript) fs.writeFileSync(script, c.patchScript(fs.readFileSync(script, "utf8"), root));
  const input = c.setup(root);
  return { root, script, input };
}

function expectDiag(root: string, diag: [string, string] | null) {
  const field = (readState(root) ?? {}).preflightFailures as Record<string, Record<string, unknown>> | undefined;
  if (diag === null) {
    expect(field).toBeUndefined();
    return;
  }
  expect(Object.keys(field ?? {})).toEqual([diag[0]]);
  expect(field![diag[0]]).toEqual({ count: 1, firstAt: expect.any(String), lastAt: expect.any(String), detail: diag[1] });
}

function assertPinned(c: Case, r: { stdout: string; stderr: string; status: number | null }) {
  expect(r.status, r.stderr).toBe(0);
  if (c.stdout === "") expect(r.stdout).toBe("");
  else expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(c.stdout);
  if (c.stderr === "") expect(r.stderr).toBe("");
  else expect(r.stderr).toMatch(ERROR_LINE);
}

describe.skipIf(!distBuilt).each(["init", "plugin"] as const)("#546 characterization (%s copy)", (copy) => {
  it.each(CASES.filter((c) => copy === "init" || !c.initOnly))("$name", (c) => {
    const { root, script, input } = arrange(copy, c);
    const r = run(script, root, input);
    assertPinned(c, r);
    // Step 1 pinned "no trace". Step 2: the decision is unchanged (no fire is
    // recorded for a no-fire), and the fault now leaves exactly one entry.
    const state = readState(root) ?? {};
    if (c.stdout === "") expect(state.fires).toBeUndefined();
    else expect(Object.keys(state).sort()).toEqual(["fires", "guardrailAsks", "preflightFailures", "version"]);
    expectDiag(root, c.diag);
  });

  it.each(CONTROLS)("$name", (c) => {
    const { root, script, input } = arrange(copy, c);
    assertPinned(c, run(script, root, input));
    expectDiag(root, null); // an expected non-match or absent input is not a fault
  });

  it("C15 a hook killed before stdin ends (a harness timeout) emits nothing and records nothing", async () => {
    const root = makeProject();
    const script = scriptFor(copy, root);
    const child = spawn(process.execPath, [script], { cwd: root, env: hookEnv(root), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stdin.write(write(root).slice(0, 20)); // never ended
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGKILL");
    await new Promise((r) => child.on("close", r));
    expect(stdout).toBe("");
    expect(readState(root)).toBeNull();
  });
});

describe.skipIf(!distBuilt || !hasGit)("#546 characterization: init copy inside a linked worktree", () => {
  it("C16 the rule leaf import fails: the worktree is not canonicalised and the main ledger is never read", () => {
    const repo = path.join(base, `wt-main-${++n}`);
    const wt = path.join(base, `wt-link-${n}`);
    const gitEnv: NodeJS.ProcessEnv = { ...process.env, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(base, "gitconfig") };
    for (const k of Object.keys(gitEnv)) if (k.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(k)) delete gitEnv[k];
    fs.writeFileSync(path.join(base, "gitconfig"), "");
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=dp", "-c", "user.email=dp@example.invalid", ...args], { cwd, env: gitEnv, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "worktree", "add", "-q", wt, "-b", "feature");
    fs.mkdirSync(path.join(repo, ".deeppairing", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".deeppairing", "preferences.json"), JSON.stringify({
      rejectedApproaches: [{ description: REJECTED, reason: "Keep configuration explicit" }],
    }));
    expect(ensurePreflightHook(wt).ok).toBe(true);
    const script = path.join(wt, ".deeppairing", "hooks", "preflight.mjs");
    const intact = run(script, wt, write(wt));
    expect(JSON.parse(intact.stdout).hookSpecificOutput.permissionDecision).toBe("ask"); // control: the main ledger gates
    fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace(/const RULES_URL = "[^"]+";/, `const RULES_URL = ${JSON.stringify("file://" + path.join(wt, "missing-rules.js"))};`));
    const broken = run(script, wt, write(wt));
    expect(broken.status).toBe(0);
    expect(broken.stdout).toBe("");
    expect(broken.stderr).toBe("");
    expectDiag(wt, ["matcher_import_failed", "rules:ERR_MODULE_NOT_FOUND"]);
  });
});

/**
 * #546 — the SIDE-BY-SIDE proof: every case above, in three modes, through a
 * baseline build (main's committed plugin bundle and main's generated init
 * hook) and through this tree, on the same project, compared byte for byte on
 * stdout, stderr and exit status. Opt-in because it needs a baseline build on
 * disk: DP_PREFLIGHT_BASELINE_DIR=<dir> containing `plugin/preflight.mjs` (with
 * its sibling preflight-hook-core.js + guardrail-rules.js) and
 * `init-preflight.mjs` (main's generated hook, stamped at those siblings).
 */
const BASELINE = process.env.DP_PREFLIGHT_BASELINE_DIR;
describe.skipIf(!distBuilt || !BASELINE).each(["init", "plugin"] as const)("#546 byte-identical vs baseline (%s copy)", (copy) => {
  const modes: Array<string | undefined> = [undefined, "strict-stop", "bogus-mode"];
  const rows = [...CASES, ...CONTROLS]
    .filter((c) => copy === "init" || !c.initOnly)
    .flatMap((c) => modes.map((mode) => ({ c, mode, label: `${c.name} [mode=${mode ?? "unset"}]` })));
  it.each(rows)("$label", ({ c, mode }) => {
    const root = makeProject();
    const current = scriptFor(copy, root);
    const patch = (src: string) => (c.patchScript ? c.patchScript(src, root) : src);
    // The init copy runs from ONE path (its own filename appears in Node's
    // import errors): the baseline text goes there first, then this tree's.
    const currentText = copy === "init" ? patch(fs.readFileSync(current, "utf8")) : "";
    const baseline = copy === "init" ? current : path.join(BASELINE!, "plugin", "preflight.mjs");
    if (copy === "init") fs.writeFileSync(current, patch(fs.readFileSync(path.join(BASELINE!, "init-preflight.mjs"), "utf8")));
    const input = c.setup(root);
    const extra: Record<string, string> = mode === undefined ? {} : { DEEPPAIRING_PREFLIGHT_MODE: mode };
    const clear = () => {
      for (const f of fs.readdirSync(path.join(root, ".deeppairing"))) {
        if (f.startsWith("hooks-state.json")) fs.rmSync(path.join(root, ".deeppairing", f), { force: true });
      }
    };
    const before = run(baseline, root, input, extra);
    clear();
    if (copy === "init") fs.writeFileSync(current, currentText);
    const after = run(current, root, input, extra);
    expect(after).toEqual(before);
  });
});
