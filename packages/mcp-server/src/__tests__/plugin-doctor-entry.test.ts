import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ownLockIdentity } from "../store/file-lock.js";
import { shQuote } from "../store/ledger-health.js";

const pluginSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../claude-plugin");
const hasPosixTerminal = process.platform !== "win32" &&
  spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;
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
  it.runIf(hasPosixTerminal)("confirmed terminal repair backs up local/shared/user settings and preserves mixed siblings", () => {
    const dp = { type: "command", command: "node .deeppairing/hooks/stop.mjs" };
    const own = { type: "command", command: "node ci/own-hook.mjs" };
    const rows = [{ matcher: "*", timeout: 23, hooks: [dp, own] }];
    settings(project, "settings.local.json", { enabledPlugins: { "deeppairing@deeppairing": true }, hooks: {
      Stop: rows,
      PreToolUse: [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: "node .deeppairing/hooks/preflight.mjs" }, own] },
        { matcher: "Bash", hooks: [{ type: "command", command: 'sh "$CLAUDE_PROJECT_DIR/.deeppairing/hooks/stance-allow-ask.sh"' }, own] },
      ],
      PostToolUse: [{ hooks: [{ type: "command", command: "node .deeppairing/hooks/checkpoint.mjs" }] }],
    } });
    settings(project, "settings.json", { hooks: { Stop: rows } });
    settings(home, "settings.json", { hooks: { Stop: rows } });
    const files = [path.join(project, ".claude", "settings.local.json"),
      path.join(project, ".claude", "settings.json"), path.join(home, ".claude", "settings.json")];
    const originals = files.map((file) => fs.readFileSync(file));
    const result = spawnSync("script", ["--quiet", "--return", "--command",
      `${shQuote(process.execPath)} ${shQuote(entry)} --fix`, "/dev/null"], {
      cwd: project, input: "y\n", encoding: "utf8", timeout: 20_000,
      env: { HOME: home, USERPROFILE: home, DEEPPAIRING_PORT_BASE: process.env.DEEPPAIRING_PORT_BASE,
        DEEPPAIRING_PORT_SPAN: process.env.DEEPPAIRING_PORT_SPAN },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("verify deepPairing is enabled for this project");
    expect(result.stdout).toContain("Apply all");
    expect(result.stdout).not.toContain("Cancelled");
    for (const [index, file] of files.entries()) {
      const dir = path.dirname(file);
      const backups = fs.readdirSync(dir).filter((name) => name.startsWith(path.basename(file) + ".deeppairing-backup-"));
      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(backups.some((name) => fs.readFileSync(path.join(dir, name)).equals(originals[index]!))).toBe(true);
      expect(result.stdout).toContain("Settings backup:");
      const repaired = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(repaired.hooks.Stop).toEqual([{ matcher: "*", timeout: 23, hooks: [own] }]);
    }
    const local = JSON.parse(fs.readFileSync(files[0]!, "utf8"));
    expect(local.hooks.PreToolUse).toEqual([
      { matcher: "Write|Edit", hooks: [own] }, { matcher: "Bash", hooks: [own] },
    ]);
    expect(local.enabledPlugins).toEqual({ "deeppairing@deeppairing": true });
  });

  it("retains every local gate and mixed sibling when the installed plugin is disabled", () => {
    settings(project, "settings.local.json", {
      enabledPlugins: { "deeppairing@deeppairing": false },
      permissions: { allow: ["Read"] },
      hooks: {
        Stop: [{ matcher: "*", hooks: [
          { type: "command", command: "node .deeppairing/hooks/stop.mjs" },
          { type: "command", command: "node my-own/stop.mjs" },
        ] }],
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [
            { type: "command", command: "node .deeppairing/hooks/preflight.mjs" },
            { type: "command", command: "node ci/lint.mjs" },
          ] },
          { matcher: "Bash", hooks: [
            { type: "command", command: 'sh "$CLAUDE_PROJECT_DIR/.deeppairing/hooks/stance-allow-ask.sh"' },
            { type: "command", command: "echo user-bash-hook" },
          ] },
        ],
        PostToolUse: [{ hooks: [{ type: "command", command: "node .deeppairing/hooks/checkpoint.mjs" }] }],
      },
    });
    const before = snapshot(project);
    const result = run(["--fix", "--yes"]);
    expect(result.status).toBe(0);
    expect(snapshot(project)).toEqual(before);
    expect(result.text).toContain("Plugin activation is not verified");
    expect(result.text).toContain("verify deepPairing is enabled for this project");
    expect(result.text).toContain("SKIPPED Remove the project-local Stop hook");
    expect(result.text).toContain("SKIPPED Remove the project-local PreToolUse rejection-gate hook");
    expect(result.text).toContain("SKIPPED Remove the project-local Bash ask hook");
    expect(result.text).not.toContain("Settings backup:");
    expect(snapshot(home)).toEqual({});
  });

  it("--fix --yes clears local dead locks but preserves global dead locks", () => {
    const identity = ownLockIdentity();
    expect(identity).toBeTruthy();
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.status).toBe(0);
    const owner = JSON.stringify({ ...identity, pid: dead.pid, processStartTime: null,
      createdAt: "2020-01-01T00:00:00.000Z", nonce: "doctor-scope-test" });
    const localDir = path.join(project, ".deeppairing");
    const globalDir = path.join(home, ".deeppairing", "philosophy");
    fs.mkdirSync(localDir, { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
    const localLock = path.join(localDir, "session.json.lock");
    const globalLock = path.join(globalDir, "v1.json.lock");
    fs.writeFileSync(localLock, owner);
    fs.writeFileSync(globalLock, owner);
    const beforeHome = snapshot(home);
    const result = run(["--fix", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.text).toContain(`SKIPPED Remove dead-owner lock ${globalLock}`);
    expect(fs.existsSync(localLock)).toBe(false);
    expect(snapshot(home)).toEqual(beforeHome);
  });

  it("--fix --yes does not terminate this project's older daemon", async () => {
    // An owned HTTP child advertises an old daemon identity. A faulty repair
    // can only terminate this disposable child, never an unrelated process.
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import http from "node:http";
      const projectRoot = process.argv[1];
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url === "/api/daemon-info"
          ? { pid: process.pid, projectRoot, startedAt: "2020-01-01T00:00:00.000Z", version: "0.0.1" }
          : req.url === "/api/active-sessions" ? { sessions: [] } : {}));
      });
      server.listen(0, "127.0.0.1", () => console.log(server.address().port));
    `, project], { stdio: ["ignore", "pipe", "pipe"], env: { HOME: home, USERPROFILE: home } });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("owned HTTP child did not start")), 5000);
        child.once("error", (err) => { clearTimeout(timer); reject(err); });
        child.stdout.once("data", (data: Buffer) => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
      });
      fs.mkdirSync(path.join(project, ".deeppairing"));
      fs.writeFileSync(path.join(project, ".deeppairing", "daemon.json"),
        JSON.stringify({ pid: child.pid, port, startedAt: "2020-01-01T00:00:00.000Z" }));
      const result = run(["--fix", "--yes"]);
      expect(result.status).toBe(0);
      expect(result.text).toContain("SKIPPED Restart stale daemon");
      expect(await fetch(`http://127.0.0.1:${port}/api/daemon-info`).then((res) => res.ok, () => false)).toBe(true);
      expect(snapshot(home)).toEqual({});
    } finally {
      child.kill();
      await exited;
    }
  });

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
    expect(result.text).toContain("activation not verified");
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
    expect(local.hooks.Stop).toEqual([{ matcher: "*", timeout: 33, hooks: [dpStop, ownStop] }]);
    expect(local.hooks.PreToolUse).toEqual([{ matcher: "Write|Edit", hooks: [dpPreflight, ownPreflight] }]);
    expect(local.hooks.PostToolUse).toHaveLength(1);
    const backups = fs.readdirSync(path.join(project, ".claude"))
      .filter((name) => name.startsWith("settings.local.json.deeppairing-backup-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(project, ".claude", backups[0]!)).toString("base64"))
      .toBe(beforeProject[path.join(".claude", "settings.local.json")]);
    expect(repaired.text).toContain(`Settings backup: ${path.join(project, ".claude", backups[0]!)}`);
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
