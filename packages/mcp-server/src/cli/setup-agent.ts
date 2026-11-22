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
 * Safety rules: only the text between the markers is ever replaced (content
 * outside it is preserved byte for byte); a rerun replaces the block rather
 * than adding a second one; an existing file is backed up before it changes;
 * nothing is written through a symlink or outside the project root; and
 * `--dry-run` prints the diff and writes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { writeStringAtomic } from "../store/atomic-write.js";

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
  action: "created" | "updated" | "unchanged";
  dryRun: boolean;
  /** Absolute path of the backup, when an existing file was changed for real. */
  backupPath?: string;
  /** Line diff of the change ("" when unchanged). */
  diff: string;
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
    if (stat.isSymbolicLink()) {
      throw new Error(`${path.relative(root, current)} is a symlink; refusing to write through it. Replace it with a real ${current === target ? "file" : "directory"} or edit the file by hand.`);
    }
    if (current === target ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`${path.relative(root, current)} is not a ${current === target ? "regular file" : "directory"}.`);
    }
  }
  return target;
}

/** Count non-overlapping occurrences of `needle`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** New file content: the block replaced in place, or appended after the existing text. */
function nextContent(existing: string | null, block: string, agent: SetupAgentName, file: string): string {
  if (existing === null) return `${agent === "cursor" ? CURSOR_FRONTMATTER + "\n" : ""}${block}\n`;
  const starts = count(existing, BLOCK_START);
  const ends = count(existing, BLOCK_END);
  if (starts === 0 && ends === 0) {
    if (existing.length === 0) return `${agent === "cursor" ? CURSOR_FRONTMATTER + "\n" : ""}${block}\n`;
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${sep}${block}\n`;
  }
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new Error(`${file} has unmatched or repeated deepPairing markers (${BLOCK_START} … ${BLOCK_END}). Fix them by hand so there is exactly one block, then rerun.`);
  }
  return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
}

/**
 * A compact line diff for a single localized change: the common prefix and
 * suffix are trimmed and the differing middle is shown as -/+ lines.
 */
export function lineDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
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
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  const after = nextContent(existing, renderAgentBlock(opts.guideCommand), opts.agent, file);
  const dryRun = opts.dryRun === true;
  const base = { agent: opts.agent, file, dryRun };
  if (existing === after) return { ...base, action: "unchanged", diff: "" };
  const diff = lineDiff(file, existing ?? "", after);
  const action = existing === null ? "created" : "updated";
  if (dryRun) return { ...base, action, diff };

  let backupPath: string | undefined;
  let mode: number | undefined;
  if (existing !== null) {
    mode = fs.statSync(target).mode & 0o777;
    const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backupPath = `${target}.deeppairing-backup-${stamp}`;
    fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Re-check after creating parents: nothing may have been swapped for a link.
    resolveContainedTarget(opts.projectRoot, file);
  }
  writeStringAtomic(target, after, mode === undefined ? undefined : { mode });
  return { ...base, action, diff, ...(backupPath ? { backupPath } : {}) };
}

/** Parse argv (after `setup-agent`), run, and render the human-readable report. */
export function runSetupAgentCommand(projectRoot: string, args: string[], guideCommand: string): string {
  const { values } = parseArgs({
    args,
    options: { agent: { type: "string" }, "dry-run": { type: "boolean" } },
    strict: true,
  });
  const agent = values.agent;
  if (!agent || !isSetupAgentName(agent)) throw new Error(SETUP_AGENT_USAGE);
  const result = setupAgent({ projectRoot, agent, guideCommand, dryRun: values["dry-run"] === true });
  if (result.action === "unchanged") return `${result.file} already has the current deepPairing block. Nothing to do.`;
  if (result.dryRun) return `Dry run: would ${result.action === "created" ? "create" : "update"} ${result.file}. Nothing written.\n\n${result.diff}`;
  const lines = [`${result.action === "created" ? "Created" : "Updated"} ${result.file} with the deepPairing block.`];
  if (result.backupPath) lines.push(`Backup of the previous file: ${result.backupPath}`);
  lines.push(`Your agent will now run \`${guideCommand}\` at the start of a task.`);
  return lines.join("\n");
}
