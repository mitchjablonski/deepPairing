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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { doctor } from "../cli/doctor.js";
import { ensureCheckpointHook, ensurePreflightHook, ensureStopHook } from "../cli/setup-tasks.js";
import { detectWorktreeMissingHooks } from "../worktree-hooks.js";
import { buildFirstCallHint } from "../mcp/first-call-hint.js";
import { FileStore } from "../store/file-store.js";

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
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
});
