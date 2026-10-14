/**
 * #538 — init-installed hooks are gitignored, so a fresh git worktree of an
 * initialised checkout has none. Detection + guidance only (doctor + first-call
 * preamble); nothing is ever written. Real git, real `git worktree add`, scratch
 * dirs, the real init hook installers. No mocks.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { doctor } from "../cli/doctor.js";
import { ensureCheckpointHook, ensurePreflightHook, ensureStopHook } from "../cli/setup-tasks.js";
import { detectWorktreeMissingHooks } from "../worktree-hooks.js";
import { buildFirstCallHint } from "../mcp/first-call-hint.js";
import { FileStore } from "../store/file-store.js";

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const initJs = path.join(pkgRoot, "dist", "cli", "init.js");
const WARN = "deepPairing's hooks are installed in the main checkout but not here";

let base = "";
let main = "";
let wt = "";
let wtWithRows = "";
let plain = "";
let gitEnv: NodeJS.ProcessEnv = {};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=dp", "-c", "user.email=dp@example.invalid", ...args], { cwd, env: gitEnv, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function installRows(dir: string): void {
  expect(ensureStopHook(dir).ok).toBe(true);
  expect(ensureCheckpointHook(dir).ok).toBe(true);
  expect(ensurePreflightHook(dir).ok).toBe(true);
}

async function runDoctor(cwd: string, opts: Parameters<typeof doctor>[1]): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await doctor(cwd, opts); } finally { console.log = orig; }
  return lines.join("\n");
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-wt-hooks-538-")));
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  gitEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  main = path.join(base, "main");
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "README.md"), "x\n");
  git(main, "add", "."); git(main, "commit", "-q", "-m", "init");
  installRows(main);
  wt = path.join(base, "wt");
  git(main, "worktree", "add", "-q", "-b", "feat", wt);
  wtWithRows = path.join(base, "wt-rows");
  git(main, "worktree", "add", "-q", "-b", "feat2", wtWithRows);
  installRows(wtWithRows);
  plain = path.join(base, "plain");
  fs.mkdirSync(plain);
  git(plain, "init", "-q", "-b", "main");
  installRows(plain);
}, 60_000);

afterAll(() => { if (base) fs.rmSync(base, { recursive: true, force: true }); });

describe.skipIf(!hasGit)("#538 worktree without the main checkout's hooks", () => {
  it("detector: fires only for a linked worktree whose main has rows and which has none", () => {
    expect(detectWorktreeMissingHooks(wt)).toEqual({ mainTop: main, worktreeTop: wt });
    expect(detectWorktreeMissingHooks(path.join(wt))).not.toBeNull();
    expect(detectWorktreeMissingHooks(wtWithRows)).toBeNull();
    expect(detectWorktreeMissingHooks(main)).toBeNull();
    expect(detectWorktreeMissingHooks(plain)).toBeNull();
  });

  it("detector: a forged .git back-pointer is not a validated worktree", () => {
    const fake = path.join(base, "forged");
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "nope")}\n`);
    expect(detectWorktreeMissingHooks(fake)).toBeNull();
  });

  it("doctor warns in the worktree and names the main checkout", async () => {
    const out = await runDoctor(main, { workspaceDir: wt, pluginManaged: false });
    expect(out).toContain(`This is a git worktree of ${main}`);
    expect(out).toContain(WARN);
    expect(out).toContain("deeppairing init");
    const direct = await runDoctor(wt, { pluginManaged: false });
    expect(direct).toContain(WARN);
  });

  it("doctor does not warn when the worktree has its own rows, in the main checkout, or outside a worktree", async () => {
    expect(await runDoctor(main, { workspaceDir: wtWithRows, pluginManaged: false })).not.toContain(WARN);
    expect(await runDoctor(main, { pluginManaged: false })).not.toContain(WARN);
    expect(await runDoctor(plain, { pluginManaged: false })).not.toContain(WARN);
  });

  it("plugin-provided hooks: silent when activation is trusted, conditional when unverified", async () => {
    expect(await runDoctor(main, { workspaceDir: wt, pluginManaged: true })).not.toContain(WARN);
    const out = await runDoctor(main, { workspaceDir: wt, pluginManaged: true, protectSharedScopes: true });
    expect(out).toContain(WARN);
    expect(out).toContain("If the deepPairing plugin is enabled");
  });

  it("--fix --yes writes nothing into the worktree for this check", async () => {
    const before = listTree(wt);
    const out = await runDoctor(main, { workspaceDir: wt, pluginManaged: false, fix: true, yes: true });
    expect(out).toContain(WARN);
    expect(listTree(wt)).toEqual(before);
    expect(fs.existsSync(path.join(wt, ".claude"))).toBe(false);
  });

  describe("first-call preamble", () => {
    let store: FileStore;
    beforeAll(() => { store = new FileStore(path.join(base, "store"), "wt_hooks_538"); });
    afterAll(() => { store.dispose?.(); });

    it("adds one line in a hookless worktree", async () => {
      const hint = await buildFirstCallHint(store, 3900, [], { workspaceDir: wt, pluginManaged: false });
      expect(hint).toContain(`git worktree of ${main}`);
      expect(hint).toContain("Tell the human");
    });

    it("stays silent with rows, outside a worktree, or under the plugin", async () => {
      for (const env of [
        { workspaceDir: wtWithRows, pluginManaged: false },
        { workspaceDir: main, pluginManaged: false },
        { workspaceDir: plain, pluginManaged: false },
        { workspaceDir: wt, pluginManaged: true },
      ]) {
        expect(await buildFirstCallHint(store, 3900, [], env)).not.toContain("git worktree of");
      }
    });
  });

  it.skipIf(!fs.existsSync(initJs))("e2e: real `init` in a worktree installs the rows THERE, the real preflight hook blocks a stance rejected in main, main is untouched", async () => {
    const REJECTED = "global mutable state for config";
    const wt2 = path.join(base, "wt-e2e");
    git(main, "worktree", "add", "-q", "-b", "feat-e2e", wt2);
    fs.mkdirSync(path.join(main, ".deeppairing"), { recursive: true });
    fs.writeFileSync(path.join(main, ".deeppairing", "preferences.json"), JSON.stringify({
      rejectedApproaches: [{ description: REJECTED, reason: "Keep configuration explicit" }],
    }));
    const mainSettings = path.join(main, ".claude", "settings.local.json");
    const mainBefore = fs.readFileSync(mainSettings, "utf8");
    expect(await runDoctor(main, { workspaceDir: wt2, pluginManaged: false })).toContain(WARN);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(base, "home"), DEEPPAIRING_NO_OPEN: "1", BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1" };
    delete env.CLAUDE_PROJECT_DIR; delete env.DEEPPAIRING_PROJECT_ROOT; delete env.CLAUDE_PLUGIN_ROOT;
    const r = spawnSync(process.execPath, [initJs, "init", "--yes", "--no-demo"], { cwd: wt2, env, encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    const wtSettingsPath = path.join(wt2, ".claude", "settings.local.json");
    const wtSettings = fs.readFileSync(wtSettingsPath, "utf8");
    expect(wtSettings).toContain(".deeppairing/hooks/preflight.mjs");
    expect(wtSettings).toContain(".deeppairing/hooks/checkpoint.mjs");
    expect(fs.existsSync(path.join(wt2, ".deeppairing", "hooks", "preflight.mjs"))).toBe(true);
    expect(fs.readFileSync(mainSettings, "utf8")).toBe(mainBefore);
    // Data stays on the canonical main root: no per-worktree sessions/ledger.
    expect(fs.existsSync(path.join(wt2, ".deeppairing", "sessions"))).toBe(false);

    // The worktree's own installed hook, launched as Claude Code would.
    const hook = spawnSync(process.execPath, [path.join(wt2, ".deeppairing", "hooks", "preflight.mjs")], {
      cwd: wt2, env: { ...env, CLAUDE_PROJECT_DIR: wt2 }, encoding: "utf8", timeout: 30_000,
      input: JSON.stringify({ tool_name: "Edit", cwd: wt2, tool_input: { file_path: path.join(wt2, "src", "config.ts"), new_string: REJECTED } }),
    });
    expect(hook.status, hook.stderr).toBe(0);
    expect(JSON.parse(hook.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("REJECTED_APPROACH_BLOCKED"),
    });

    expect(await runDoctor(main, { workspaceDir: wt2, pluginManaged: false })).not.toContain(WARN);
  }, 120_000);

  describe.skipIf(!fs.existsSync(initJs))("init in a worktree: .mcp.json, CLAUDE.md and settings backup", () => {
    function runInit(cwd: string) {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(base, "home"), DEEPPAIRING_NO_OPEN: "1", BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1" };
      delete env.CLAUDE_PROJECT_DIR; delete env.DEEPPAIRING_PROJECT_ROOT; delete env.CLAUDE_PLUGIN_ROOT;
      const r = spawnSync(process.execPath, [initJs, "init", "--yes", "--no-demo"], { cwd, env, encoding: "utf8", timeout: 60_000 });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      return r.stdout;
    }
    function repoWithInit(name: string, track: boolean): { repo: string; wt: string } {
      const repo = path.join(base, name);
      fs.mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(repo, "README.md"), "x\n");
      git(repo, "add", "."); git(repo, "commit", "-q", "-m", "init");
      runInit(repo);
      if (track) {
        git(repo, "add", ".mcp.json", "CLAUDE.md");
        git(repo, "commit", "-q", "-m", "track dp config");
      }
      const w = path.join(base, `${name}-wt`);
      git(repo, "worktree", "add", "-q", "-b", `${name}-b`, w);
      return { repo, wt: w };
    }

    it("untracked in main: installs .mcp.json and the CLAUDE.md protocol into the worktree", () => {
      const { repo, wt: w } = repoWithInit("untracked", false);
      expect(fs.existsSync(path.join(w, ".mcp.json"))).toBe(false);
      const mainMcp = fs.readFileSync(path.join(repo, ".mcp.json"), "utf8");
      const mainMd = fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8");
      const out = runInit(w);
      expect(out).not.toContain(".mcp.json already has deeppairing configured");
      expect(JSON.parse(fs.readFileSync(path.join(w, ".mcp.json"), "utf8")).mcpServers.deeppairing).toBeTruthy();
      expect(fs.readFileSync(path.join(w, "CLAUDE.md"), "utf8")).toContain("<!-- deepPairing -->");
      expect(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8")).toBe(mainMcp);
      expect(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8")).toBe(mainMd);
    });

    it("tracked in main: the worktree already has them and init leaves them alone", () => {
      const { wt: w } = repoWithInit("tracked", true);
      const mcp = fs.readFileSync(path.join(w, ".mcp.json"), "utf8");
      const md = fs.readFileSync(path.join(w, "CLAUDE.md"), "utf8");
      const out = runInit(w);
      expect(out).toContain(".mcp.json already has deeppairing configured");
      expect(out).toContain("CLAUDE.md already has deepPairing instructions");
      expect(fs.readFileSync(path.join(w, ".mcp.json"), "utf8")).toBe(mcp);
      expect(fs.readFileSync(path.join(w, "CLAUDE.md"), "utf8")).toBe(md);
    });

    it("backs up an existing worktree settings file (exact bytes) before rewriting", () => {
      const { wt: w } = repoWithInit("backup", false);
      const settings = path.join(w, ".claude", "settings.local.json");
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      const original = '{ "permissions": {"allow": ["Bash(ls)"]}  }\n';
      fs.writeFileSync(settings, original);
      runInit(w);
      const backups = fs.readdirSync(path.dirname(settings)).filter((f) => f.startsWith("settings.local.json.deeppairing-backup-"));
      expect(backups.length).toBeGreaterThan(0);
      // One backup per rewrite; the first holds the user's exact original bytes.
      expect(backups.map((f) => fs.readFileSync(path.join(path.dirname(settings), f), "utf8"))).toContain(original);
      expect(fs.readFileSync(settings, "utf8")).toContain("Bash(ls)");
      expect(fs.readFileSync(settings, "utf8")).toContain("preflight.mjs");
    });
  });
});
