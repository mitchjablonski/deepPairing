/**
 * I6 — the plugin must ship the enforcement layer natively. Two things to lock:
 *   1. claude-plugin/hooks/hooks.json declares the PreToolUse preflight gate
 *      (matcher Write|Edit|MultiEdit) + the Stop checkpoint, per the documented
 *      plugin convention (${CLAUDE_PLUGIN_ROOT} + hooks/hooks.json).
 *   2. The bundled server/{preflight,stop}.mjs run standalone under plain
 *      `node` and reproduce the init-path hook protocol (ask-JSON on a rejected
 *      match; stderr checkpoint on unreviewed drafts).
 *
 * The smoke cases run the COMMITTED bundle (what marketplace users execute);
 * the staleness gate in CI proves it's current with src/.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → src/ → mcp-server/ → packages/ → repo root
const repoRoot = path.resolve(here, "../../../..");
const pluginDir = path.join(repoRoot, "claude-plugin");
const serverDir = path.join(pluginDir, "server");
const preflightBundle = path.join(serverDir, "preflight.mjs");
const stopBundle = path.join(serverDir, "stop.mjs");
const bundlesBuilt = fs.existsSync(preflightBundle) && fs.existsSync(stopBundle);

describe("plugin hooks declaration (hooks/hooks.json)", () => {
  const hooksJson = JSON.parse(fs.readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf-8"));

  it("declares a PreToolUse gate on Write|Edit|MultiEdit invoking the bundled preflight script", () => {
    const entry = hooksJson.hooks.PreToolUse?.[0];
    expect(entry.matcher).toBe("Write|Edit|MultiEdit");
    const cmd = entry.hooks?.[0]?.command ?? "";
    expect(entry.hooks[0].type).toBe("command");
    expect(cmd).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(cmd).toContain("server/preflight.mjs");
  });

  it("declares a Stop checkpoint invoking the bundled stop script", () => {
    const entry = hooksJson.hooks.Stop?.[0];
    expect(entry.matcher).toBe("");
    const cmd = entry.hooks?.[0]?.command ?? "";
    expect(entry.hooks[0].type).toBe("command");
    expect(cmd).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(cmd).toContain("server/stop.mjs");
  });
});

describe("plugin hook bundles (smoke)", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dp-plugin-hooks-"));
    fs.mkdirSync(path.join(scratch, ".deeppairing", "sessions", "s1"), { recursive: true });
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const runHook = (bundle: string, stdin: string) =>
    execFileSync("node", [bundle], {
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: scratch },
    });

  it.skipIf(!bundlesBuilt)("preflight surfaces (ask) an Edit matching a rejected concept", () => {
    fs.writeFileSync(
      path.join(scratch, ".deeppairing", "preferences.json"),
      JSON.stringify({ rejectedApproaches: [{ description: "global config", concept: "global mutable state" }] }),
    );
    const out = runHook(
      preflightBundle,
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/c.ts", new_string: "export let cfg = {}; // global mutable state singleton" },
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(/REJECTED_APPROACH_BLOCKED/);
  });

  it.skipIf(!bundlesBuilt)("preflight allows (empty stdout) an unrelated edit", () => {
    fs.writeFileSync(
      path.join(scratch, ".deeppairing", "preferences.json"),
      JSON.stringify({ rejectedApproaches: [{ description: "global config", concept: "global mutable state" }] }),
    );
    const out = runHook(
      preflightBundle,
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/u.ts", new_string: "export const add = (a,b)=>a+b;" } }),
    );
    expect(out.trim()).toBe("");
  });

  it.skipIf(!bundlesBuilt)("preflight fast-paths (empty stdout) when no ledger is seeded", () => {
    const out = runHook(
      preflightBundle,
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x.ts", content: "global mutable state" } }),
    );
    expect(out.trim()).toBe("");
  });

  it.skipIf(!bundlesBuilt)("stop nags when an unreviewed draft is present", () => {
    fs.writeFileSync(
      path.join(scratch, ".deeppairing", "sessions", "s1", "artifacts.json"),
      JSON.stringify([{ id: "a1", type: "spec", status: "draft", createdAt: new Date().toISOString() }]),
    );
    // Stop writes the nag to stderr and always exits 0; assert via the fire it
    // records to hooks-state.json (the same signal the companion UI reads).
    runHook(stopBundle, "");
    const state = JSON.parse(fs.readFileSync(path.join(scratch, ".deeppairing", "hooks-state.json"), "utf-8"));
    const last = state.fires.at(-1);
    expect(last.hook).toBe("stop");
    expect(last.reason).toMatch(/pending artifacts/);
  });

  it.skipIf(!bundlesBuilt)("stop is silent (pass) when no blocking drafts remain", () => {
    fs.writeFileSync(
      path.join(scratch, ".deeppairing", "sessions", "s1", "artifacts.json"),
      JSON.stringify([{ id: "a1", type: "spec", status: "approved" }]),
    );
    runHook(stopBundle, "");
    const state = JSON.parse(fs.readFileSync(path.join(scratch, ".deeppairing", "hooks-state.json"), "utf-8"));
    expect(state.fires.at(-1).reason).toMatch(/no blocking drafts/);
  });
});
