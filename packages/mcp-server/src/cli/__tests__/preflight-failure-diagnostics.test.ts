/**
 * #546 — the failure diagnostics themselves: taxonomy, bounds, redaction,
 * isolation, concurrency, legacy preservation, and doctor's mode provenance.
 *
 * Real files and real hook processes (the plugin entry bundled from source with
 * esbuild); no mocks. The per-path pins live in
 * preflight-failure-characterization.test.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPreflightFailures,
  failureCode,
  noteFailure,
  PREFLIGHT_FAILURE_CLASSES,
  PREFLIGHT_FAILURE_COUNT_CAP,
  readPreflightFailures,
  recordPreflightFailures,
} from "../../hooks/preflight-diagnostics.js";
import { appendHookFire, hookStatePath } from "../../hooks/hook-state.js";
import { buildPreflightDoctorReport, classifyModeValue, preflightDoctorLines } from "../preflight-doctor.js";
import { resolvePreflightMode } from "../preflight-hook-core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..", "..");
const SECRET = "sk-ant-api03-DO-NOT-RECORD-THIS-0123456789";

let base = "";
let pluginHook = "";
let n = 0;

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-546-diag-")));
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

function project(prefs: unknown = { rejectedApproaches: [{ description: "global mutable state", reason: "explicit" }] }): string {
  const root = path.join(base, `p${++n}`);
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions", "s1"), { recursive: true });
  fs.writeFileSync(path.join(root, ".deeppairing", "sessions", "s1", "artifacts.json"), "[]");
  if (prefs !== undefined) {
    fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), typeof prefs === "string" ? prefs : JSON.stringify(prefs));
  }
  return root;
}

function env(root: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: base, FORCE_COLOR: "0", NO_COLOR: "1", CLAUDE_PROJECT_DIR: root };
  delete e.DEEPPAIRING_PROJECT_ROOT;
  delete e.DEEPPAIRING_PREFLIGHT_MODE;
  delete e.DEEPPAIRING_GUARDRAIL_BACKSTOP;
  return e;
}

function event(root: string, extra: Record<string, unknown> = {}, content = "global mutable state"): string {
  return JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(root, "src", "a.ts"), content }, ...extra });
}

function runSync(root: string, input: string) {
  const r = spawnSync(process.execPath, [pluginHook], { cwd: root, env: env(root), input, encoding: "utf8", timeout: 15_000 });
  expect(r.status, r.stderr).toBe(0);
  return r;
}

function runAsync(root: string, input: string): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [pluginHook], { cwd: root, env: env(root), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", (status) => resolve({ stdout, status }));
    child.stdin.end(input);
  });
}

function stateText(root: string): string {
  return fs.readFileSync(hookStatePath(root), "utf8");
}
function failures(root: string): Record<string, { count: number; detail: string }> {
  return JSON.parse(stateText(root)).preflightFailures;
}

describe("#546 taxonomy", () => {
  it("is a small fixed set with no nonmatch class", () => {
    expect([...PREFLIGHT_FAILURE_CLASSES]).toEqual([
      "input_malformed", "ledger_unreadable", "ledger_corrupt", "ledger_entry_invalid", "matcher_import_failed", "evaluator_threw", "session_store_unreadable",
    ]);
  });

  it("classifies faults and treats absence as not-a-fault", () => {
    const enoent = Object.assign(new Error("no such file /secret/path"), { code: "ENOENT" });
    const eacces = Object.assign(new Error("denied /secret/path"), { code: "EACCES" });
    let syntax: unknown;
    try { JSON.parse(`{ ${SECRET}`); } catch (e) { syntax = e; }
    expect(noteFailure("ledger", "preferences", enoent)).toBeNull();
    expect(noteFailure("ledger", "preferences", eacces)).toEqual({ cls: "ledger_unreadable", source: "preferences", tag: "EACCES" });
    expect(noteFailure("ledger", "team", syntax)).toEqual({ cls: "ledger_corrupt", source: "team", tag: "SyntaxError" });
    expect(noteFailure("schema", "team")).toEqual({ cls: "ledger_corrupt", source: "team", tag: "schema" });
    expect(noteFailure("store", "sessions", eacces)).toEqual({ cls: "session_store_unreadable", source: "sessions", tag: "EACCES" });
    expect(noteFailure("import", "core", Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" })))
      .toEqual({ cls: "matcher_import_failed", source: "core", tag: "ERR_MODULE_NOT_FOUND" });
    expect(noteFailure("evaluate", "matcher", new TypeError(SECRET))).toEqual({ cls: "evaluator_threw", source: "matcher", tag: "TypeError" });
  });

  it("never takes a message: an unusable code or name collapses to Error", () => {
    expect(failureCode({ code: `${SECRET} with spaces` })).toBe("Error");
    expect(failureCode({ name: "x".repeat(200) })).toBe("Error");
    expect(failureCode("plain string")).toBe("Error");
    expect(failureCode(null)).toBe("Error");
  });
});

describe("#546 bounded record", () => {
  it("counts once per class per invocation, saturates, and keeps firstAt", () => {
    const state: Record<string, unknown> = {};
    const note = { cls: "ledger_corrupt" as const, source: "preferences" as const, tag: "SyntaxError" };
    applyPreflightFailures(state, [note, note, note], Date.parse("2026-01-01T00:00:00Z"));
    applyPreflightFailures(state, [note], Date.parse("2026-01-02T00:00:00Z"));
    expect(readPreflightFailures(state)).toEqual({
      ledger_corrupt: { count: 2, firstAt: "2026-01-01T00:00:00.000Z", lastAt: "2026-01-02T00:00:00.000Z", detail: "preferences:SyntaxError" },
    });
    (state.preflightFailures as Record<string, { count: number }>).ledger_corrupt.count = PREFLIGHT_FAILURE_COUNT_CAP;
    applyPreflightFailures(state, [note], Date.now());
    expect(readPreflightFailures(state).ledger_corrupt!.count).toBe(PREFLIGHT_FAILURE_COUNT_CAP);
  });

  it("drops hand-edited garbage: unknown classes, huge details, bad timestamps", () => {
    const junk: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) junk[`class_${i}`] = { count: 1, firstAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-01T00:00:00Z", detail: "x" };
    junk.ledger_corrupt = { count: 3, firstAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-01T00:00:00Z", detail: SECRET + "x".repeat(100_000) };
    junk.evaluator_threw = { count: 2, firstAt: "not a date", lastAt: "2026-01-01T00:00:00Z", detail: "matcher:TypeError" };
    const state: Record<string, unknown> = { preflightFailures: junk };
    applyPreflightFailures(state, [{ cls: "input_malformed", source: "stdin", tag: "SyntaxError" }], Date.now());
    const field = state.preflightFailures as Record<string, { detail: string }>;
    expect(Object.keys(field).sort()).toEqual(["input_malformed", "ledger_corrupt"]);
    expect(field.ledger_corrupt.detail).toBe("hook:Error");
    expect(JSON.stringify(field).length).toBeLessThan(1_000);
  });

  it("never creates .deeppairing/ for a root that has none", () => {
    const bare = path.join(base, `bare-${++n}`);
    fs.mkdirSync(bare);
    recordPreflightFailures(bare, [{ cls: "input_malformed", source: "stdin", tag: "shape" }]);
    expect(fs.existsSync(path.join(bare, ".deeppairing"))).toBe(false);
    // ...and a real hook run against it (malformed input) leaves nothing either.
    const r = spawnSync(process.execPath, [pluginHook], { cwd: bare, env: env(bare), input: "{ nope", encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(bare, ".deeppairing"))).toBe(false);
  });
});

describe("#546 redaction", () => {
  it("records no ledger content, tool input, path, session id or env value", () => {
    const root = project(`{ "rejectedApproaches": [ "${SECRET}" `); // unparseable, quoting the secret
    fs.writeFileSync(path.join(root, ".deeppairing", "team.json"), `{ "token": "${SECRET}" `);
    const r = runSync(root, event(root, { session_id: "sess-PRIVATE-123", transcript_path: `/home/u/${SECRET}.jsonl` }, `const key = "${SECRET}";`));
    expect(r.stdout).toBe("");
    const text = stateText(root);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("sess-PRIVATE-123");
    expect(text).not.toContain(root);
    expect(Object.keys(failures(root))).toEqual(["ledger_corrupt"]);
    // A malformed event that embeds a secret is recorded by class only.
    runSync(root, `{"tool_name":"Write","tool_input":{"content":"${SECRET}"`);
    expect(stateText(root)).not.toContain(SECRET);
    expect(failures(root).input_malformed).toMatchObject({ count: 1, detail: "stdin:SyntaxError" });
  });
});

describe("#546 isolation", () => {
  it("a failure lands only in the hook's own project, and sessions share no identifiers", () => {
    const a = project("{ corrupt");
    const b = project();
    const bBefore = fs.existsSync(hookStatePath(b)) ? stateText(b) : null;
    runSync(a, event(a, { session_id: "session-one" }));
    runSync(a, event(a, { session_id: "session-two", cwd: b })); // a foreign cwd does not redirect it
    expect(failures(a).ledger_corrupt.count).toBe(2);
    expect(stateText(a)).not.toMatch(/session-one|session-two/);
    expect(fs.existsSync(hookStatePath(b)) ? stateText(b) : null).toBe(bBefore);
    // B's genuine match still asks, with no failure recorded there.
    const out = runSync(b, event(b));
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    expect(JSON.parse(stateText(b)).preflightFailures).toBeUndefined();
  });
});

describe("#546 legacy records", () => {
  it("leaves fires, dedup stamps, #552 gate details and unknown fields exactly as they were", () => {
    const root = project("{ corrupt");
    const legacy = {
      version: 1,
      fires: [
        { at: "2026-01-01T00:00:00.000Z", hook: "stop", exitCode: 2 },
        { at: "2026-01-01T00:00:01.000Z", hook: "preflight", kind: "ask", reason: "session", id: "f1", gate: { decision: "ask", concept: "x" } },
      ],
      guardrailAsks: { workflows: "2026-01-01T00:00:00.000Z" },
      someFutureField: { keep: true },
    };
    fs.writeFileSync(hookStatePath(root), JSON.stringify(legacy));
    runSync(root, event(root));
    const after = JSON.parse(stateText(root));
    expect({ ...after, preflightFailures: undefined }).toEqual({ ...legacy, preflightFailures: undefined });
    expect(after.preflightFailures.ledger_corrupt.count).toBe(1);
    // and a later fire append keeps the diagnostics field
    appendHookFire(hookStatePath(root), { at: "2026-01-02T00:00:00.000Z", hook: "stop", exitCode: 0 });
    expect(JSON.parse(stateText(root)).preflightFailures.ledger_corrupt.count).toBe(1);
  });
});

describe("#546 concurrency", () => {
  it("parallel hooks writing fires and diagnostics leave valid JSON and lose no update", async () => {
    // A seeded stance (every run fires) beside a corrupt team file (every run notes).
    const root = project();
    fs.writeFileSync(path.join(root, ".deeppairing", "team.json"), "{ corrupt team");
    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => runAsync(root, event(root, { session_id: `claude-session-${i % 2}` }))));
    for (const r of results) {
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    }
    const state = JSON.parse(stateText(root)); // valid JSON
    expect(state.fires).toHaveLength(N);
    // #552's companion-gate record and session attribution ride every fire,
    // beside #546's separate failure field.
    for (const fire of state.fires) {
      expect(fire).toMatchObject({ hook: "preflight", kind: "ask", id: expect.any(String), gate: expect.objectContaining({ decision: "ask" }) });
      expect(["claude-session-0", "claude-session-1"]).toContain(fire.gate.session);
    }
    expect(new Set(state.fires.map((f: { id: string }) => f.id)).size).toBe(N);
    expect(state.preflightFailures).toEqual({
      ledger_corrupt: { count: N, firstAt: expect.any(String), lastAt: expect.any(String), detail: "team:SyntaxError" },
    });
    expect(fs.readdirSync(path.join(root, ".deeppairing")).filter((f) => f.includes(".tmp.") || f.endsWith(".lock"))).toEqual([]);
  });
});

describe("#546 doctor: failures and mode provenance", () => {
  function doctorProject(): { root: string; home: string } {
    const root = project();
    const home = path.join(base, `home-${++n}`);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    return { root, home };
  }

  it("classifies a mode value exactly like the hook does", () => {
    for (const v of [undefined, "", "ask", "strict-stop", "ASK", " strict-stop", "x"]) {
      const r = classifyModeValue(v);
      const hook = resolvePreflightMode(v);
      if (v === undefined) expect(r.kind).toBe("unset");
      else expect(r.kind).toBe(hook.invalid ? "invalid" : hook.mode);
    }
    expect(classifyModeValue(42).kind).toBe("invalid");
  });

  it("reports each source labelled, flags invalid without echoing it, and disclaims the hook's env", () => {
    const { root, home } = doctorProject();
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { DEEPPAIRING_PREFLIGHT_MODE: "strict-stop" } }));
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ env: { OTHER: "1" } }));
    fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ env: { DEEPPAIRING_PREFLIGHT_MODE: `UNTRUSTED_${SECRET}` } }));
    const report = buildPreflightDoctorReport(root, { homeDir: home, env: { DEEPPAIRING_PREFLIGHT_MODE: "ask" } });
    expect(report.modes.map((m) => [m.label, m.reading.kind])).toEqual([
      ["settings env, user", "strict-stop"],
      ["settings env, project", "unset"],
      ["settings env, local", "invalid"],
      ["doctor's own shell", "ask"],
    ]);
    expect(report.anyInvalidMode).toBe(true);
    const text = JSON.stringify(preflightDoctorLines(report));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("UNTRUSTED_");
    expect(text).toContain("INVALID value (not shown)");
    expect(text).toContain("cannot see the hook's effective value");
    expect(text).not.toMatch(/effective mode is|effective: /i);
  });

  it("treats missing and unreadable settings files honestly", () => {
    const { root, home } = doctorProject();
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{ not json");
    const report = buildPreflightDoctorReport(root, { homeDir: home, env: {} });
    expect(report.modes.map((m) => m.reading.kind)).toEqual(["no-file", "unreadable", "no-file", "unset"]);
    expect(report.anyInvalidMode).toBe(false);
  });

  it("reports recorded failures by class and count, and only from this project", () => {
    const { root, home } = doctorProject();
    const other = project("{ corrupt");
    runSync(other, event(other));
    expect(buildPreflightDoctorReport(root, { homeDir: home, env: {} }).failures).toEqual([]);
    expect(preflightDoctorLines(buildPreflightDoctorReport(root, { homeDir: home, env: {} }))[0]).toMatchObject({ mark: "ok", text: "No preflight failures recorded" });
    fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: [{ description: "x y z", concept: 42 }] }));
    runSync(root, event(root));
    runSync(root, event(root));
    runSync(root, "not json");
    const report = buildPreflightDoctorReport(root, { homeDir: home, env: {} });
    expect(report.failures.map((f) => [f.cls, f.entry.count, f.entry.detail])).toEqual([
      ["input_malformed", 1, "stdin:SyntaxError"],
      ["ledger_entry_invalid", 2, "preferences:concept"],
    ]);
    const [first] = preflightDoctorLines(report);
    expect(first.mark).toBe("warn");
    expect(first.details.join("\n")).toContain("ledger_entry_invalid ×2 (preferences:concept, entries 0;");
  });

  it("describes an invalid entry's limited effect without claiming the check failed open", () => {
    const { root, home } = doctorProject();
    fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: [{ description: "x y z", concept: 42 }] }));
    runSync(root, event(root, {}, "unrelated change"));
    const [first] = preflightDoctorLines(buildPreflightDoctorReport(root, { homeDir: home, env: {} }));
    expect(first.text).toBe("Preflight issues recorded. See each class below for its effect on the check.");
    expect(first.text).not.toContain("failed open");
    expect(first.details.join("\n")).toContain("ledger_entry_invalid ×1");
    expect(first.details.join("\n")).toContain("it was ignored, so the entry matched on its description, or the entry was skipped if nothing usable remained. Every other stance still enforced.");
  });

  it("keeps aggregate copy neutral when recorded issues have different effects", () => {
    const { root, home } = doctorProject();
    fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: [{ description: "x y z", concept: 42 }] }));
    runSync(root, event(root, {}, "unrelated change"));
    runSync(root, "not json");
    const [first] = preflightDoctorLines(buildPreflightDoctorReport(root, { homeDir: home, env: {} }));
    const details = first.details.join("\n");
    expect(first.text).toBe("Preflight issues recorded. See each class below for its effect on the check.");
    expect(first.text).not.toContain("failed open");
    expect(details).toContain("ledger_entry_invalid ×1");
    expect(details).toContain("Every other stance still enforced.");
    expect(details).toContain("input_malformed ×1");
    expect(details).toContain("so no check ran for it.");
  });

  it("is read-only, even over a corrupt hooks-state", () => {
    const { root, home } = doctorProject();
    fs.writeFileSync(hookStatePath(root), "{ torn");
    const before = fs.readdirSync(path.join(root, ".deeppairing")).sort();
    expect(buildPreflightDoctorReport(root, { homeDir: home, env: {} }).failures).toEqual([]);
    expect(fs.readdirSync(path.join(root, ".deeppairing")).sort()).toEqual(before);
    expect(stateText(root)).toBe("{ torn");
  });

  it("names a stamped module URL that points at nothing", () => {
    const { root, home } = doctorProject();
    fs.mkdirSync(path.join(root, ".deeppairing", "hooks"), { recursive: true });
    const missing = path.join(root, "gone", "preflight-hook-core.js");
    fs.writeFileSync(path.join(root, ".deeppairing", "hooks", "preflight.mjs"),
      `const CORE_URL = ${JSON.stringify("file://" + missing)};\nconst RULES_URL = ${JSON.stringify("file://" + pluginHook)};\n`);
    const report = buildPreflightDoctorReport(root, { homeDir: home, env: {} });
    expect(report.missingStamps).toEqual([{ name: "CORE_URL", path: missing }]);
  });
});
