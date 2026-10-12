import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../claude-plugin");
let tmp: string;
let plugin: string;
let project: string;
let home: string;
let entry: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp doctor space "));
  plugin = path.join(tmp, "installed plugin");
  project = path.join(tmp, "external project");
  home = path.join(tmp, "scratch home");
  fs.cpSync(pluginSrc, plugin, { recursive: true });
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  entry = path.join(plugin, "server", "doctor.mjs");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args: string[] = [], env: NodeJS.ProcessEnv = {}, cwd = project) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: home, USERPROFILE: home, APPDATA: home,
      DEEPPAIRING_PORT_BASE: process.env.DEEPPAIRING_PORT_BASE,
      DEEPPAIRING_PORT_SPAN: process.env.DEEPPAIRING_PORT_SPAN,
      ...env,
    },
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return { status: result.status, text: result.stdout + result.stderr };
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      if (fs.statSync(full).isDirectory()) { files[rel] = "<directory>"; visit(full); }
      else files[rel] = fs.readFileSync(full).toString("base64");
    }
  }
  visit(root);
  return files;
}

function settings(root: string, name: string, data: unknown) {
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", name), JSON.stringify(data));
}

describe("marketplace doctor, without dist or npm dependencies", () => {
  it("reports all existing checks from a different project, with spaces and no plugin env", () => {
    expect(fs.existsSync(path.join(tmp, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(plugin, "packages"))).toBe(false);
    fs.mkdirSync(path.join(project, ".deeppairing"));
    fs.writeFileSync(path.join(project, ".deeppairing", "daemon.json"), "{invalid");
    fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(home, ".deeppairing", "philosophy"), { recursive: true });
    fs.writeFileSync(path.join(home, ".deeppairing", "philosophy", "v1.json"), "{broken");
    const beforeProject = snapshot(project);
    const beforeHome = snapshot(home);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.text).toContain(`deepPairing project: ${project} (cwd)`);
    expect(result.text).toContain("daemon.json is malformed");
    expect(result.text).toMatch(/System clock is steady|Your system clock/);
    expect(result.text).toContain("provided by the plugin");
    expect(result.text).toMatch(/Philosophy ledger/);
    expect(result.text).toContain("GET http://localhost:");
    expect(snapshot(project)).toEqual(beforeProject);
    expect(snapshot(home)).toEqual(beforeHome);
    expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(project, "CLAUDE.md"))).toBe(false);
  });

  it("refuses unknown arguments and --yes without --fix before any diagnostics", () => {
    for (const args of [["init"], ["--fix", "--unknown"], ["--yes"], ["--help", "--fix"]]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.text).toContain("Invalid doctor arguments");
      expect(result.text).not.toContain("GET http://localhost:");
    }
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.text).toContain(`node "${entry}"`);
    expect(snapshot(project)).toEqual({});
    expect(snapshot(home)).toEqual({});
  });

  it("--fix cancels without a terminal; --fix --yes repairs only the resolved project", () => {
    const wrong = path.join(tmp, "wrong cwd");
    const fallback = path.join(tmp, "fallback project");
    fs.mkdirSync(wrong);
    fs.mkdirSync(fallback);
    fs.mkdirSync(path.join(project, ".deeppairing"));
    fs.writeFileSync(path.join(project, ".deeppairing", "daemon.json"), "{bad");
    fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/\n");
    const dpStop = { type: "command", command: "node .deeppairing/hooks/stop.mjs" };
    const dpPreflight = { type: "command", command: "node .deeppairing/hooks/preflight.mjs" };
    const ownStop = { type: "command", command: "node my-own/hooks/stop.mjs", timeout: 77 };
    const ownPreflight = { type: "command", command: "node ci/preflight.mjs --lint" };
    settings(project, "settings.local.json", { env: { KEEP: "local" }, hooks: {
      Stop: [{ matcher: "*", timeout: 33, hooks: [dpStop, ownStop] }],
      PreToolUse: [{ matcher: "Write|Edit", hooks: [dpPreflight, ownPreflight] }],
    } });
    settings(project, "settings.json", { hooks: { Stop: [{ hooks: [dpStop, ownStop] }] } });
    settings(home, "settings.json", { hooks: { Stop: [{ hooks: [dpStop, ownStop] }] } });
    const beforeProject = snapshot(project);
    const beforeHome = snapshot(home);
    const env = { CLAUDE_PROJECT_DIR: project, DEEPPAIRING_PROJECT_ROOT: fallback };
    const cancelled = run(["--fix"], env, wrong);
    expect(cancelled.text).toContain("Cancelled. No changes made.");
    expect(snapshot(project)).toEqual(beforeProject);
    expect(snapshot(home)).toEqual(beforeHome);
    const repaired = run(["--fix", "--yes"], env, wrong);
    expect(repaired.status).toBe(0);
    expect(repaired.text).toContain(`deepPairing project: ${project} (CLAUDE_PROJECT_DIR)`);
    expect(repaired.text).toContain("SKIPPED Remove");
    expect(repaired.text).toContain("requires interactive confirmation");
    expect(fs.existsSync(path.join(project, ".deeppairing", "daemon.json"))).toBe(false);
    expect(fs.readFileSync(path.join(project, ".gitignore"), "utf8")).toContain(".deeppairing/");
    const local = JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"));
    expect(local.env).toEqual({ KEEP: "local" });
    expect(local.hooks.Stop).toEqual([{ matcher: "*", timeout: 33, hooks: [ownStop] }]);
    expect(local.hooks.PreToolUse).toEqual([{ matcher: "Write|Edit", hooks: [ownPreflight] }]);
    expect(local.hooks.PostToolUse).toHaveLength(1);
    const checkpoint = path.join(project, ".deeppairing", "hooks", "checkpoint.mjs");
    expect(fs.existsSync(checkpoint)).toBe(true);
    const smoke = spawnSync(process.execPath, [checkpoint], {
      cwd: project, input: JSON.stringify({ tool_name: "Read", tool_input: {} }),
      encoding: "utf8", env: { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project },
    });
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(snapshot(home)).toEqual(beforeHome);
    expect(fs.readFileSync(path.join(project, ".claude", "settings.json")).toString("base64"))
      .toBe(beforeProject[path.join(".claude", "settings.json")]);
    expect(snapshot(wrong)).toEqual({});
    expect(snapshot(fallback)).toEqual({});
    expect(fs.existsSync(path.join(project, ".deeppairing", "hooks", "preflight.mjs"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".deeppairing", "hooks", "stop.mjs"))).toBe(false);
  });

  it("honors DEEPPAIRING_PROJECT_ROOT without CLAUDE_PROJECT_DIR", () => {
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere);
    const result = run([], { DEEPPAIRING_PROJECT_ROOT: project }, elsewhere);
    expect(result.status).toBe(0);
    expect(result.text).toContain(`deepPairing project: ${project} (DEEPPAIRING_PROJECT_ROOT)`);
    expect(snapshot(project)).toEqual({});
    expect(snapshot(elsewhere)).toEqual({});
    expect(snapshot(home)).toEqual({});
  });
});
