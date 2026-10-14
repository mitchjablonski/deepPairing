/**
 * #532 — the rejection gate must not fail open in a git worktree.
 *
 * `.deeppairing/` is gitignored, so a git LINKED WORKTREE used to be a separate
 * deepPairing project: its own daemon port, its own sessions and an EMPTY
 * ledger, which the preflight hook's `ledgersPresent` fast path read as
 * "nothing rejected" — re-proposals of a rejected approach passed silently.
 *
 * Real git, real `git worktree add`, the real preflight hook entry (bundled
 * from source with esbuild, exactly as the plugin ships it) and the real
 * generated checkpoint hook. No mocks.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalizeWorktreePath, findLinkedWorktree, resolveHookRoots } from "../git-worktree.js";
import { preferredPortFor, resolveProjectRoot } from "../project-root.js";
import { matchGuardrailPath } from "../guardrail-rules.js";
import { deriveSessionId } from "../session-id.js";
import { CHECKPOINT_HOOK_SCRIPT } from "../cli/hook-scripts.generated.js";
import { ensurePreflightHook } from "../cli/setup-tasks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..");
// The init-generated hook imports the BUILT matcher core + rule leaf.
const distBuilt = fs.existsSync(path.join(pkgRoot, "dist", "cli", "preflight-hook-core.js")) && fs.existsSync(path.join(pkgRoot, "dist", "guardrail-rules.js"));
const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

let base = "";
let main = "";
let wt = "";
let preflightBundle = "";
let checkpointScript = "";
let gitEnv: NodeJS.ProcessEnv = {};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=dp", "-c", "user.email=dp@example.invalid", "-c", "protocol.file.allow=always", ...args], {
    cwd, env: gitEnv, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "config.ts"), "export const config = {};\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

/** A clean hook env: no inherited CLAUDE_PROJECT_DIR / DEEPPAIRING_PROJECT_ROOT, a temp HOME. */
function hookEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: base, USERPROFILE: base, FORCE_COLOR: "0", NO_COLOR: "1" };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.DEEPPAIRING_PROJECT_ROOT;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DEEPPAIRING_GUARDRAIL_BACKSTOP;
  return { ...env, ...extra };
}

function runHook(script: string, event: unknown, extra: Record<string, string>) {
  const r = spawnSync(process.execPath, [script], {
    cwd: base, env: hookEnv(extra), input: JSON.stringify(event), encoding: "utf8", timeout: 15_000,
  });
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  return r;
}

function decisionOf(stdout: string): { permissionDecision?: string; permissionDecisionReason?: string } {
  return stdout.trim() ? JSON.parse(stdout).hookSpecificOutput : {};
}

const REJECTED = "global mutable state for config";

beforeAll(async () => {
  if (!hasGit) return;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-worktree-532-")));
  gitEnv = { ...process.env, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(base, "gitconfig") };
  for (const k of Object.keys(gitEnv)) if (k.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(k)) delete gitEnv[k];
  fs.writeFileSync(path.join(base, "gitconfig"), "");
  main = path.join(base, "main");
  initRepo(main);
  wt = path.join(base, "wt");
  git(main, "worktree", "add", "-q", wt, "-b", "feature");

  // The human rejected an approach in the MAIN checkout.
  fs.mkdirSync(path.join(main, ".deeppairing", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(main, ".deeppairing", "preferences.json"), JSON.stringify({
    rejectedApproaches: [{ description: REJECTED, reason: "Keep configuration explicit" }],
  }));

  // The REAL plugin preflight hook, bundled from this tree's source.
  const out = path.join(base, "bundle");
  preflightBundle = path.join(out, "preflight.mjs");
  await build({
    entryPoints: [path.join(pkgRoot, "src", "cli", "preflight-hook-entry.ts")],
    outfile: preflightBundle, bundle: true, platform: "node", format: "esm", target: "node20",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "silent",
  });
  checkpointScript = path.join(out, "checkpoint.mjs");
  fs.writeFileSync(checkpointScript, CHECKPOINT_HOOK_SCRIPT);
}, 60_000);

afterAll(() => {
  if (base && path.basename(base).startsWith("dp-worktree-532-")) fs.rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!hasGit)("#532 — a git worktree shares its main checkout's project", () => {
  it("resolves a worktree (and a worktree subdir) to the main checkout: same root, same daemon port, same ledger", () => {
    const fromMain = resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: main } });
    const fromWt = resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: wt } });
    expect(fromMain.projectRoot).toBe(main);
    expect(fromMain.worktree).toBeUndefined();
    expect(fromWt.projectRoot).toBe(main);
    expect(fromWt.worktree).toMatchObject({ worktreeTop: wt, mainTop: main, workspaceRoot: wt });
    expect(preferredPortFor(fromWt.projectRoot)).toBe(preferredPortFor(main));
    expect(path.join(fromWt.projectRoot, ".deeppairing", "preferences.json")).toBe(path.join(main, ".deeppairing", "preferences.json"));
    // The cwd fallback canonicalises too, including from a subdirectory.
    expect(resolveProjectRoot({ env: {}, cwd: () => path.join(wt, "src") }).projectRoot).toBe(path.join(main, "src"));
    // The hook lanes share the same chain.
    expect(resolveHookRoots(undefined, { CLAUDE_PROJECT_DIR: wt }).projectRoot).toBe(main);
    expect(resolveHookRoots(wt, {}).projectRoot).toBe(main);
  });

  it("the REAL preflight hook blocks, from the worktree, an approach rejected in the main checkout", () => {
    const event = { tool_name: "Edit", tool_input: { file_path: path.join(wt, "src", "config.ts"), new_string: REJECTED } };
    const viaProjectDir = runHook(preflightBundle, event, { CLAUDE_PROJECT_DIR: wt });
    expect(decisionOf(viaProjectDir.stdout)).toMatchObject({
      permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("REJECTED_APPROACH_BLOCKED"),
    });
    // Same through the event's cwd (no CLAUDE_PROJECT_DIR).
    const viaEventCwd = runHook(preflightBundle, { ...event, cwd: wt }, {});
    expect(decisionOf(viaEventCwd.stdout).permissionDecision).toBe("ask");
    // An unrelated edit still passes.
    const ordinary = runHook(preflightBundle, { tool_name: "Edit", tool_input: { file_path: path.join(wt, "src", "config.ts"), new_string: "export const x = 1;" } }, { CLAUDE_PROJECT_DIR: wt });
    expect(ordinary.stdout).toBe("");
    // The fire was recorded in the SHARED project, not a per-worktree one.
    expect(fs.existsSync(path.join(main, ".deeppairing", "hooks-state.json"))).toBe(true);
    expect(fs.existsSync(path.join(wt, ".deeppairing"))).toBe(false);
  });

  it.skipIf(!distBuilt)("the init-generated preflight hook (installed in the main checkout) blocks from the worktree too", () => {
    const home = vi.spyOn(os, "homedir").mockReturnValue(base);
    try {
      expect(ensurePreflightHook(main).ok).toBe(true);
    } finally {
      home.mockRestore();
    }
    const script = path.join(main, ".deeppairing", "hooks", "preflight.mjs");
    const r = runHook(script, { tool_name: "Edit", tool_input: { file_path: path.join(wt, "src", "config.ts"), new_string: REJECTED } }, { CLAUDE_PROJECT_DIR: wt });
    expect(decisionOf(r.stdout)).toMatchObject({
      permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("REJECTED_APPROACH_BLOCKED"),
    });
  });

  it("an explicit DEEPPAIRING_PROJECT_ROOT is taken as written, never redirected", () => {
    expect(resolveProjectRoot({ env: { DEEPPAIRING_PROJECT_ROOT: wt } })).toEqual({ projectRoot: wt, source: "DEEPPAIRING_PROJECT_ROOT" });
    expect(resolveHookRoots(undefined, { DEEPPAIRING_PROJECT_ROOT: wt }).projectRoot).toBe(wt);
    // So the hook sees the worktree's (empty) ledger: no ask. The user chose this.
    const r = runHook(preflightBundle, { tool_name: "Edit", tool_input: { file_path: path.join(wt, "src", "config.ts"), new_string: REJECTED } }, { DEEPPAIRING_PROJECT_ROOT: wt });
    expect(r.stdout).toBe("");
  });

  it("the #505 state guardrail still asks on the WORKTREE's .deeppairing/preferences.json and .claude settings", () => {
    for (const target of [path.join(wt, ".deeppairing", "preferences.json"), path.join(wt, ".claude", "settings.local.json")]) {
      const r = runHook(preflightBundle, { tool_name: "Write", tool_input: { file_path: target, content: "{}" } }, { CLAUDE_PROJECT_DIR: wt });
      expect(decisionOf(r.stdout), target).toMatchObject({
        permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("DEEPPAIRING_STATE"),
      });
    }
  });

  it("a guardrail path edited inside a worktree is still a guardrail path when the root is the main checkout", () => {
    const workflow = path.join(wt, ".github", "workflows", "ci.yml");
    expect(matchGuardrailPath(main, [workflow])).toMatchObject({ path: ".github/workflows/ci.yml" });
    // The real hook, with Claude Code's project dir on the MAIN checkout while the agent edits in a worktree.
    const r = runHook(preflightBundle, { tool_name: "Write", tool_input: { file_path: workflow, content: "name: ci" } }, { CLAUDE_PROJECT_DIR: main });
    expect(decisionOf(r.stdout)).toMatchObject({ permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("GUARDRAIL_ESCALATION") });
    // A path outside every checkout stays outside.
    expect(matchGuardrailPath(main, [path.join(base, "elsewhere", ".github", "workflows", "ci.yml")])).toBeNull();
  });

  it("checkpoint receipts compare equal across the worktree and the main checkout", () => {
    expect(canonicalizeWorktreePath(path.join(wt, "src", "config.ts")).path).toBe(path.join(main, "src", "config.ts"));
    expect(canonicalizeWorktreePath(path.join(main, "src", "config.ts")).path).toBe(path.join(main, "src", "config.ts"));
    // A receipt shaped exactly as file-store writes it for `src/config.ts`
    // (resolved against the canonical root), claimed by the real checkpoint
    // hook for an absolute edit in the worktree.
    const { sessionId } = deriveSessionId(main, "claude-session-532");
    const filePath = path.join(main, "src", "config.ts");
    const marker = path.join(main, ".deeppairing", "sessions", sessionId, "code-checkpoints",
      crypto.createHash("sha256").update(filePath).digest("hex") + ".json");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(marker, JSON.stringify({ version: 1, at, expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId, artifactId: "a1", filePath }));
    const r = runHook(checkpointScript, { tool_name: "Edit", session_id: "claude-session-532", tool_input: { file_path: path.join(wt, "src", "config.ts") } }, { CLAUDE_PROJECT_DIR: wt });
    expect(r.stderr).not.toContain("no present_code_change");
    expect(fs.existsSync(marker)).toBe(false); // consumed
  });

  it("does not redirect a submodule, a bare repo's worktree, a main checkout or a non-git dir", () => {
    // Submodule: its .git is a FILE too, but it points at .git/modules/<name> (no commondir).
    const lib = path.join(base, "lib-src");
    initRepo(lib);
    git(main, "submodule", "add", "-q", lib, "lib");
    const sub = path.join(main, "lib");
    expect(fs.statSync(path.join(sub, ".git")).isFile()).toBe(true);
    expect(findLinkedWorktree(sub)).toBeNull();
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: sub } }).projectRoot).toBe(sub);
    expect(resolveHookRoots(undefined, { CLAUDE_PROJECT_DIR: sub }).projectRoot).toBe(sub);

    // A worktree of a BARE repo has no main checkout to share with.
    const bare = path.join(base, "bare.git");
    git(base, "clone", "-q", "--bare", main, bare);
    const bareWt = path.join(base, "bare-wt");
    git(bare, "worktree", "add", "-q", bareWt, "main");
    expect(findLinkedWorktree(bareWt)).toBeNull();
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: bareWt } }).projectRoot).toBe(bareWt);

    // A main checkout and a plain directory are untouched.
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: main } }).projectRoot).toBe(main);
    const plain = path.join(base, "plain");
    fs.mkdirSync(plain);
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: plain } })).toEqual({ projectRoot: plain, source: "CLAUDE_PROJECT_DIR" });
    expect(resolveHookRoots(plain, {}).projectRoot).toBe(plain);
  });

  it("#536 P3 — a forged gitdir pointer (a crafted empty repo with worktrees/x/commondir) is NOT followed", () => {
    const victim = path.join(base, "wt-forged");
    git(main, "worktree", "add", "-q", victim, "-b", "forged");
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: victim } }).projectRoot).toBe(main);
    // An agent rewrites the worktree's .git to point at a crafted, empty repo.
    const crafted = path.join(base, "crafted");
    fs.mkdirSync(crafted);
    git(crafted, "init", "-q");
    const fake = path.join(crafted, ".git", "worktrees", "x");
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, "commondir"), "../..\n");
    fs.writeFileSync(path.join(victim, ".git"), `gitdir: ${fake}\n`);
    const resolved = resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: victim } });
    expect(resolved.projectRoot).toBe(victim); // not the crafted repo
    expect(resolved.worktree).toBeUndefined();
    expect(resolved.worktreeRejected).toMatch(/does not point back|back-reference/);
    expect(resolveHookRoots(undefined, { CLAUDE_PROJECT_DIR: victim }).projectRoot).toBe(victim);
    // A back-pointer to ANOTHER worktree's .git is rejected too.
    fs.writeFileSync(path.join(fake, "gitdir"), path.join(wt, ".git") + "\n");
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: victim } }).projectRoot).toBe(victim);
    // And a common dir that isn't a git dir.
    const notGit = path.join(base, "not-git", ".git", "worktrees", "y");
    fs.mkdirSync(notGit, { recursive: true });
    fs.writeFileSync(path.join(notGit, "commondir"), "../..\n");
    fs.writeFileSync(path.join(notGit, "gitdir"), path.join(victim, ".git") + "\n");
    fs.writeFileSync(path.join(base, "not-git", ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(victim, ".git"), `gitdir: ${notGit}\n`);
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: victim } })).toMatchObject({
      projectRoot: victim, worktreeRejected: expect.stringContaining("not a git directory"),
    });
  });

  it("#536 P3 — a garbage .git file gives no redirect, and says why", () => {
    const victim = path.join(base, "wt-garbage");
    git(main, "worktree", "add", "-q", victim, "-b", "garbage");
    fs.writeFileSync(path.join(victim, ".git"), "not a git link\n");
    const resolved = resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: victim } });
    expect(resolved).toMatchObject({ projectRoot: victim, worktreeRejected: expect.stringContaining('no "gitdir:" line') });
    expect(findLinkedWorktree(victim)).toBeNull();
  });

  it("#536 P3 — an agent Write to a linked worktree's .git FILE always asks (not a .git directory)", () => {
    for (const env of [{ CLAUDE_PROJECT_DIR: wt }, { CLAUDE_PROJECT_DIR: main }]) {
      for (const target of [path.join(wt, ".git"), path.join(wt, "src", "..", ".git")]) {
        const r = runHook(preflightBundle, { tool_name: "Write", tool_input: { file_path: target, content: "gitdir: /tmp/elsewhere" } }, env);
        expect(decisionOf(r.stdout), target).toMatchObject({
          permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("DEEPPAIRING_STATE"),
        });
      }
    }
    // The main checkout's .git DIRECTORY is not this class.
    const dir = runHook(preflightBundle, { tool_name: "Write", tool_input: { file_path: path.join(main, ".git"), content: "x" } }, { CLAUDE_PROJECT_DIR: main });
    expect(decisionOf(dir.stdout).permissionDecisionReason ?? "").not.toContain("DEEPPAIRING_STATE");
  });
});
