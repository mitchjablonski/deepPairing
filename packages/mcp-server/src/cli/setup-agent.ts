/**
 * #681 — `deeppairing setup-agent --agent codex|cursor|copilot|opencode [--dry-run]`.
 *
 * Writes a short marked block into the agent's own project instruction file
 * telling it to run `deeppairing guide` at the start of a task. The block
 * carries no protocol text: the guide (cli/standalone-guide.ts) is the single
 * source of truth.
 *
 * Instruction files, per each tool's docs:
 *  - codex:    AGENTS.md at the project root. Codex walks from the Git root
 *              down to the cwd reading AGENTS.override.md / AGENTS.md
 *              (learn.chatgpt.com/docs/agent-configuration/agents-md).
 *  - opencode: AGENTS.md at the project root, read before its CLAUDE.md
 *              fallback (opencode.ai/docs/rules).
 *  - cursor:   .cursor/rules/*.mdc with frontmatter; `alwaysApply: true`
 *              includes the rule in every chat (cursor.com/docs/context/rules).
 *  - copilot:  .github/copilot-instructions.md, the repository-wide custom
 *              instructions file (docs.github.com, "Adding repository custom
 *              instructions for GitHub Copilot").
 *
 * The project root is the Git toplevel of the directory the command runs in
 * (a linked worktree writes into that worktree; a subdirectory writes at the
 * repo root, where the tools look), falling back to that directory outside a
 * repo. CLAUDE_PROJECT_DIR / DEEPPAIRING_PROJECT_ROOT are deliberately NOT
 * consulted: they describe a daemon's project, not where the human is.
 *
 * Safety rules: only the text between the markers is ever replaced (content
 * outside it is preserved byte for byte, line endings and BOM included); a
 * rerun replaces the block rather than adding a second one; an existing file
 * is backed up before it changes; non-UTF-8, read-only and non-regular files
 * are refused; a hard-linked file is rewritten in place so its links stay
 * joined; nothing is written through a symlink or outside the project root;
 * and `--dry-run` prints the diff and writes nothing.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export const SETUP_AGENT_TARGETS = {
  codex: "AGENTS.md",
  opencode: "AGENTS.md",
  cursor: ".cursor/rules/deeppairing.mdc",
  copilot: ".github/copilot-instructions.md",
} as const;

export type SetupAgentName = keyof typeof SETUP_AGENT_TARGETS;

export const BLOCK_START = "<!-- deeppairing:start -->";
export const BLOCK_END = "<!-- deeppairing:end -->";

export const SETUP_AGENT_USAGE = "Usage: deeppairing setup-agent --agent codex|cursor|copilot|opencode [--dry-run]";

const CURSOR_FRONTMATTER = `---
description: deepPairing review loop. Run the deepPairing guide at the start of a task.
alwaysApply: true
---
`;

/** The marked block. `guideCommand` is the full invocation of `deeppairing guide`. */
export function renderAgentBlock(guideCommand: string): string {
  return `${BLOCK_START}
## deepPairing

At the start of every task, run \`${guideCommand}\` and follow the protocol it
prints. It tells you when to present decisions or pages to your human for
review in the deepPairing companion, and how to read their answers.
${BLOCK_END}`;
}

export interface SetupAgentResult {
  agent: SetupAgentName;
  /** Project-relative path of the instruction file. */
  file: string;
  /** Absolute path of the instruction file. */
  absolutePath: string;
  action: "created" | "updated" | "unchanged";
  dryRun: boolean;
  /** Absolute path of the backup, when an existing file was changed for real. */
  backupPath?: string;
  /** Line diff of the change ("" when unchanged). */
  diff: string;
  /** Things the human should know (e.g. a Codex override file that shadows AGENTS.md). */
  warnings: string[];
}

export interface SetupAgentOptions {
  projectRoot: string;
  agent: SetupAgentName;
  guideCommand: string;
  dryRun?: boolean;
  /** Injectable clock for the backup name. */
  now?: () => Date;
}

export function isSetupAgentName(value: string): value is SetupAgentName {
  return Object.prototype.hasOwnProperty.call(SETUP_AGENT_TARGETS, value);
}

/**
 * Where setup-agent writes: the Git toplevel of `cwd` (the worktree root in a
 * linked worktree), else `cwd` itself. Git env overrides are stripped so the
 * answer depends only on the directory, and project-root env vars are never read.
 */
export function resolveSetupRoot(cwd: string): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
    }).trim();
    if (top) return path.resolve(top);
  } catch { /* not a repo, or no git: fall back to cwd */ }
  return path.resolve(cwd);
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve the target and refuse anything that could land outside the project:
 * a symlinked parent directory or file, or a non-regular file at the target.
 */
function resolveContainedTarget(projectRoot: string, rel: string): string {
  const root = fs.realpathSync(projectRoot);
  const target = path.join(root, rel);
  if (!isInside(root, target)) throw new Error(`${rel} resolves outside the project root (${root}).`);
  let current = root;
  for (const segment of rel.split("/")) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break; // the rest gets created inside root
      throw err;
    }
    const isTarget = current === target;
    if (stat.isSymbolicLink()) {
      throw new Error(`${path.relative(root, current)} is a symlink; refusing to write through it. Replace it with a real ${isTarget ? "file" : "directory"} or edit the file by hand.`);
    }
    if (isTarget ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`${path.relative(root, current)} is not a ${isTarget ? "regular file" : "directory"}.`);
    }
  }
  return target;
}

/** Create the target's missing parent directories one at a time, checking each. */
function makeParents(projectRoot: string, rel: string): void {
  const root = fs.realpathSync(projectRoot);
  let current = root;
  for (const segment of rel.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${path.relative(root, current)} is not a real directory; refusing to write through it.`);
    }
  }
}

/** Count non-overlapping occurrences of `needle`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode strictly, keeping any BOM as U+FEFF so it round-trips. */
function decodeUtf8(bytes: Buffer, file: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`${file} is not valid UTF-8; refusing to edit it. Convert it to UTF-8, or add the deepPairing block by hand.`);
  }
}

function hasFrontmatter(text: string): boolean {
  return /^﻿?---\r?\n/.test(text);
}

/** New file content: the block replaced in place, or appended after the existing text. */
function nextContent(existing: string | null, rawBlock: string, agent: SetupAgentName, file: string): string {
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const withEol = (text: string) => text.replace(/\n/g, eol);
  const block = withEol(rawBlock);
  const frontmatter = agent === "cursor" ? withEol(CURSOR_FRONTMATTER + "\n") : "";
  if (existing === null || existing.length === 0) return `${frontmatter}${block}${eol}`;

  const starts = count(existing, BLOCK_START);
  const ends = count(existing, BLOCK_END);
  let next: string;
  if (starts === 0 && ends === 0) {
    const sep = existing.endsWith(eol + eol) ? "" : existing.endsWith(eol) ? eol : eol + eol;
    next = `${existing}${sep}${block}${eol}`;
  } else {
    const start = existing.indexOf(BLOCK_START);
    const end = existing.indexOf(BLOCK_END);
    if (starts !== 1 || ends !== 1 || end < start) {
      throw new Error(`${file} has unmatched or repeated deepPairing markers (${BLOCK_START} … ${BLOCK_END}). Fix them by hand so there is exactly one block, then rerun.`);
    }
    next = existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
  }
  // A Cursor rule without frontmatter never loads automatically; give it one.
  if (frontmatter && !hasFrontmatter(next)) {
    const bom = next.startsWith("﻿") ? "﻿" : "";
    next = bom + frontmatter + next.slice(bom.length);
  }
  return next;
}

/**
 * A compact line diff for a single localized change: the common prefix and
 * suffix are trimmed and the differing middle is shown as -/+ lines.
 */
export function lineDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const lines = (text: string) => (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/));
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  return [
    `--- ${before === "" ? "/dev/null" : `a/${file}`}`,
    `+++ b/${file}`,
    // Unified-diff convention: an empty range names the line before it.
    `@@ -${removed.length ? head + 1 : head},${removed.length} +${added.length ? head + 1 : head},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

export function setupAgent(opts: SetupAgentOptions): SetupAgentResult {
  const file = SETUP_AGENT_TARGETS[opts.agent];
  const target = resolveContainedTarget(opts.projectRoot, file);
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  const existing = stat ? decodeUtf8(fs.readFileSync(target), file) : null;
  const after = nextContent(existing, renderAgentBlock(opts.guideCommand), opts.agent, file);
  const dryRun = opts.dryRun === true;
  const warnings: string[] = [];
  if (opts.agent === "codex" && fs.existsSync(path.join(path.dirname(target), "AGENTS.override.md"))) {
    warnings.push("AGENTS.override.md exists at the project root, and Codex reads it INSTEAD of AGENTS.md. Copy the deepPairing block into it, or remove the override.");
  }
  const base = { agent: opts.agent, file, absolutePath: target, dryRun, warnings };
  if (existing === after) return { ...base, action: "unchanged", diff: "" };
  const diff = lineDiff(file, existing ?? "", after);
  const action = existing === null ? "created" : "updated";
  if (dryRun) return { ...base, action, diff };

  const bytes = Buffer.from(after, "utf8");
  let backupPath: string | undefined;
  if (stat) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new Error(`${file} is read-only; refusing to replace it. Make it writable if you want deepPairing to edit it.`);
    }
    const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backupPath = `${target}.deeppairing-backup-${stamp}`;
    fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
    if (stat.nlink > 1) {
      // Rewrite in place: a rename would split the file from its other links.
      resolveContainedTarget(opts.projectRoot, file);
      fs.writeFileSync(target, bytes);
      return { ...base, action, diff, backupPath };
    }
  } else {
    makeParents(opts.projectRoot, file);
  }
  const tmp = `${target}.deeppairing-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
  try {
    fs.chmodSync(tmp, stat ? stat.mode & 0o777 : 0o666 & ~process.umask());
    // Narrow the window: nothing on the path may have become a link since we checked.
    resolveContainedTarget(opts.projectRoot, file);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  return { ...base, action, diff, ...(backupPath ? { backupPath } : {}) };
}

/**
 * Parse argv (after `setup-agent`), run, and render the human-readable report.
 * `cwd` is the directory the command runs in; the root is resolved from it.
 */
export function runSetupAgentCommand(cwd: string, args: string[], guideCommand: string): string {
  const { values } = parseArgs({
    args,
    options: { agent: { type: "string" }, "dry-run": { type: "boolean" } },
    strict: true,
  });
  const agent = values.agent;
  if (!agent || !isSetupAgentName(agent)) throw new Error(SETUP_AGENT_USAGE);
  const result = setupAgent({ projectRoot: resolveSetupRoot(cwd), agent, guideCommand, dryRun: values["dry-run"] === true });
  const lines: string[] = [];
  if (result.action === "unchanged") {
    lines.push(`${result.absolutePath} already has the current deepPairing block. Nothing to do.`);
  } else if (result.dryRun) {
    lines.push(`Dry run: would ${result.action === "created" ? "create" : "update"} ${result.absolutePath}. Nothing written.`, "", result.diff);
  } else {
    lines.push(`${result.action === "created" ? "Created" : "Updated"} ${result.absolutePath} with the deepPairing block.`);
    if (result.backupPath) lines.push(`Backup of the previous file: ${result.backupPath}`);
    lines.push(`Your agent will now run \`${guideCommand}\` at the start of a task.`);
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}
