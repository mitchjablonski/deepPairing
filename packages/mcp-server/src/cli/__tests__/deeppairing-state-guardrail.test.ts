/**
 * #470 slice 4 — the `deeppairing-state` guardrail class (design
 * stance-exceptions.md §"Direct file edits", §10 row 7).
 *
 * An agent Edit/Write/MultiEdit/NotebookEdit to `.deeppairing/preferences.json`,
 * `.deeppairing/team.json` or `.deeppairing/hooks/*` ALWAYS asks: with a live
 * ceremony, inside the dedup window, and with the backstop opt-out set. Path
 * variants don't get past it; the other `.deeppairing` files deepPairing and
 * the agent legitimately write don't trip it. Driven through the real hook
 * launch (the init-generated script and the plugin bundle) with fixture HOMEs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEPPAIRING_STATE_CATEGORY,
  GUARDRAIL_ASK_TTL_MS,
  GUARDRAIL_BACKSTOP_ENV,
  evaluatePreflightHook,
  matchDeeppairingStatePath,
  readHookState,
  recordHookFire,
} from "../preflight-hook-core.js";
import { PREFLIGHT_MATCHER, diagnoseLocalHooks, ensurePreflightHook } from "../setup-tasks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginBundle = path.resolve(here, "../../../../../claude-plugin/server/preflight.mjs");
const distCore = path.resolve(here, "../../../dist/cli/preflight-hook-core.js");

let parent: string;
let dir: string;
let home: string;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const recent = new Date(NOW - 60_000).toISOString();

beforeEach(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-state-")));
  dir = path.join(parent, "project");
  home = path.join(parent, "home");
  fs.mkdirSync(path.join(dir, ".deeppairing", "hooks"), { recursive: true });
  fs.mkdirSync(home);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  fs.writeFileSync(path.join(dir, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: [] }));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(parent, { recursive: true, force: true });
});

const decide = (toolName: string, toolInput: unknown, env: Record<string, string | undefined> = {}) =>
  evaluatePreflightHook({ toolName, toolInput, projectRoot: dir, now: NOW, env });

/** Every spelling here names a guarded file (kind in the second column). */
function evasionCorpus(): Array<[string, string]> {
  const abs = (rel: string) => path.join(dir, rel);
  const winAbs = (rel: string) => abs(rel).replace(/\//g, "\\");
  fs.symlinkSync(path.join(dir, ".deeppairing"), path.join(dir, "state-link"));
  fs.symlinkSync(path.join(dir, ".deeppairing", "preferences.json"), path.join(dir, "notes.json"));
  fs.symlinkSync(dir, path.join(parent, "alias"));
  return [
    [".deeppairing/preferences.json", "preferences"],
    ["./.deeppairing/preferences.json", "preferences"],
    [abs(".deeppairing/preferences.json"), "preferences"],
    ["src/../.deeppairing/preferences.json", "preferences"],
    ["src/deep/../../.deeppairing/team.json", "team"],
    [".deeppairing/./team.json", "team"],
    [".deeppairing//preferences.json", "preferences"],
    [".deeppairing\\preferences.json", "preferences"],
    [winAbs(".deeppairing/team.json"), "team"],
    ["\\\\?\\" + winAbs(".deeppairing/team.json"), "team"],
    ["//?/" + abs(".deeppairing/team.json"), "team"],
    [".DeepPairing/Preferences.JSON", "preferences"],
    [".DEEPPAIRING\\TEAM.JSON", "team"],
    [".deeppairing/preferences.json.", "preferences"],
    [".deeppairing/preferences.json ", "preferences"],
    [".deeppairing./team.json", "team"],
    [".deeppairing /team.json", "team"],
    [".deeppairing/preferences.json::$DATA", "preferences"],
    [".deeppairing/team.json:stream", "team"],
    ["state-link/preferences.json", "preferences"],
    ["state-link/team.json", "team"], // doesn't exist yet: realpath of the ancestor
    ["notes.json", "preferences"], // a symlink to the file itself
    [path.join(parent, "alias", ".deeppairing", "team.json"), "team"],
    ["~/.deeppairing/preferences.json", "preferences"],
    ["packages/api/.deeppairing/team.json", "team"],
    [".deeppairing/hooks/stance-allow-ask.sh", "hooks"],
    [".deeppairing/hooks/preflight.mjs", "hooks"],
    [".deeppairing/hooks/stop.mjs", "hooks"],
    [".deeppairing\\hooks\\Stance-Allow-Ask.SH", "hooks"],
  ];
}

/** deepPairing's own writers and the agent's legitimate edits (the PR-review
 *  worktree under .deeppairing/pr-review, per commands/review-pr.md). */
const LEGIT = [
  ".deeppairing/sessions/s1/artifacts.json",
  ".deeppairing/sessions/s1/comments.json",
  ".deeppairing/hooks-state.json",
  ".deeppairing/daemon.json",
  ".deeppairing/preferences.json.bak",
  ".deeppairing/team.json.example",
  ".deeppairing/pr-review/12/src/app.ts",
  ".deeppairing/pr-review/12/README.md",
  ".deeppairing/hooks",
  "src/preferences.json",
  "team.json",
  "deeppairing/team.json",
  ".deeppairing-old/team.json",
  "docs/.deeppairing.md",
  "src/hooks/preflight.mjs",
];

describe("the matcher: path variants don't get past it", () => {
  it("every spelling in the evasion corpus matches, with the right kind", () => {
    for (const [spelling, kind] of evasionCorpus()) {
      expect(matchDeeppairingStatePath(dir, spelling), spelling).toMatchObject({ category: DEEPPAIRING_STATE_CATEGORY, kind });
    }
  });

  it("names the project-relative path to the human", () => {
    expect(matchDeeppairingStatePath(dir, path.join(dir, ".deeppairing", "team.json"))?.path).toBe(".deeppairing/team.json");
    expect(matchDeeppairingStatePath(dir, "src/../.deeppairing/preferences.json")?.path).toBe(".deeppairing/preferences.json");
  });

  it("no false positives on the other .deeppairing files, or on look-alikes", () => {
    for (const rel of LEGIT) {
      expect(matchDeeppairingStatePath(dir, rel), rel).toBeNull();
      expect(decide("Write", { file_path: path.join(dir, rel), content: "x" }), rel).toEqual({ fire: false });
    }
  });

  it("garbage in is no match, never a throw", () => {
    for (const raw of [undefined, null, 7, {}, "", "\0", "C:", "\\\\?\\"]) {
      expect(() => matchDeeppairingStatePath(dir, raw)).not.toThrow();
    }
  });
});

describe("always asks: ceremony, dedup and the opt-out don't reach it", () => {
  const target = () => ({ file_path: path.join(dir, ".deeppairing", "preferences.json"), old_string: "a", new_string: "b" });

  it("asks for Edit, Write, MultiEdit and NotebookEdit, with the class-specific wording", () => {
    for (const [tool, input] of [
      ["Edit", target()],
      ["Write", { file_path: ".deeppairing/team.json", content: "{}" }],
      ["MultiEdit", { file_path: ".deeppairing/hooks/stance-allow-ask.sh", edits: [{ old_string: "a", new_string: "b" }] }],
      ["NotebookEdit", { notebook_path: ".deeppairing/preferences.json", new_source: "x" }],
    ] as const) {
      const d = decide(tool, input);
      expect(d, tool).toMatchObject({ fire: true, guardrail: { category: DEEPPAIRING_STATE_CATEGORY } });
      expect(d.reason).toMatch(/^Allow this edit to \.deeppairing\/.+\? It's deepPairing's own state\./);
      expect(d.reason).toContain("[DEEPPAIRING_STATE");
    }
  });

  it("asks with a LIVE ceremony in the project", () => {
    const sd = path.join(dir, ".deeppairing", "sessions", "s1");
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "artifacts.json"), JSON.stringify([{ id: "spec-1", type: "spec", status: "approved", createdAt: recent }]));
    // Control: the same ceremony silences an ordinary guardrail path.
    expect(decide("Write", { file_path: path.join(dir, ".github/workflows/ci.yml"), content: "x" })).toEqual({ fire: false });
    expect(decide("Edit", target())).toMatchObject({ fire: true });
  });

  it("asks inside the dedup window, every time, and never stamps one", () => {
    for (let i = 0; i < 3; i++) {
      const d = decide("Edit", target());
      expect(d.fire).toBe(true);
      recordHookFire(dir, d, NOW + i * 1000);
    }
    const state = readHookState(path.join(dir, ".deeppairing", "hooks-state.json")) as { guardrailAsks?: Record<string, unknown>; fires?: Array<{ reason: string }> };
    expect(state.guardrailAsks?.[DEEPPAIRING_STATE_CATEGORY]).toBeUndefined();
    expect(state.fires?.filter((f) => f.reason === `guardrail:${DEEPPAIRING_STATE_CATEGORY}`)).toHaveLength(3);
    // Even a hand-planted stamp inside the window doesn't suppress it.
    fs.writeFileSync(
      path.join(dir, ".deeppairing", "hooks-state.json"),
      JSON.stringify({ guardrailAsks: { [DEEPPAIRING_STATE_CATEGORY]: new Date(NOW - GUARDRAIL_ASK_TTL_MS / 2).toISOString() } }),
    );
    expect(decide("Edit", target()).fire).toBe(true);
  });

  it("asks with the guardrail backstop switched off (that opt-out is for the backstop only)", () => {
    expect(decide("Write", { file_path: ".github/workflows/ci.yml", content: "x" }, { [GUARDRAIL_BACKSTOP_ENV]: "off" })).toEqual({ fire: false });
    expect(decide("Edit", target(), { [GUARDRAIL_BACKSTOP_ENV]: "off" }).fire).toBe(true);
  });

  it("one prompt when the rejected-approach gate also fires: its message leads, the state note follows", () => {
    fs.writeFileSync(
      path.join(dir, ".deeppairing", "preferences.json"),
      JSON.stringify({ rejectedApproaches: [{ description: "global mutable singleton", concept: "global mutable singleton" }] }),
    );
    const d = decide("Write", { file_path: ".deeppairing/preferences.json", content: "use a global mutable singleton" });
    expect(d.fire).toBe(true);
    expect(d.reason).toMatch(/^REJECTED_APPROACH_BLOCKED/);
    expect(d.reason).toContain("It's deepPairing's own state.");
    expect(d.reason!.match(/Allow this edit/g)).toHaveLength(1);
  });

  it("NotebookEdit stays out of every other gate (no behaviour change there)", () => {
    expect(decide("NotebookEdit", { notebook_path: path.join(dir, "migrations", "x.ipynb"), new_source: "x" })).toEqual({ fire: false });
  });
});

// ---------------------------------------------------------------------------
// The real launch: the init-generated hook and the plugin bundle, spawned
// through /bin/sh with a fixture HOME.
// ---------------------------------------------------------------------------
function launch(command: string, payload: unknown) {
  const r = spawnSync("/bin/sh", ["-c", command], {
    cwd: parent,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: dir, FORCE_COLOR: "0", [GUARDRAIL_BACKSTOP_ENV]: "" },
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(r.status, r.stderr).toBe(0);
  if (!r.stdout.trim()) return null;
  return JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
}

const launchers = [
  ["init-generated .deeppairing/hooks/preflight.mjs", () => {
    expect(ensurePreflightHook(dir).ok).toBe(true);
    return JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
  }, fs.existsSync(distCore)],
  ["plugin bundle server/preflight.mjs", () => `node "${pluginBundle}"`, fs.existsSync(pluginBundle)],
] as const;

describe.each(launchers)("real hook launch: %s", (_name, install, built) => {
  it.skipIf(!built)("asks on the evasion corpus, stays silent on the legitimate files, in a ledger-free project", () => {
    const command = install();
    fs.rmSync(path.join(dir, ".deeppairing", "preferences.json")); // no ledger: the fast path must still let it through
    const corpus = evasionCorpus().filter(([s]) => !s.startsWith("~")); // HOME differs per launcher; covered in-process
    for (const [spelling] of corpus) {
      const out = launch(command, { tool_name: "Write", tool_input: { file_path: spelling, content: "{}" } });
      expect(out?.hookSpecificOutput.permissionDecision, spelling).toBe("ask");
      expect(out?.hookSpecificOutput.permissionDecisionReason).toContain("deepPairing's own state");
    }
    const nb = launch(command, { tool_name: "NotebookEdit", tool_input: { notebook_path: ".deeppairing/team.json", new_source: "x" } });
    expect(nb?.hookSpecificOutput.permissionDecision).toBe("ask");
    for (const rel of LEGIT) {
      expect(launch(command, { tool_name: "Write", tool_input: { file_path: rel, content: "x" } }), rel).toBeNull();
    }
  }, 120_000);

  it.skipIf(!built)("asks with a live ceremony and inside the dedup window (twice in a row)", () => {
    const command = install();
    const sd = path.join(dir, ".deeppairing", "sessions", "s1");
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "artifacts.json"), JSON.stringify([{ id: "plan-1", type: "plan", status: "approved", createdAt: new Date().toISOString() }]));
    for (let i = 0; i < 2; i++) {
      const out = launch(command, { tool_name: "Edit", tool_input: { file_path: ".deeppairing/preferences.json", old_string: "[]", new_string: "[1]" } });
      expect(out?.hookSpecificOutput.permissionDecision).toBe("ask");
    }
  }, 60_000);
});

describe("install, idempotence and doctor", () => {
  it("installs the NotebookEdit-aware matcher and is idempotent", () => {
    expect(PREFLIGHT_MATCHER).toBe("Write|Edit|MultiEdit|NotebookEdit");
    expect(ensurePreflightHook(dir)).toMatchObject({ ok: true, changed: true });
    expect(ensurePreflightHook(dir)).toMatchObject({ ok: true, changed: false });
    const rows = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8")).hooks.PreToolUse;
    expect(rows).toHaveLength(1);
    expect(rows[0].matcher).toBe(PREFLIGHT_MATCHER);
    expect(diagnoseLocalHooks(dir, false).find((d) => d.hook === "PreToolUse")?.state).toBe("ok");
  });

  it("an older row without NotebookEdit is 'legacy' to doctor, and the install upgrades it in place", () => {
    expect(ensurePreflightHook(dir).ok).toBe(true);
    const sp = path.join(dir, ".claude", "settings.local.json");
    const settings = JSON.parse(fs.readFileSync(sp, "utf8"));
    settings.hooks.PreToolUse[0].matcher = "Write|Edit|MultiEdit";
    settings.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "my-own-audit" }] });
    fs.writeFileSync(sp, JSON.stringify(settings));
    expect(diagnoseLocalHooks(dir, false).find((d) => d.hook === "PreToolUse")?.state).toBe("legacy");
    expect(ensurePreflightHook(dir)).toMatchObject({ ok: true, changed: true });
    const rows = JSON.parse(fs.readFileSync(sp, "utf8")).hooks.PreToolUse;
    expect(rows.map((r: { matcher: string }) => r.matcher).sort()).toEqual(["Bash", PREFLIGHT_MATCHER]);
    expect(diagnoseLocalHooks(dir, false).find((d) => d.hook === "PreToolUse")?.state).toBe("ok");
    // Plugin-managed: the plugin's hooks.json carries the row, so a local one is still just redundant.
    expect(diagnoseLocalHooks(dir, true).find((d) => d.hook === "PreToolUse")?.state).toBe("redundant");
  });

  it("the plugin's hooks.json matches NotebookEdit on the preflight row", () => {
    const hooks = JSON.parse(fs.readFileSync(path.resolve(here, "../../../../../claude-plugin/hooks/hooks.json"), "utf8")).hooks;
    expect(hooks.PreToolUse[0].matcher).toBe(PREFLIGHT_MATCHER);
  });
});
