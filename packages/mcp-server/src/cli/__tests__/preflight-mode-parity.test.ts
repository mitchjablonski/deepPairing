import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalProjectDir } from "../../git-worktree.js";
import { ensurePreflightHook } from "../setup-tasks.js";
import { evaluatePreflightHook, PREFLIGHT_MODE_WARNING, resolvePreflightMode, sanitizeStrictReason } from "../preflight-hook-core.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const plugin = path.join(repoRoot, "claude-plugin/server/preflight.mjs");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture(copy: "init" | "plugin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-strict-hook-"));
  roots.push(root);
  expect(canonicalProjectDir(root).projectRoot).toBe(path.resolve(root));
  fs.mkdirSync(path.join(root, ".deeppairing/sessions/s1"), { recursive: true });
  fs.writeFileSync(path.join(root, ".deeppairing/sessions/s1/artifacts.json"), "[]");
  fs.writeFileSync(path.join(root, ".deeppairing/preferences.json"), JSON.stringify({
    rejectedApproaches: [{ description: "global mutable state", reason: "Keep configuration explicit" }],
  }));
  expect(ensurePreflightHook(root).ok).toBe(true);
  const script = copy === "init" ? path.join(root, ".deeppairing/hooks/preflight.mjs") : plugin;
  const state = () => JSON.parse(fs.readFileSync(path.join(root, ".deeppairing/hooks-state.json"), "utf8"));
  const environment = (mode?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_GUARDRAIL_BACKSTOP: "" };
    delete env.DEEPPAIRING_PREFLIGHT_MODE;
    if (mode !== undefined) env.DEEPPAIRING_PREFLIGHT_MODE = mode;
    return env;
  };
  const payload = (file = "src/config.ts", content = "global mutable state") => JSON.stringify({
    tool_name: "Write", tool_input: { file_path: path.join(root, file), content },
  });
  const run = (mode?: string, input = payload()) => {
    const result = spawnSync(process.execPath, [script], { input, env: environment(mode), encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result;
  };
  return { root, script, state, environment, payload, run };
}

const modes = [
  { name: "unset", value: undefined, strict: false, invalid: false },
  { name: "empty", value: "", strict: false, invalid: false },
  { name: "explicit ask", value: "ask", strict: false, invalid: false },
  { name: "strict-stop", value: "strict-stop", strict: true, invalid: false },
  { name: "case variant", value: "Strict-Stop", strict: true, invalid: true },
  { name: "uppercase ask", value: "ASK", strict: true, invalid: true },
  { name: "leading space", value: " strict-stop", strict: true, invalid: true },
  { name: "trailing space", value: "ask ", strict: true, invalid: true },
  { name: "whitespace only", value: " ", strict: true, invalid: true },
  { name: "unknown", value: "unknown-mode-marker", strict: true, invalid: true },
  { name: "long controls", value: "UNTRUSTED_MODE_MARKER\x1b[31m\n" + "x".repeat(20_000), strict: true, invalid: true },
];

describe.each(["init", "plugin"] as const)("#544 %s mode contract", copy => {
  it.each(modes)("$name: exact parser, output and telemetry on a rejection", c => {
    expect(resolvePreflightMode(c.value)).toEqual({ mode: c.strict ? "strict-stop" : "ask", invalid: c.invalid });
    const f = fixture(copy);
    const result = f.run(c.value);
    const out = JSON.parse(result.stdout); // one JSON object, no out-of-band logs
    expect(result.stderr).toBe("");
    expect(out.hookSpecificOutput.permissionDecision).toBe(c.strict ? "deny" : "ask");
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    expect(out.systemMessage).toBe(reason);
    expect(reason).toContain("REJECTED_APPROACH_BLOCKED");
    const fire = f.state().fires.at(-1);
    expect(fire.kind).toBe(c.strict ? "deny" : "ask");
    if (c.strict) {
      expect(out.continue).toBe(false);
      expect(out.stopReason).toBe(reason);
      expect(reason.length).toBeLessThanOrEqual(1800);
      expect(reason).not.toMatch(/allow.*once|Allow this edit|paused for your review|\x1b/);
      expect(fire.mode).toBe("strict-stop");
      expect(reason.startsWith(PREFLIGHT_MODE_WARNING)).toBe(c.invalid);
      expect(reason).not.toContain("UNTRUSTED_MODE_MARKER");
      expect(reason).not.toContain("unknown-mode-marker");
    } else {
      const decision = evaluatePreflightHook({ toolName: "Write", toolInput: JSON.parse(f.payload()).tool_input, projectRoot: f.root });
      expect(result.stdout).toBe(JSON.stringify({ systemMessage: decision.reason, hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: decision.reason,
      } }));
      expect(fire).toEqual({ at: expect.any(String), hook: "preflight", kind: "ask", reason: "session" });
    }
  });

  it.each(["strict-stop", "invalid"])("%s keeps nonfires silent and malformed input fail-open", mode => {
    const f = fixture(copy);
    const miss = f.run(mode, f.payload("src/safe.ts", "const n = 1"));
    expect(miss.stdout).toBe("");
    expect(miss.stderr).toBe("");
    expect(f.run(mode, "{ malformed").stdout).toBe("");
    fs.writeFileSync(path.join(f.root, ".deeppairing/preferences.json"), "{ malformed");
    expect(f.run(mode).stdout).toBe(""); // existing ledger-read fail-open boundary
  });

  it("strict guardrails ignore old ask stamps and never stamp their own", () => {
    const f = fixture(copy);
    const input = f.payload(".github/workflows/ci.yml", "name: ci");
    expect(JSON.parse(f.run(undefined, input).stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    const stamps = f.state().guardrailAsks;
    for (let n = 0; n < 2; n++) {
      const out = JSON.parse(f.run("strict-stop", input).stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.stopReason).toContain("GUARDRAIL_ESCALATION");
      expect(out.stopReason).not.toContain("Allow this edit");
    }
    expect(f.state().guardrailAsks).toEqual(stamps);
    expect(f.run(undefined, input).stdout).toBe(""); // default dedup unchanged
  });

  it("strict -> ask does not suppress the first ordinary ask", () => {
    const f = fixture(copy);
    const input = f.payload("migrations/001.sql", "SELECT 1");
    f.run("strict-stop", input);
    expect(f.state().guardrailAsks).toBeUndefined();
    expect(JSON.parse(f.run(undefined, input).stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it.each(["team", "state"])("%s recovery never offers personal retirement or allow once", cause => {
    const f = fixture(copy);
    fs.writeFileSync(path.join(f.root, ".deeppairing/preferences.json"), "{}");
    fs.writeFileSync(path.join(f.root, ".deeppairing/team.json"), JSON.stringify({ version: 1, preferences: [
      { id: "rule", kind: "avoid", concept: "global mutable state", rationale: "Explicit configuration" },
    ] }));
    const out = JSON.parse(f.run("strict-stop", cause === "state" ? f.payload(".deeppairing/preferences.json", "{}") : undefined).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.stopReason).not.toMatch(/retire|allow.*once|Allow this edit/i);
    expect(out.stopReason).toContain(cause === "team" ? "committed team rule" : "authorized human");
  });

  it("sanitizes and bounds model-controlled paths in strict reasons", () => {
    const f = fixture(copy);
    const out = JSON.parse(f.run("strict-stop", f.payload(".github/workflows/\x1b[31mline\nname.yml", "name: ci")).stdout);
    expect(out.stopReason).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(out.stopReason).not.toContain("[31m");
    expect(out.stopReason.length).toBeLessThanOrEqual(1800);
    expect(sanitizeStrictReason("\x1b]0;spoof\x07" + "x".repeat(6000))).toHaveLength(1800);
  });

  it("denies every concurrent matching call while unrelated calls remain silent", async () => {
    const f = fixture(copy);
    const invoke = (input: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [f.script], { env: f.environment("strict-stop") });
      let out = "", err = "";
      child.stdout.on("data", data => out += data);
      child.stderr.on("data", data => err += data);
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(out) : reject(new Error(err)));
      child.stdin.end(input);
    });
    const outputs = await Promise.all([
      ...Array.from({ length: 4 }, () => invoke(f.payload("migrations/001.sql", "SELECT 1"))),
      invoke(f.payload("src/safe.ts", "const n = 1")),
    ]);
    for (const out of outputs.slice(0, 4)) {
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
      expect(JSON.parse(out).continue).toBe(false);
    }
    expect(outputs[4]).toBe("");
    expect(f.state().fires.filter((fire: { kind?: string }) => fire.kind === "deny")).toHaveLength(4);
  });
});
