/**
 * #681 — `deeppairing setup-agent` against real temp project directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_END,
  BLOCK_START,
  SETUP_AGENT_TARGETS,
  resolveSetupRoot,
  runSetupAgentCommand,
  setupAgent,
  type SetupAgentName,
} from "../setup-agent.js";

const GUIDE = "npx -y -p @deeppairing/mcp-server deeppairing guide";
const AGENTS = Object.keys(SETUP_AGENT_TARGETS) as SetupAgentName[];

let root: string;
let outside: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-setup-agent-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "dp-setup-agent-outside-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
/** Cursor rules gain frontmatter when they lack it; compare the rest. */
const withoutCursorFrontmatter = (agent: SetupAgentName, text: string) =>
  agent === "cursor" ? text.replace(/^---\n[\s\S]*?\n---\n\n/, "") : text;
const blocks = (text: string) => text.split(BLOCK_START).length - 1;
const backups = (rel: string) =>
  fs.readdirSync(path.dirname(path.join(root, rel))).filter((f) => f.startsWith(`${path.basename(rel)}.deeppairing-backup-`));

describe.each(AGENTS)("setup-agent --agent %s", (agent) => {
  const rel = SETUP_AGENT_TARGETS[agent];

  it("creates the instruction file with one block that runs the guide", () => {
    const result = setupAgent({ projectRoot: root, agent, guideCommand: GUIDE });
    expect(result.action).toBe("created");
    const text = read(rel);
    expect(blocks(text)).toBe(1);
    expect(text).toContain(BLOCK_END);
    expect(text).toContain(`\`${GUIDE}\``);
    if (agent === "cursor") expect(text).toMatch(/^---\n[\s\S]*alwaysApply: true\n---\n/);
    expect(backups(rel)).toEqual([]);
  });

  it("is idempotent: a second run leaves exactly one block and writes nothing", () => {
    setupAgent({ projectRoot: root, agent, guideCommand: GUIDE });
    const first = read(rel);
    const again = setupAgent({ projectRoot: root, agent, guideCommand: GUIDE });
    expect(again.action).toBe("unchanged");
    expect(read(rel)).toBe(first);
    expect(blocks(read(rel))).toBe(1);
  });

  it("replaces a stale block in place, preserves outside content and backs up first", () => {
    const before = "# Project rules\n\nUse tabs.\n";
    const after = "\n## Later section\n\nKeep this.\n";
    const original = `${before}${BLOCK_START}\nold text\n${BLOCK_END}${after}`;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), original);

    const result = setupAgent({ projectRoot: root, agent, guideCommand: GUIDE, now: () => new Date("2026-11-22T10:00:00Z") });
    expect(result.action).toBe("updated");
    const text = withoutCursorFrontmatter(agent, read(rel));
    expect(text.startsWith(before)).toBe(true);
    expect(text.endsWith(after)).toBe(true);
    expect(text).not.toContain("old text");
    expect(blocks(text)).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(fs.readFileSync(result.backupPath!, "utf8")).toBe(original);
    expect(backups(rel)).toHaveLength(1);
  });

  it("appends to an existing file without markers, keeping its content intact", () => {
    const original = "Existing instructions, no trailing newline";
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), original);
    setupAgent({ projectRoot: root, agent, guideCommand: GUIDE });
    const text = withoutCursorFrontmatter(agent, read(rel));
    expect(text.startsWith(`${original}\n\n${BLOCK_START}`)).toBe(true);
    expect(blocks(text)).toBe(1);
    expect(backups(rel)).toHaveLength(1);
  });

  it("--dry-run prints the diff and writes nothing", () => {
    const output = runSetupAgentCommand(root, ["--agent", agent, "--dry-run"], GUIDE);
    expect(output).toContain("Nothing written");
    expect(output).toContain(`+++ b/${rel}`);
    expect(output).toContain(`+${BLOCK_START}`);
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);

    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "keep\n");
    const update = runSetupAgentCommand(root, ["--agent", agent, "--dry-run"], GUIDE);
    expect(update).toContain("would update");
    expect(read(rel)).toBe("keep\n");
    expect(backups(rel)).toEqual([]);
  });

  it("refuses to write through a symlink that leaves the project root", () => {
    const [first] = rel.split("/");
    if (rel.includes("/")) {
      fs.symlinkSync(outside, path.join(root, first!), "dir");
    } else {
      fs.writeFileSync(path.join(outside, "target.md"), "outside\n");
      fs.symlinkSync(path.join(outside, "target.md"), path.join(root, rel));
    }
    expect(() => setupAgent({ projectRoot: root, agent, guideCommand: GUIDE })).toThrow(/symlink/);
    expect(fs.readdirSync(outside).filter((f) => f !== "target.md")).toEqual([]);
    if (!rel.includes("/")) expect(fs.readFileSync(path.join(outside, "target.md"), "utf8")).toBe("outside\n");
  });
});

describe("setup-agent guards", () => {
  it("refuses repeated or unmatched markers instead of guessing", () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), `${BLOCK_START}\na\n${BLOCK_END}\n${BLOCK_START}\nb\n${BLOCK_END}\n`);
    expect(() => setupAgent({ projectRoot: root, agent: "codex", guideCommand: GUIDE })).toThrow(/markers/);
    fs.writeFileSync(path.join(root, "AGENTS.md"), `${BLOCK_START}\nno end\n`);
    expect(() => setupAgent({ projectRoot: root, agent: "codex", guideCommand: GUIDE })).toThrow(/markers/);
  });

  it("rejects an unknown agent with the usage line", () => {
    expect(() => runSetupAgentCommand(root, ["--agent", "vim"], GUIDE)).toThrow(/Usage: deeppairing setup-agent/);
    expect(() => runSetupAgentCommand(root, [], GUIDE)).toThrow(/Usage/);
  });

  it("codex and opencode share AGENTS.md and one block", () => {
    setupAgent({ projectRoot: root, agent: "codex", guideCommand: GUIDE });
    const second = setupAgent({ projectRoot: root, agent: "opencode", guideCommand: GUIDE });
    expect(second.action).toBe("unchanged");
    expect(blocks(read("AGENTS.md"))).toBe(1);
  });
});

// --- #681 review follow-ups -------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "..", "init.ts");
const tsxBin = path.resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    cwd, env: cleanGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}
function initRepo(dir: string): void {
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "README.md"), "repo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
}

describe("setup-agent writes where the human is (git toplevel of cwd)", () => {
  it("from a subdirectory, writes at the repo root and prints the absolute path", () => {
    initRepo(root);
    const sub = path.join(root, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    const out = runSetupAgentCommand(sub, ["--agent", "copilot"], GUIDE);
    const real = fs.realpathSync(root);
    expect(fs.existsSync(path.join(root, ".github", "copilot-instructions.md"))).toBe(true);
    expect(fs.existsSync(path.join(sub, ".github"))).toBe(false);
    expect(out).toContain(path.join(real, ".github", "copilot-instructions.md"));
  });

  it("in a linked worktree, writes into that worktree, not the main checkout", () => {
    initRepo(root);
    const wt = path.join(outside, "wt");
    git(root, "worktree", "add", "-q", wt);
    expect(resolveSetupRoot(wt)).toBe(fs.realpathSync(wt));
    runSetupAgentCommand(wt, ["--agent", "codex"], GUIDE);
    expect(fs.existsSync(path.join(wt, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false);
  });

  it("outside a repo, falls back to the directory itself", () => {
    expect(resolveSetupRoot(root)).toBe(path.resolve(root));
  });

  it("the real CLI ignores CLAUDE_PROJECT_DIR / DEEPPAIRING_PROJECT_ROOT", () => {
    initRepo(root);
    const sub = path.join(root, "src");
    fs.mkdirSync(sub);
    const decoy = path.join(outside, "decoy");
    fs.mkdirSync(decoy);
    const env = { ...cleanGitEnv(), CLAUDE_PROJECT_DIR: decoy, DEEPPAIRING_PROJECT_ROOT: decoy, DEEPPAIRING_NO_OPEN: "1" };
    const run = spawnSync(tsxBin, [cliEntry, "setup-agent", "--agent", "codex"], { cwd: sub, env, encoding: "utf8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(true);
    expect(fs.readdirSync(decoy)).toEqual([]);
    expect(run.stdout).toContain(path.join(fs.realpathSync(root), "AGENTS.md"));
  }, 60_000);
});

describe("setup-agent file intent", () => {
  it("refuses a non-UTF-8 file without touching it", () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in latin1
    fs.writeFileSync(path.join(root, "AGENTS.md"), latin1);
    expect(() => setupAgent({ projectRoot: root, agent: "codex", guideCommand: GUIDE })).toThrow(/not valid UTF-8/);
    expect(fs.readFileSync(path.join(root, "AGENTS.md")).equals(latin1)).toBe(true);
    expect(backups("AGENTS.md")).toEqual([]);
  });

  it("keeps a BOM and CRLF line endings, and the inserted block uses CRLF", () => {
    const original = "\uFEFF# Rules\r\n\r\nUse tabs.\r\n";
    fs.writeFileSync(path.join(root, "AGENTS.md"), original);
    setupAgent({ projectRoot: root, agent: "codex", guideCommand: GUIDE });
    const text = read("AGENTS.md");
    expect(text.startsWith(original)).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(setupAgent({ projectRoot: root, agent: "codex", guideCommand: GUIDE }).action).toBe("unchanged");
  });

  it.skipIf(process.getuid?.() === 0)("refuses a read-only file", () => {
    const file = path.join(root, "AGENTS.md");
    fs.writeFileSync(file, "locked\n");
    fs.chmodSync(file, 0o444);
    expect(() => setupAgent({ projectRoot: root, agent: "codex", guideCommand: GUIDE })).toThrow(/read-only/);
    expect(read("AGENTS.md")).toBe("locked\n");
    expect(backups("AGENTS.md")).toEqual([]);
  });

  it("rewrites a hard-linked file in place so the links stay joined", () => {
    const file = path.join(root, "AGENTS.md");
    const twin = path.join(outside, "twin.md");
    fs.writeFileSync(file, "shared\n");
    fs.linkSync(file, twin);
    setupAgent({ projectRoot: root, agent: "codex", guideCommand: GUIDE });
    expect(fs.statSync(file).nlink).toBe(2);
    expect(fs.readFileSync(twin, "utf8")).toBe(read("AGENTS.md"));
    expect(read("AGENTS.md")).toContain(BLOCK_START);
  });

  it("adds alwaysApply frontmatter to an existing Cursor rule that lacks it", () => {
    fs.mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, SETUP_AGENT_TARGETS.cursor), "My notes.\n");
    setupAgent({ projectRoot: root, agent: "cursor", guideCommand: GUIDE });
    const text = read(SETUP_AGENT_TARGETS.cursor);
    expect(text).toMatch(/^---\n[\s\S]*alwaysApply: true\n---\n/);
    expect(text).toContain("My notes.\n");
    expect(setupAgent({ projectRoot: root, agent: "cursor", guideCommand: GUIDE }).action).toBe("unchanged");
  });

  it("warns when AGENTS.override.md shadows AGENTS.md for Codex", () => {
    fs.writeFileSync(path.join(root, "AGENTS.override.md"), "override\n");
    const out = runSetupAgentCommand(root, ["--agent", "codex"], GUIDE);
    expect(out).toMatch(/Warning: AGENTS\.override\.md exists/);
    expect(runSetupAgentCommand(root, ["--agent", "opencode"], GUIDE)).not.toContain("Warning");
  });
});
