/**
 * #681 — `deeppairing setup-agent` against real temp project directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BLOCK_END,
  BLOCK_START,
  SETUP_AGENT_TARGETS,
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
    const text = read(rel);
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
    const text = read(rel);
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
