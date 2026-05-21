#!/usr/bin/env node
/**
 * deepPairing init — sets up a project for deepPairing collaboration.
 *
 * Usage: npx deeppairing init
 *
 * Creates:
 * - .mcp.json with deepPairing MCP server configuration
 * - Appends .deeppairing/ to .gitignore
 * - Copies skill file as .deeppairing.md (or shows instructions)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, MAX_PORT_ATTEMPTS, probeDaemonIdentity, evictDaemon } from "../daemon-lifecycle.js";
import {
  ensureDeepPairingDir,
  ensureGitignoreEntry,
  ensureStopHook,
  ensureCheckpointHook,
  HOOK_MARKERS,
} from "./setup-tasks.js";
import readline from "node:readline";

const cwd = process.cwd();

/** Embedded protocol template — ensures CLAUDE.md injection never fails */
const EMBEDDED_PROTOCOL = `# deepPairing Collaboration Protocol

**IMPORTANT: You have deepPairing MCP tools available. Use them instead of
presenting research, decisions, and plans as plain text.**

## When to Use deepPairing Tools

**Always use present_findings** when you have research results or code analysis.
**Always use present_options** when there are 2+ valid approaches.
**Always use present_plan** before multi-file changes.
**Always use present_code_change** for code review with before/after context.
**Always use log_reasoning** before every Edit or Write. **Name the underlying
concept** via the concept field (name + one-line explanation) — this is how
the human learns the pattern, not just the fix. Name it even when it feels
obvious.

## Polling for Feedback

After presenting artifacts, call check_feedback in a loop. Each call waits up
to 30 seconds. If it returns WAITING, call it again immediately — do NOT stop
to ask the user in the terminal. The human responds in the companion UI browser.

## Replying to Human Comments — Mirror Into the UI

When a human comment lands in check_feedback (whether intent="question" OR a
plain comment with a substantive thought), reply via \`answer_question\`
FIRST so the response shows up in the companion UI under their comment.
Talking only in chat is invisible to the conversation rail and the user
can't tell whether you saw their comment.

Rule: any reply that addresses a human comment must call \`answer_question\`
with the parent commentId. You can ALSO elaborate in chat — that's fine —
but the answer_question call is mandatory. The chat is for thinking out
loud; the UI is the durable record.

If you have a substantive REVISION as a result of the comment (e.g. the
human pointed out a flaw in your plan), call answer_question to acknowledge
AND then call revise_artifact to actually update the work — don't just
describe the change in the answer.

## Continuing Threads (Reply Follow-Ups)

When you call \`answer_question\`, the human can reply back to your answer
via the companion UI (Reply button on every agent chip + on every
ConversationRail row). Their reply lands as a new comment whose
\`parentCommentId\` points at one of your previous \`answer_question\`
replies — that's a follow-up in an existing thread, not a new top-level
question.

Required response: call \`answer_question\` AGAIN with the new comment's
id as the \`commentId\`. Keep the thread going. Do NOT start a new
top-level comment via \`addComment\` — that fragments the conversation
and the rail loses the parent/child link.

Pattern:
  - You posted answer A1 via \`answer_question(parent=Q1)\`
  - Human replied → check_feedback returns comment R1 with parentCommentId=A1
  - You call \`answer_question(parent=R1, answer=...)\` to continue
  - Repeat as long as the human keeps replying. The conversation rail
    shows the full thread nested under the original question.

## Decision Revision Requests

If you see a comment on a decision artifact whose target carries
\`sectionId: "decision_revision_requested"\`, the human is asking you to
REVISE the options, not just answer a question about them. Required
response:
  1. Call \`revise_artifact\` with mode="supersede" on the decision artifact.
  2. The new artifact replaces the old; record the revised option set
     incorporating the human's feedback.
  3. Briefly call \`answer_question\` on the original comment so they see
     "↻ Revised — see decision v2" in the rail.
  4. Do NOT just call \`answer_question\` and leave the original options on
     the table. The human explicitly asked for a revision.

## Single Review Surface

The companion UI is the ONLY review surface for any artifact you present. After
calling present_findings / present_options / present_spec / present_plan /
present_code_change, do NOT also:
- Paste the artifact contents into chat for the user to read.
- Ask the user "approve?" or "shall I proceed?" in the terminal.
- Call ExitPlanMode after present_plan — present_plan REPLACES Claude Code's
  native plan-approval flow for this work.

Layering a terminal prompt on top of a deepPairing artifact creates two
parallel approval surfaces. The user accepts in one, you proceed, but the
artifact stays \`draft\` in the other — and the Stop hook will trap the agent
in a poll loop. One artifact, one surface. Then check_feedback.

## Per-Edit Checkpoint (Cadence Rule)

A green-lit plan is NOT a green light to ship every edit silently. The whole
point of pairing is that the human sees and reacts to each change AS you make
it — not as a wall of commits at the end.

For any plan with more than one file change:
- Call \`log_reasoning\` BEFORE each Write/Edit/MultiEdit (WHY you're about to write).
- Call \`present_code_change\` BEFORE each Write/Edit/MultiEdit on a file the user
  hasn't already approved this session (WHAT you're about to write).
- Then call \`check_feedback\`. Don't skip ahead to the next edit.

If you find yourself thinking "I'll batch the small ones together" — that's the
exact failure mode this rule exists to prevent. The user's "kick off the next
item" or "looks good" was direction for the NEXT step, not approval for the
five steps after that. When in doubt, checkpoint.

### What does NOT need a checkpoint

A narrow set of files auto-skip the checkpoint rule — only things that are
unambiguously NOT human-authored decisions. The PostToolUse hook lets these
through silently:
- Lockfiles: \`package-lock.json\`, \`pnpm-lock.yaml\`, \`uv.lock\`,
  \`Cargo.lock\`, \`Gemfile.lock\`, \`go.sum\`, \`composer.lock\`, etc.
  (Lockfiles are regenerated from manifests; the manifest is the decision.)
- Generated / vendored paths: \`dist/\`, \`build/\`, \`node_modules/\`,
  \`.deeppairing/\`, \`.next/\`, \`.turbo/\`, \`coverage/\`.
- IDE-local config dirs: \`.vscode/\`, \`.idea/\` (workspace settings, not
  project policy).

Config / policy files DO need a checkpoint. \`.gitignore\`, \`package.json\`,
\`.npmrc\`, \`.prettierrc\`, \`.github/\` workflows — these are real decisions
a paired human should react to. Don't batch them silently with other work.

If you're touching a config file as part of a larger arc, the 60-second
freshness window means a recent \`present_code_change\` covers incidental
edits — call the checkpoint for the main change, then the trailing config
tweaks pass through.

The PostToolUse hook (installed by \`npx deeppairing init\`) enforces this: if
you Write/Edit a non-skip file without an intervening present_code_change,
the hook nags and forces you to checkpoint before continuing.

## Workflow

1. GATHER: Research the codebase
2. PRESENT: Call present_findings with rich evidence
3. POLL: Call check_feedback in a loop until approved
4. DECIDE: Call present_options, poll until selected
5. PLAN: Call present_plan, poll until approved
6. EXECUTE: Call log_reasoning before each change

The companion UI URL is shown in your first tool call response.

## Rejected Approaches & Retraction

Your first tool call of every session returns a list of approaches the human
previously rejected. Do NOT propose those — present_findings / present_options
/ present_plan / present_code_change will refuse the call with a
REJECTED_APPROACH_BLOCKED error if you try.

If you realize mid-flight that you shouldn't have presented an artifact
(e.g. you noticed an error after the fact), call revise_artifact with mode
"retract", the artifact id, and a short reason. Do NOT bail out to the
terminal. Keep polling check_feedback for the human's response.
`;
const __thisDir = path.dirname(fileURLToPath(import.meta.url));

function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}
function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}
function yellow(text: string): string {
  return `\x1b[33m${text}\x1b[0m`;
}
function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}
function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

/**
 * Determine the right MCP server command for .mcp.json.
 * If running from a local dev checkout (not npm), use `node` with the absolute
 * path to the compiled standalone.js. Otherwise use `npx @deeppairing/mcp-server`.
 */
function getMcpServerConfig(): { command: string; args: string[] } {
  // Check if the compiled standalone.js exists next to this script
  const standaloneJs = path.join(__thisDir, "../standalone.js");
  const isLocalDev = fs.existsSync(standaloneJs);

  if (isLocalDev) {
    // Running from local monorepo — use absolute path to dist
    const absolutePath = path.resolve(standaloneJs);
    return { command: "node", args: [absolutePath] };
  }
  // Running from npm install — use npx
  return { command: "npx", args: ["@deeppairing/mcp-server"] };
}

/**
 * II10 — minimal stub variant of the embedded protocol. Council UX
 * reviewer flagged that the full ~150-line EMBEDDED_PROTOCOL injected
 * into CLAUDE.md is intimidating on first sight and a cautious developer
 * backs out of `init` once they see CLAUDE.md grew by 4KB of agent
 * directives. The minimal stub gives the agent the load-bearing
 * pointers (call deeppairing's MCP tools; respect the single review
 * surface; read the full doc) without the wall-of-rules.
 */
const MINIMAL_PROTOCOL = `# deepPairing Collaboration Protocol (minimal)

When deepPairing's MCP server is loaded, use it as the single review
surface for findings, options, plans, code changes, and reasoning. Do
NOT duplicate the same content as prose in chat — the human is reviewing
in the companion UI at http://localhost:3847.

After every \`present_*\` call, expect to receive feedback via
\`check_feedback\` rather than continuing immediately. Re-run preflight
context (read \`deeppairing://session/onboarding\`) at session start so
you know what's already been rejected before proposing anything.

For the full protocol (per-edit checkpoints, decision-revision
semantics, comment-mirror via \`answer_question\`, Stop hook flow):
run \`node packages/mcp-server/dist/cli/init.js init\` without
\`--minimal\` to inject the full version, or read it inline in this
repo's \`packages/mcp-server/src/cli/init.ts\` (EMBEDDED_PROTOCOL).
`;

async function main(opts: { offerDemo?: boolean; yes?: boolean; dryRun?: boolean; minimal?: boolean } = { offerDemo: true }) {
  const dryRun = opts.dryRun === true;
  const minimal = opts.minimal === true;
  console.log(bold("\n  deepPairing init" + (dryRun ? " — DRY RUN" : minimal ? " — minimal mode (CLAUDE.md gets a short stub)" : "") + "\n"));
  if (dryRun) {
    // II10 — the dry-run intercepts the two writes the UX reviewer
    // flagged as scary on first install: .mcp.json and the CLAUDE.md
    // protocol append. Helper-driven side effects under .deeppairing/
    // and .claude/ still happen (gitignore entry, Stop hook,
    // PostToolUse checkpoint hook) because those helpers are shared
    // with the daemon's startup setup and are idempotent + small. The
    // goal of --dry-run is "show me the scary changes before I commit"
    // not "no I/O at all" — surface that explicitly so the user isn't
    // surprised by the directory entries that DO land.
    console.log(`  ${dim("(--dry-run skips .mcp.json + CLAUDE.md writes; .deeppairing/ + hook setup still run — those are idempotent and small)")}\n`);
  }

  // II10 — wrap every write so --dry-run skips it but prints what would
  // have been written. Keeps the existing call-site shape so the four
  // writeFileSync / appendFileSync / copyFileSync sites in this function
  // don't have to be rearranged. Output describes the intent in the same
  // voice the existing console.log lines use so the dry-run feels like a
  // dress rehearsal, not a separate codepath.
  const writeFile = (p: string, content: string, label: string): void => {
    if (dryRun) {
      console.log(`  ${yellow("→")} would write ${label} (${content.length} bytes)`);
      return;
    }
    fs.writeFileSync(p, content);
  };
  const appendFile = (p: string, content: string, label: string): void => {
    if (dryRun) {
      console.log(`  ${yellow("→")} would append ${content.split("\n").length} lines to ${label}:`);
      // Show first 8 lines so the user can see what's about to land.
      const preview = content.split("\n").slice(0, 8).join("\n").trim();
      console.log(preview.split("\n").map((l) => `    ${dim("│ " + l)}`).join("\n"));
      const more = content.split("\n").length - 8;
      if (more > 0) console.log(`    ${dim(`│ … (${more} more lines)`)}`);
      return;
    }
    fs.appendFileSync(p, content);
  };

  // 1. Create .mcp.json
  const mcpPath = path.join(cwd, ".mcp.json");
  const serverConfig = getMcpServerConfig();

  if (fs.existsSync(mcpPath)) {
    let existing: any = {};
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    } catch {
      console.log(`  ${dim("⚠")} Existing .mcp.json has invalid JSON — backing up and creating new one`);
      if (!dryRun) fs.copyFileSync(mcpPath, mcpPath + ".backup");
    }
    if (existing?.mcpServers?.deeppairing) {
      console.log(`  ${dim("✓")} .mcp.json already has deeppairing configured`);
    } else {
      existing.mcpServers = existing.mcpServers ?? {};
      existing.mcpServers.deeppairing = serverConfig;
      writeFile(mcpPath, JSON.stringify(existing, null, 2) + "\n", ".mcp.json (merged)");
      if (!dryRun) console.log(`  ${green("✓")} Updated .mcp.json with deeppairing server`);
    }
  } else {
    const mcpConfig = {
      mcpServers: {
        deeppairing: serverConfig,
      },
    };
    writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n", ".mcp.json (new)");
    if (!dryRun) console.log(`  ${green("✓")} Created .mcp.json`);
  }

  // 2. Update .gitignore (idempotent; shared with daemon startup setup)
  const gitignoreResult = ensureGitignoreEntry(cwd);
  if (!gitignoreResult.ok) {
    console.log(`  ${yellow("!")} ${gitignoreResult.message}`);
  } else if (gitignoreResult.changed) {
    console.log(`  ${green("✓")} ${gitignoreResult.message}`);
  } else if (!fs.existsSync(path.join(cwd, ".gitignore"))) {
    // init still creates .gitignore from scratch when missing — opt-in via init,
    // not from the daemon. The shared task no-ops if .gitignore is absent.
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".deeppairing/\n");
    console.log(`  ${green("✓")} Created .gitignore with .deeppairing/`);
  } else {
    console.log(`  ${dim("✓")} ${gitignoreResult.message}`);
  }

  // 3. Add deepPairing instructions to CLAUDE.md so Claude follows the protocol
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  const dpMarker = "<!-- deepPairing -->";
  let claudeMdHasDP = false;

  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    claudeMdHasDP = content.includes(dpMarker);
  }

  if (claudeMdHasDP) {
    console.log(`  ${dim("✓")} CLAUDE.md already has deepPairing instructions`);
  } else {
    // II10 — when --minimal is set, skip the full skill / EMBEDDED_PROTOCOL
    // and write the short stub instead. Default (no flag) is the existing
    // full-protocol behavior — opt-in conservatism, not a default switch.
    let skillContent = "";
    if (minimal) {
      skillContent = MINIMAL_PROTOCOL;
    } else {
      // Try to load full skill file from package, fall back to embedded template.
      const skillSources = [
        path.join(__thisDir, "../../deeppairing.md"),
        path.join(__thisDir, "../deeppairing.md"),
      ];
      for (const src of skillSources) {
        if (fs.existsSync(src)) {
          skillContent = fs.readFileSync(src, "utf-8");
          break;
        }
      }
      // Embedded fallback — always available even if deeppairing.md is missing from the package
      if (!skillContent) {
        skillContent = EMBEDDED_PROTOCOL;
      }
    }

    const block = `\n\n${dpMarker}\n${skillContent}\n`;
    appendFile(claudeMdPath, block, `CLAUDE.md (${minimal ? "minimal stub" : "full protocol"})`);
    if (!dryRun) console.log(`  ${green("✓")} Added deepPairing protocol to CLAUDE.md${minimal ? " (minimal stub)" : ""}`);
  }

  // 4. Create .deeppairing directory (idempotent; shared with daemon startup setup)
  const dirResult = ensureDeepPairingDir(cwd);
  if (!dirResult.ok) {
    console.log(`  ${red("✗")} ${dirResult.message}`);
  } else if (dirResult.changed) {
    console.log(`  ${green("✓")} ${dirResult.message}`);
  }

  // 5. Set up Claude Code Stop hook (idempotent; shared with daemon startup setup)
  const hookResult = ensureStopHook(cwd);
  if (!hookResult.ok) {
    console.log(`  ${yellow("!")} ${hookResult.message}`);
  } else if (hookResult.changed) {
    console.log(`  ${green("✓")} ${hookResult.message} (prevents stopping with pending reviews)`);
  } else {
    console.log(`  ${dim("✓")} ${hookResult.message}`);
  }

  // V2 — PostToolUse checkpoint hook. Forces present_code_change before
  // each Write/Edit/MultiEdit so the agent can't ship a wall of edits
  // silently after a green-lit plan.
  const ckptResult = ensureCheckpointHook(cwd);
  if (!ckptResult.ok) {
    console.log(`  ${yellow("!")} ${ckptResult.message}`);
  } else if (ckptResult.changed) {
    console.log(`  ${green("✓")} ${ckptResult.message} (enforces per-edit checkpoint cadence)`);
  } else {
    console.log(`  ${dim("✓")} ${ckptResult.message}`);
  }

  // III8 — one-time prompt for the cross-project ledger publish opt-in.
  // Default is off. We surface this consciously so the user makes a real
  // choice about whether this project's rejections / approvals get
  // mirrored into ~/.deeppairing/philosophy/v1.json (where every other
  // deepPairing project on the machine can cite them). Skip silently in
  // dry-run, --yes, or non-TTY runs.
  if (!dryRun && !opts.yes && process.stdin.isTTY) {
    try {
      const { FileStore } = await import("../store/file-store.js");
      const crypto = await import("node:crypto");
      const projectName = path.basename(cwd);
      const safeProjectName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
      const projectHash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
      const seedSessionId = `session_${safeProjectName}_${projectHash}`;
      const seedStore = new FileStore(cwd, seedSessionId);
      const current = seedStore.getGlobalLedgerPublish();
      if (!current) {
        console.log(`\n  ${dim("Cross-project ledger:")} deepPairing keeps a per-machine philosophy ledger at`);
        console.log(`  ${dim("~/.deeppairing/philosophy/v1.json. By default, this project's rejections /")}`);
        console.log(`  ${dim("approvals do NOT publish there (only this project's preflight uses them).")}`);
        console.log(`  ${dim("Publishing lets every other deepPairing project on this machine cite them —")}`);
        console.log(`  ${dim("compounding taste, but also extending trust to any tool that runs in this")}`);
        console.log(`  ${dim("project. You can flip this later: `deeppairing philosophy publish on|off`.\n")}`);
        const publish = await confirmPrompt(`  Publish ${bold(projectName)}'s rejections to the cross-project ledger? [y/N] `, /* default */ false);
        seedStore.setGlobalLedgerPublish(publish);
        console.log(`  ${green("✓")} Cross-project publish: ${publish ? bold("on") : "off"}\n`);
      }
      seedStore.forceFlush();
    } catch (err) {
      // Non-fatal — user can flip it later via the CLI.
      console.log(`  ${dim("(skipped ledger-publish prompt: " + (err as any)?.message + ")")}`);
    }
  }

  // Done
  console.log(`
  ${bold("Setup complete!")}

  ${dim("What happened:")}
  - .mcp.json configured (Claude Code will start the deepPairing server)
  - CLAUDE.md updated (Claude will follow the collaboration protocol)
  - .deeppairing/ created (session data stored here)
  - Claude Code hooks set up (prevents stopping with pending reviews)

  ${dim("Next steps:")}
  1. Restart Claude Code to activate deepPairing
  2. Start coding — Claude will use deepPairing tools automatically
  3. Open the companion UI (URL shown when the server starts)

  ${dim("Claude will present findings, decisions, and plans. You review")}
  ${dim("and steer in the companion UI. Try: \"Analyze the auth module.\"")}

  ${dim("If anything goes sideways:")} ${bold("npx deeppairing doctor")} ${dim("diagnoses;")} ${bold("--fix")} ${dim("heals.")}
`);

  // Q1: offer to launch the scripted demo so the user SEES the hook fire in
  // under a minute. The rejection-block moment is deepPairing's single most
  // distinctive mechanic; make it the first thing a new user experiences
  // rather than hoping they read the help and find `demo` themselves.
  if (opts.offerDemo === false) return;
  if (!opts.yes && !process.stdin.isTTY) return; // scripted setup — skip silently
  const shouldRun =
    opts.yes ||
    (await confirmPrompt(`  Want to see deepPairing's concept-aware rejection-block fire right now? [Y/n] `, /* default */ true));
  if (!shouldRun) {
    console.log(`  ${dim("Skipped. Run")} ${bold("npx deeppairing demo")} ${dim("any time.")}`);
    console.log();
    return;
  }
  console.log();
  await demoCmd();
}

/**
 * `deeppairing doctor [--fix] [--yes]` — one-shot diagnostic that can also
 * heal the most common failure modes. Prints daemon PID/port, daemon.json
 * state, /api/state response, and a log tail. With --fix, collects a list
 * of healing actions and (after confirmation, unless --yes) applies them.
 */
async function doctor(opts: { fix?: boolean; yes?: boolean } = {}) {
  console.log(bold("\n  deepPairing doctor\n"));

  const dpDir = path.join(cwd, ".deeppairing");
  const infoFile = path.join(dpDir, "daemon.json");
  const logFile = path.join(dpDir, "daemon.log");

  /** Healing actions the user can opt into via --fix. Collected during
   *  diagnosis; applied at the end with confirmation. */
  // AA3 — fix descriptors gain `requiresExplicitConfirmation`. Some
  // doctor fixes have cross-project blast radius (e.g. signaling another
  // project's daemon to evict the port); --yes mode SKIPS them so an
  // unattended run can't trigger friendly fire. The user has to re-run
  // interactively to apply such fixes.
  const fixes: Array<{
    label: string;
    apply: () => { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>;
    requiresExplicitConfirmation?: boolean;
  }> = [];

  // 1. daemon.json
  let info: { pid?: number; port?: number; startedAt?: string } | null = null;
  if (fs.existsSync(infoFile)) {
    try {
      info = JSON.parse(fs.readFileSync(infoFile, "utf-8"));
      console.log(`  ${green("✓")} .deeppairing/daemon.json present`);
      console.log(`    ${dim("pid:")}       ${info?.pid ?? "?"}`);
      console.log(`    ${dim("port:")}      ${info?.port ?? "?"}`);
      console.log(`    ${dim("startedAt:")} ${info?.startedAt ?? "?"}`);
    } catch (err) {
      console.log(`  ${red("✗")} .deeppairing/daemon.json is malformed: ${err}`);
      fixes.push({
        label: "Delete malformed .deeppairing/daemon.json",
        apply: () => {
          try { fs.unlinkSync(infoFile); return { ok: true, message: "Deleted" }; }
          catch (e: any) { return { ok: false, message: e?.message ?? String(e) }; }
        },
      });
    }
  } else {
    console.log(`  ${yellow("!")} .deeppairing/daemon.json missing`);
  }

  // 2. PID liveness
  if (info?.pid) {
    let alive = false;
    try { process.kill(info.pid, 0); alive = true; } catch {}
    console.log(`  ${alive ? green("✓") : red("✗")} PID ${info.pid} is ${alive ? "alive" : "not running"}`);
    if (!alive) {
      fixes.push({
        label: `Remove stale daemon.json (PID ${info.pid} is dead)`,
        apply: () => {
          try { fs.unlinkSync(infoFile); return { ok: true, message: "Removed" }; }
          catch (e: any) { return { ok: false, message: e?.message ?? String(e) }; }
        },
      });
    }
  }

  // 3. Probe /api/state on the reported port. If daemon.json is missing,
  //    sweep the candidate range to find a daemon that belongs to us.
  let port = info?.port;
  if (!port) {
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const candidate = DEFAULT_PORT + attempt;
      const identity = await probeDaemonIdentity(candidate);
      if (identity && identity.projectRoot === cwd) {
        port = candidate;
        console.log(`  ${green("✓")} Swept ports; found this project's daemon on :${candidate}`);
        break;
      }
    }
    if (!port) port = DEFAULT_PORT; // fall through and report the failed probe
  }

  // Z5b / AA3 — project-mismatch remediation. When the wrapper hits
  // Y3''s 403 ("Daemon project mismatch"), the user sees the error in
  // MCP stderr and runs doctor expecting a fix.
  //
  // AA3 hardens this against the cross-project foot-cannon Z5b's
  // SIGTERM created. New apply path:
  //   1. Re-probe the daemon to confirm pid + projectRoot are unchanged
  //      from diagnosis time. PID may have been reused by an unrelated
  //      OS process; abort the kill if anything drifted.
  //   2. Try cooperative shutdown via /api/evict — daemon flushes
  //      metrics, broadcasts daemon_evicting to the OTHER project's UI
  //      (no silent disconnect), and exits cleanly.
  //   3. SIGTERM only as a fallback when evict fails. Branch on Windows
  //      where Node ignores the signal name and SIGTERM is silently
  //      SIGKILL — surface the platform delta in the user-facing copy
  //      instead of misleading "gentler than SIGKILL".
  //   4. Mark requiresExplicitConfirmation so --yes mode skips it.
  //      Cross-project actions never fire unattended.
  try {
    const squatter = await probeDaemonIdentity(port);
    if (squatter && squatter.projectRoot && squatter.projectRoot !== cwd) {
      console.log(
        `  ${red("✗")} Daemon on :${port} serves a different project: ` +
        `${squatter.projectRoot} (PID ${squatter.pid})`,
      );
      console.log(
        `    ${dim("This is the Y3' project_mismatch case — your wrapper would 403 on register.")}`,
      );
      const expectedPid = squatter.pid;
      const expectedProject = squatter.projectRoot;
      fixes.push({
        label: `Ask daemon (PID ${expectedPid}, project ${expectedProject}) to release port ${port}`,
        requiresExplicitConfirmation: true,
        apply: async () => {
          // AA3 — re-probe to confirm nothing drifted between diagnosis
          // and apply. If the daemon died (and the OS recycled the pid)
          // or another daemon claimed the port, abort.
          const reprobe = await probeDaemonIdentity(port);
          if (!reprobe) {
            return { ok: true, message: `Port ${port} is now free; nothing to do.` };
          }
          if (reprobe.pid !== expectedPid || reprobe.projectRoot !== expectedProject) {
            return {
              ok: false,
              message:
                `Daemon on :${port} changed since diagnosis ` +
                `(was PID ${expectedPid} for ${expectedProject}, now PID ${reprobe.pid} for ${reprobe.projectRoot}). ` +
                `Refusing to act on stale info; re-run doctor.`,
            };
          }
          // Cooperative shutdown first.
          const result = await evictDaemon(port, expectedPid);
          if (result === "evicted") {
            return {
              ok: true,
              message: `Daemon for ${expectedProject} evicted cleanly. Restart Claude Code in this project to bind.`,
            };
          }
          if (result === "pid_mismatch" || result === "no_daemon") {
            return {
              ok: true,
              message: `Port ${port} is no longer held by PID ${expectedPid}; nothing to do.`,
            };
          }
          // Cooperative path failed — fall back to a signal. Cross-platform
          // note: on Windows Node ignores the signal name and process.kill
          // is unconditional termination (no graceful cleanup runs). Tell
          // the user.
          if (process.platform === "win32") {
            try {
              process.kill(expectedPid);
              return {
                ok: true,
                message: `Force-killed PID ${expectedPid} (Windows has no SIGTERM equivalent — daemon couldn't flush). Restart Claude Code.`,
              };
            } catch (err: any) {
              return {
                ok: false,
                message:
                  `Could not signal PID ${expectedPid}: ${err?.message ?? err}. ` +
                  `Try Task Manager / taskkill /PID ${expectedPid}.`,
              };
            }
          }
          try {
            process.kill(expectedPid, "SIGTERM");
            return {
              ok: true,
              message:
                `Cooperative evict refused; sent SIGTERM to PID ${expectedPid}. ` +
                `Restart Claude Code in this project to spawn a fresh daemon.`,
            };
          } catch (err: any) {
            return {
              ok: false,
              message:
                `Could not signal PID ${expectedPid}: ${err?.message ?? err}. ` +
                `The other project's daemon may have died already; try restarting Claude Code.`,
            };
          }
        },
      });
    }
  } catch {
    // probeDaemonIdentity already swallows network errors; nothing to do.
  }

  let probeOk = false;
  let probeStatus: number | string = "no-response";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/api/state`, { signal: controller.signal });
    clearTimeout(timer);
    probeStatus = res.status;
    probeOk = res.ok;
  } catch (err: any) {
    probeStatus = err?.message ?? String(err);
  }
  console.log(`  ${probeOk ? green("✓") : red("✗")} GET http://localhost:${port}/api/state → ${probeStatus}`);

  // 4. Active sessions
  if (probeOk) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://localhost:${port}/api/active-sessions`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data: any = await res.json();
        const list: any[] = data.sessions ?? [];
        console.log(`  ${green("✓")} Active sessions: ${list.length}`);
        for (const s of list) {
          console.log(`    ${dim("-")} ${s.sessionId} ${dim(`(${s.artifactCount} artifacts, ${s.title})`)}`);
        }
      }
    } catch {}
  }

  // 5. Log tail
  // III9 — reconcile the verdict against fatal daemon deaths recorded in the
  // log. A leftover/older daemon answering /api/state can make the verdict
  // read "healthy" while every freshly-spawned daemon dies (the pre-III9
  // insecure-mode throw on a WSL /mnt/c v9fs mount is the canonical case).
  // Surface that instead of masking it behind a stale "healthy".
  let daemonFatalHint: string | null = null;
  if (fs.existsSync(logFile)) {
    try {
      const content = fs.readFileSync(logFile, "utf-8");
      const allLines = content.trim().split("\n");
      const lines = allLines.slice(-10);
      console.log(`\n  ${bold("Log tail")} ${dim("(last 10 lines of .deeppairing/daemon.log):")}`);
      for (const line of lines) console.log(`  ${dim(line)}`);

      const insecureModeDeaths = allLines.filter(
        (l) => l.includes("writeDaemonInfo failed") || l.includes("insecure mode"),
      ).length;
      if (insecureModeDeaths > 0) {
        daemonFatalHint =
          `${insecureModeDeaths} fatal daemon death${insecureModeDeaths === 1 ? "" : "s"} from an insecure-mode token write — ` +
          `this project's .deeppairing/ is on a filesystem that ignores chmod (WSL /mnt/c v9fs, NFS, or SMB). ` +
          `Upgrade to a deepPairing build with the token-relocation fix (III9), or move the repo onto a local Linux filesystem. ` +
          `Note: DEEPPAIRING_PROJECT_ROOT does NOT help under Claude Code — CLAUDE_PROJECT_DIR outranks it.`;
      }
    } catch (err) {
      console.log(`  ${red("✗")} Could not read daemon.log: ${err}`);
    }
  } else {
    console.log(`  ${yellow("!")} No daemon.log found`);
  }

  // 6. Project-setup checks (.gitignore + Stop hook). These catch the
  //    "plugin install half-configured this project" failure mode.
  const gitignorePath = path.join(cwd, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (content.includes(".deeppairing/") || content.includes(".deeppairing")) {
      console.log(`  ${green("✓")} .gitignore lists .deeppairing/`);
    } else {
      console.log(`  ${yellow("!")} .gitignore does NOT list .deeppairing/`);
      fixes.push({
        label: "Append .deeppairing/ to .gitignore",
        apply: () => {
          const r = ensureGitignoreEntry(cwd);
          return { ok: r.ok, message: r.message };
        },
      });
    }
  } else {
    console.log(`  ${dim("·")} No .gitignore in this directory (skipping that check)`);
  }

  const hooksPath = path.join(cwd, ".claude", "settings.local.json");
  let stopHookPresent = false;
  let stopHookLegacyShape = false;
  let checkpointHookPresent = false;
  if (fs.existsSync(hooksPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
      // X9 — recognition routes through the same HOOK_MARKERS the installer
      // and the cross-scope detector use. Without this, the doctor missed
      // the file-based Stop hook (`node .deeppairing/hooks/stop.mjs`) because
      // its substring is lowercase ".deeppairing", not "deepPairing".
      const isDpEntry = (entry: any, marker: (cmd: string) => boolean): boolean => {
        if (typeof entry?.command === "string" && marker(entry.command)) return true;
        if (Array.isArray(entry?.hooks)) {
          return entry.hooks.some(
            (h: any) => typeof h?.command === "string" && marker(h.command),
          );
        }
        return false;
      };

      const stopHooks = settings?.hooks?.Stop ?? [];
      stopHookPresent =
        Array.isArray(stopHooks) && stopHooks.some((e: any) => isDpEntry(e, HOOK_MARKERS.Stop));
      // Legacy flat shape — { command } directly on the entry, no nested
      // hooks array. Claude Code warns "Invalid settings / hooks: Expected
      // array" for these; ensureStopHook heals them on next run.
      stopHookLegacyShape = Array.isArray(stopHooks) && stopHooks.some(
        (entry: any) =>
          typeof entry?.command === "string" &&
          HOOK_MARKERS.Stop(entry.command) &&
          !Array.isArray(entry?.hooks),
      );
      const postToolUse = settings?.hooks?.PostToolUse ?? [];
      checkpointHookPresent =
        Array.isArray(postToolUse) &&
        postToolUse.some((e: any) => isDpEntry(e, HOOK_MARKERS.PostToolUse));
    } catch {}
  }
  if (stopHookPresent && !stopHookLegacyShape) {
    console.log(`  ${green("✓")} Claude Code Stop hook configured`);
  } else if (stopHookPresent && stopHookLegacyShape) {
    console.log(`  ${yellow("!")} Claude Code Stop hook uses the legacy flat shape (Claude Code warns "Invalid settings / hooks: Expected array")`);
    fixes.push({
      label: "Replace legacy Stop-hook entry with the correct nested shape",
      apply: () => {
        // ensureStopHook now heals legacy entries before re-installing.
        const r = ensureStopHook(cwd);
        return { ok: r.ok, message: r.message };
      },
    });
  } else {
    console.log(`  ${yellow("!")} Claude Code Stop hook NOT configured (agent can stop while artifacts are unreviewed)`);
    fixes.push({
      label: "Add Stop hook to .claude/settings.local.json",
      apply: () => {
        const r = ensureStopHook(cwd);
        return { ok: r.ok, message: r.message };
      },
    });
  }
  if (checkpointHookPresent) {
    console.log(`  ${green("✓")} Claude Code per-edit checkpoint hook configured`);
  } else {
    console.log(`  ${yellow("!")} Per-edit checkpoint hook NOT configured (agent can batch Write/Edit without present_code_change)`);
    fixes.push({
      label: "Add PostToolUse checkpoint hook to .claude/settings.local.json",
      apply: () => {
        const r = ensureCheckpointHook(cwd);
        return { ok: r.ok, message: r.message };
      },
    });
  }

  // X2 — cross-scope hook detection. Even with the canonical entry in
  // .local, deepPairing rows may linger in user-level (~/.claude/settings.json)
  // or project-shared (.claude/settings.json) — leftover from earlier
  // installs. Claude Code merges them in and runs both → "Ran 2 stop hooks."
  // We only auto-clean when --fix is passed, since these scopes might
  // contain other intentional hooks.
  // HOOK_MARKERS already imported at top — keep the dynamic import only for
  // helpers that are doctor-specific (avoids loading them in the install path).
  const { detectCrossScopeDpEntries, cleanDpEntriesFromScope } =
    await import("./setup-tasks.js");
  const crossScopeStop = detectCrossScopeDpEntries(cwd, "Stop", HOOK_MARKERS.Stop)
    .filter((s) => s.scope !== "project-local" && s.count > 0);
  const crossScopeCheckpoint = detectCrossScopeDpEntries(cwd, "PostToolUse", HOOK_MARKERS.PostToolUse)
    .filter((s) => s.scope !== "project-local" && s.count > 0);
  if (crossScopeStop.length > 0) {
    const total = crossScopeStop.reduce((a, s) => a + s.count, 0);
    console.log(`  ${yellow("!")} ${total} cross-scope deepPairing Stop entr${total === 1 ? "y" : "ies"} detected outside .local (potential duplicate firings):`);
    for (const s of crossScopeStop) {
      console.log(`    ${dim("·")} ${s.scope}: ${s.path} (${s.count})`);
    }
    fixes.push({
      label: `Remove ${total} cross-scope deepPairing Stop entr${total === 1 ? "y" : "ies"} (preserves non-DP hooks in those files)`,
      apply: () => {
        let removed = 0;
        for (const s of crossScopeStop) {
          const r = cleanDpEntriesFromScope(s.path, "Stop", HOOK_MARKERS.Stop);
          if (!r.ok) return { ok: false, message: r.message };
          removed += r.removed;
        }
        return { ok: true, message: `Removed ${removed} cross-scope Stop entries` };
      },
    });
  }
  if (crossScopeCheckpoint.length > 0) {
    const total = crossScopeCheckpoint.reduce((a, s) => a + s.count, 0);
    console.log(`  ${yellow("!")} ${total} cross-scope deepPairing checkpoint entr${total === 1 ? "y" : "ies"} detected outside .local:`);
    for (const s of crossScopeCheckpoint) {
      console.log(`    ${dim("·")} ${s.scope}: ${s.path} (${s.count})`);
    }
    fixes.push({
      label: `Remove ${total} cross-scope deepPairing checkpoint entr${total === 1 ? "y" : "ies"}`,
      apply: () => {
        let removed = 0;
        for (const s of crossScopeCheckpoint) {
          const r = cleanDpEntriesFromScope(s.path, "PostToolUse", HOOK_MARKERS.PostToolUse);
          if (!r.ok) return { ok: false, message: r.message };
          removed += r.removed;
        }
        return { ok: true, message: `Removed ${removed} cross-scope checkpoint entries` };
      },
    });
  }

  // 7. Overall verdict
  console.log();
  if (probeOk && daemonFatalHint) {
    // A daemon is answering, but the log shows fresh daemons dying — the
    // responder is almost certainly a leftover/older process. Refusing to
    // call this "healthy" is the whole point of the III9 doctor fix.
    console.log(`  ${yellow(bold("Daemon answering, but unhealthy"))} on port ${port}`);
    console.log(`  ${dim(daemonFatalHint)}`);
  } else if (probeOk) {
    console.log(`  ${green(bold("Daemon healthy"))} on port ${port}`);
  } else if (daemonFatalHint) {
    console.log(`  ${red(bold("Daemon failing to start"))} on port ${port}`);
    console.log(`  ${dim(daemonFatalHint)}`);
  } else if (info?.pid) {
    console.log(`  ${red(bold("Daemon unhealthy"))} — daemon.json points at PID ${info.pid} but port ${port} is not responding`);
    console.log(`  ${dim("Try: kill ") + info.pid + dim(" && rm .deeppairing/daemon.json — or re-run with --fix")}`);
  } else {
    console.log(`  ${yellow(bold("No daemon detected"))} on port ${port}`);
    console.log(`  ${dim("Start one by opening a Claude Code session with deepPairing configured, or run the daemon directly.")}`);
  }
  console.log();

  // 8. Healing phase — only when --fix was passed AND there's something to heal.
  if (!opts.fix) {
    if (fixes.length > 0) {
      console.log(`  ${dim(`${fixes.length} fix${fixes.length === 1 ? "" : "es"} available. Re-run with --fix to apply.`)}`);
      console.log();
    }
    return;
  }
  if (fixes.length === 0) {
    console.log(`  ${green("Nothing to fix.")}`);
    console.log();
    return;
  }

  console.log(bold(`  Proposed fixes (${fixes.length}):`));
  fixes.forEach((f, i) => console.log(`    ${dim(`${i + 1}.`)} ${f.label}`));
  console.log();

  const confirmed = opts.yes || !process.stdin.isTTY
    ? (opts.yes ?? false)
    : await confirmPrompt(`  Apply all ${fixes.length}? [y/N] `);

  if (!confirmed) {
    console.log(`  ${dim("Cancelled. No changes made.")}`);
    console.log();
    return;
  }

  for (const f of fixes) {
    // AA3 — skip cross-project / cross-process fixes when running under
    // --yes. Surface the skip explicitly so the user can re-run without
    // --yes if they actually want it applied.
    if (f.requiresExplicitConfirmation && opts.yes) {
      console.log(
        `  ${yellow("!")} SKIPPED ${f.label}${dim(" — requires interactive confirmation; re-run without --yes")}`,
      );
      continue;
    }
    const r = await f.apply();
    const mark = r.ok ? green("✓") : red("✗");
    console.log(`  ${mark} ${f.label}${r.message ? dim(` — ${r.message}`) : ""}`);
  }
  console.log();
}

/** Tiny y/N prompt. Resolves to true on "y" / "yes" (case-insensitive).
 *  When `defaultYes` is true, bare Enter (empty answer) counts as yes — use
 *  for "[Y/n]" prompts where the expected path is to proceed. */
function confirmPrompt(question: string, defaultYes = false): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "" && defaultYes) return resolve(true);
      resolve(/^y(es)?$/i.test(trimmed));
    });
  });
}

/**
 * `deeppairing export <format> [sessionId]` — print a session export to
 * stdout so users can pipe it into clipboard / file / PR tooling.
 *   format: full | pr-description | pr-comments | adr | replay | learnings
 *   sessionId: defaults to the most recent session in this project
 */
async function exportCmd(format: string, sessionId?: string) {
  const validFormats = ["full", "pr-description", "pr-comments", "adr", "replay", "learnings"];
  if (!validFormats.includes(format)) {
    console.error(`  ${red("✗")} Unknown format "${format}". Valid: ${validFormats.join(", ")}`);
    process.exit(1);
  }

  // Prefer the daemon if it's reachable — it has active-session data. Fall
  // back to reading the session directly from disk via FileStore. Read the
  // port from daemon.json (written by the daemon on bind); fall back to the
  // default for the "no daemon running" case (we'll then land in the
  // filesystem path below).
  let port = DEFAULT_PORT;
  try {
    const daemonInfoPath = path.join(cwd, ".deeppairing", "daemon.json");
    if (fs.existsSync(daemonInfoPath)) {
      const infoFile = JSON.parse(fs.readFileSync(daemonInfoPath, "utf-8"));
      if (typeof infoFile?.port === "number") port = infoFile.port;
    }
  } catch {}
  let chosenSessionId = sessionId;

  try {
    const res = await fetch(`http://localhost:${port}/api/sessions`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data: any = await res.json();
      const sessions: any[] = data.sessions ?? [];
      if (!chosenSessionId && sessions.length > 0) {
        chosenSessionId = sessions[0].id; // most recent — listSessions sorts by lastActivity
      }
    }
  } catch {
    // daemon unreachable — we'll try the filesystem fallback below
  }

  if (!chosenSessionId) {
    console.error(`  ${red("✗")} No sessionId provided and no sessions found. Start a deepPairing session first.`);
    process.exit(1);
  }

  try {
    const res = await fetch(`http://localhost:${port}/api/export?format=${encodeURIComponent(format)}`, {
      signal: AbortSignal.timeout(3000),
      headers: { "X-Session-Id": chosenSessionId },
    });
    if (res.ok) {
      const markdown = await res.text();
      process.stdout.write(markdown);
      return;
    }
  } catch {
    // fall through to filesystem path
  }

  // Filesystem fallback — load the session directly
  const { FileStore } = await import("../store/file-store.js");
  const { formatSessionMarkdown } = await import("../export/format-markdown.js");
  try {
    const state = FileStore.loadSession(cwd, chosenSessionId);
    const markdown = formatSessionMarkdown(state as any, format as any);
    process.stdout.write(markdown);
  } catch (err: any) {
    console.error(`  ${red("✗")} Failed to load session "${chosenSessionId}": ${err?.message ?? err}`);
    process.exit(1);
  }
}

/**
 * P5 — `deeppairing philosophy {export|import}`. The Philosophy Ledger at
 * `~/.deeppairing/philosophy/v1.json` compounds across every deepPairing
 * project; these commands make it portable so the "your taste travels
 * with you" claim survives moving machines.
 */
async function philosophyCmd(sub: string | undefined, rest: string[]): Promise<void> {
  const { GlobalStore } = await import("../store/global-store.js");
  const store = new GlobalStore();

  if (sub === "export") {
    // Print to stdout so callers can redirect: `npx deeppairing philosophy export > stances.json`
    process.stdout.write(JSON.stringify(store.exportLedger(), null, 2) + "\n");
    return;
  }

  if (sub === "import") {
    const file = rest.find((a) => !a.startsWith("-"));
    const merge = rest.includes("--merge");
    if (!file) {
      console.error(`  ${red("✗")} philosophy import requires a file path.`);
      console.error(`  ${dim("   Example: npx deeppairing philosophy import stances.json --merge")}`);
      process.exit(1);
    }
    if (!merge) {
      console.error(`  ${red("✗")} Refusing to import without --merge (prevents accidental replace).`);
      console.error(`  ${dim("   Re-run with --merge to add stances into your existing ledger.")}`);
      process.exit(1);
    }
    if (!fs.existsSync(file!)) {
      console.error(`  ${red("✗")} File not found: ${file}`);
      process.exit(1);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file!, "utf-8"));
    } catch (err: any) {
      console.error(`  ${red("✗")} ${file} is not valid JSON: ${err?.message ?? err}`);
      process.exit(1);
    }
    const summary = store.importLedger(raw);
    console.log(bold("\n  deepPairing philosophy import"));
    console.log(`  ${green("✓")} Merged ${file} into ${store.getLedgerPath()}`);
    console.log(`    ${dim("concepts added:")}   ${summary.conceptsAdded}`);
    console.log(`    ${dim("concepts merged:")}  ${summary.conceptsMerged}`);
    console.log(`    ${dim("instances added:")}  ${summary.instancesAdded}`);
    console.log();
    return;
  }

  console.error(`  ${red("✗")} Unknown philosophy subcommand: ${sub ?? "(none)"}. Try: export | import <file> --merge`);
  process.exit(1);
}

/**
 * P3 — `deeppairing team init` — scaffold a .deeppairing/team.json for a
 * repo. The file is committable; each preference carries a concept,
 * rationale, and a require/prefer/avoid kind. Surfaced to the agent
 * alongside personal philosophy + structural guardrails (never merged).
 */
function teamInitCmd(force: boolean): void {
  console.log(bold("\n  deepPairing team init"));

  const dpDir = path.join(cwd, ".deeppairing");
  const teamFile = path.join(dpDir, "team.json");

  if (fs.existsSync(teamFile) && !force) {
    console.log(`  ${yellow("!")} ${teamFile} already exists.`);
    console.log(`  ${dim("Edit it directly, or re-run with --force to overwrite.")}`);
    return;
  }

  const template = {
    version: 1,
    preferences: [
      {
        id: "example-prefer-repository-pattern",
        kind: "prefer",
        concept: "repository pattern for data access",
        rationale: "keeps SQL and transaction logic out of route handlers; easier to test in isolation",
        scope: { paths: ["packages/api/**"] },
        addedBy: "your-handle",
        addedAt: new Date().toISOString(),
      },
      {
        id: "example-avoid-global-mutable-state",
        kind: "avoid",
        concept: "global mutable state for config",
        rationale: "broke testability on prior project — prefer dependency injection",
        addedBy: "your-handle",
        addedAt: new Date().toISOString(),
      },
    ],
  };

  fs.mkdirSync(dpDir, { recursive: true });
  const body =
    `// .deeppairing/team.json — team-agreed conventions, committable.\n` +
    `// The agent sees these on first tool call and the pre-flight validator\n` +
    `// uses them to refuse proposals that conflict with 'avoid' rules or\n` +
    `// that touch a domain without the required approach.\n` +
    `//\n` +
    `// Kinds:\n` +
    `//   'require' — phrase as "<thing> for <domain>" (e.g. "argon2id for\n` +
    `//               password hashing"). A proposal mentioning the domain\n` +
    `//               but not the thing is a violation.\n` +
    `//   'avoid'   — match on concept tokens against the proposal.\n` +
    `//   'prefer'  — taste; agent sees it, pre-flight never blocks.\n` +
    `//\n` +
    `// Edit these examples or replace with your team's real stances.\n\n` +
    JSON.stringify(template, null, 2) + "\n";

  fs.writeFileSync(teamFile, body);
  console.log(`  ${green("✓")} Wrote ${teamFile}`);
  console.log();
  console.log(`  ${dim("Next steps:")}`);
  console.log(`    1. Edit the two example preferences to match your team's stances.`);
  console.log(`    2. Commit the file — teammates' deepPairing sessions will pick it up.`);
  console.log(`    3. Restart any active Claude Code sessions so the new prefs load.`);
  console.log();
}

/**
 * `deeppairing demo` — prove the hook in under a minute.
 *
 * Spins up the daemon, creates a demo session, walks it through a
 * rejection → re-proposal → pre-flight block, then opens the companion UI
 * to watch it land. No Claude Code needed. This is the "in 5 minutes, a
 * new user sees the agent being refused by concept" thesis, made concrete.
 */
async function demoCmd(): Promise<void> {
  const { ensureDaemon } = await import("../daemon-lifecycle.js");
  console.log(bold("\n  deepPairing demo"));
  console.log(`  ${dim("Scripted proof that concept-aware pre-flight blocking actually fires.")}\n`);

  // II1 — ensureDaemon now returns DaemonInfo (with authToken). demoCmd
  // only hits public routes (/api/demo/run, /api/state) so we don't need
  // the token here; just normalize to port for the existing fetch calls.
  const daemonInfo = await ensureDaemon(cwd);
  const port = daemonInfo.port;
  console.log(`  ${green("✓")} Daemon ready on port ${port}`);

  let data: { sessionId: string };
  try {
    const res = await fetch(`http://localhost:${port}/api/demo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`daemon responded ${res.status}`);
    data = (await res.json()) as { sessionId: string };
  } catch (err: any) {
    console.error(`  ${red("✗")} Could not start demo: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Open the companion UI scoped to the demo session. If the browser fails
  // to open (headless CI, WSL without xdg-open), fall back to logging.
  const url = `http://localhost:${port}/?session=${data.sessionId}`;
  try {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "cmd"
      : "xdg-open";
    const spawnArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, spawnArgs, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}

  console.log();
  console.log(`  ${bold("Demo running — open the companion UI and watch:")}`);
  console.log(`    ${dim("→")} ${url}`);
  console.log();
  console.log(`  ${dim("Script:")}`);
  console.log(`    ${dim("t+0.5s")}  Agent proposes a global mutable ConfigStore singleton.`);
  console.log(`    ${dim("t+2.5s")}  You reject it with reason "${"breaks testability"}".`);
  console.log(`    ${dim("        →")} Added to Your taste (the ledger grows).`);
  console.log(`    ${dim("t+5.0s")}  Agent tries a paraphrase: "Add a global config cache".`);
  console.log(`    ${dim("        →")} ${bold("🛡 Pre-flight catches it by concept. Hero toast fires.")}`);
  console.log();
  console.log(`  ${dim("That toast is the single most distinctive deepPairing moment —")}`);
  console.log(`  ${dim("the moat the product is built around. It compounds: today it's one")}`);
  console.log(`  ${dim("project; after a few sessions it spans every deepPairing project.")}`);
  console.log();
  console.log(`  ${green("Session:")} ${data.sessionId}`);
  console.log();
}

/**
 * `deeppairing post-pr-review <pr> [--session-id ID] [--event EVENT]`
 *  — post the current (or specified) pairing session's findings as inline
 *  comments on a GitHub PR. Uses the `gh` CLI.
 */
async function postPrReviewCmd(ref: string, sessionId?: string, event?: string) {
  const { FileStore } = await import("../store/file-store.js");
  const { buildGitHubReviewPayload } = await import("../export/format-markdown.js");
  const { postPrReview, GhMissingError, GhNotAuthedError } = await import("../github/post-review.js");

  let chosenSessionId = sessionId;
  if (!chosenSessionId) {
    const sessions = FileStore.listSessions(cwd);
    if (sessions.length === 0) {
      console.error(`  ${red("✗")} No sessions found in this project. Start a deepPairing session first.`);
      process.exit(1);
    }
    chosenSessionId = sessions[0].id;
  }

  let state: any;
  try {
    state = FileStore.loadSession(cwd, chosenSessionId);
  } catch (err: any) {
    console.error(`  ${red("✗")} Could not load session "${chosenSessionId}": ${err?.message ?? err}`);
    process.exit(1);
  }

  const payload = buildGitHubReviewPayload(state, {
    event: (event as any) || "COMMENT",
  });

  if (payload.comments.length === 0) {
    console.error(`  ${red("✗")} No findings with structured evidence (filePath + lineStart) in this session.`);
    console.error(`  ${dim("   Use present_findings with structured Evidence objects to enable inline review comments.")}`);
    process.exit(1);
  }

  try {
    const result = await postPrReview({ ref, payload });
    console.log(`  ${green("✓")} Posted ${payload.comments.length} inline comment${payload.comments.length === 1 ? "" : "s"} on PR ${ref}`);
    if (result.htmlUrl) console.log(`    ${dim(result.htmlUrl)}`);
  } catch (err: any) {
    if (err instanceof GhMissingError || err instanceof GhNotAuthedError) {
      console.error(`  ${red("✗")} ${err.message}`);
    } else {
      console.error(`  ${red("✗")} post-pr-review failed: ${err?.message ?? err}`);
    }
    process.exit(1);
  }
}

/**
 * U0.6 — `deeppairing sessions {list|prune}` — surface and clean up the
 * orphan sessions a user accumulated under the old non-deterministic
 * sessionId scheme. After the deterministic-id fix in standalone.ts, every
 * fresh wrapper for a project lands on the same session — but old session
 * dirs from before the fix linger and confuse the UI when it auto-selects
 * the most recent one.
 */
async function sessionsCmd(sub: string | undefined, rest: string[]): Promise<void> {
  const { FileStore } = await import("../store/file-store.js");
  const sessions = FileStore.listSessions(cwd);

  if (sub === "list" || sub === undefined) {
    if (sessions.length === 0) {
      console.log(`  ${dim("·")} No sessions found in ${path.join(cwd, ".deeppairing", "sessions")}`);
      return;
    }
    console.log(bold("\n  deepPairing sessions"));
    console.log(`  ${dim("Found")} ${sessions.length} ${dim("session(s) in this project:")}\n`);
    for (const s of sessions) {
      const age = s.lastActivity ? humanAge(s.lastActivity) : "(no activity)";
      console.log(`    ${dim("·")} ${s.id} ${dim(`— ${s.artifactCount} artifacts, last activity ${age}`)}`);
    }
    console.log();
    console.log(`  ${dim("To remove empty/stale sessions:")} ${bold("npx deeppairing sessions prune")} ${dim("[--yes]")}`);
    console.log();
    return;
  }

  if (sub === "merge") {
    // U0.6 — rescue data from sessions split by the pre-fix non-deterministic
    // sessionId scheme. Common case: the UI wrote comments into one session
    // while the agent's wrapper recorded the artifact in another, both for
    // the same project. Merge collapses them by appending source records
    // into the target's JSON files (no FileStore lifecycle dance).
    const fromId = rest.find((a) => !a.startsWith("-") && rest.indexOf(a) === 0);
    const intoId = rest.filter((a) => !a.startsWith("-"))[1];
    if (!fromId || !intoId) {
      console.error(`  ${red("✗")} Usage: npx deeppairing sessions merge <from-id> <into-id>`);
      console.error(`  ${dim("   Example: sessions merge session_1777131724008 session_1777131802548_951295")}`);
      process.exit(1);
    }
    if (fromId === intoId) {
      console.error(`  ${red("✗")} from and into must differ.`);
      process.exit(1);
    }
    const sessionsDir = path.join(cwd, ".deeppairing", "sessions");
    const fromDir = path.join(sessionsDir, fromId);
    const intoDir = path.join(sessionsDir, intoId);
    if (!fs.existsSync(fromDir)) {
      console.error(`  ${red("✗")} Source session directory not found: ${fromDir}`);
      process.exit(1);
    }
    if (!fs.existsSync(intoDir)) {
      console.error(`  ${red("✗")} Target session directory not found: ${intoDir}`);
      process.exit(1);
    }

    // The merge is shape-aware per file. Each session JSON is an array of
    // records; we concat + dedupe on `id` (target wins on collisions because
    // the user explicitly chose it as the canonical store).
    const filesToMerge = ["artifacts.json", "comments.json", "decisions.json", "plan-reviews.json", "retrospectives.json"];
    const summary: Record<string, { from: number; into: number; merged: number }> = {};

    for (const file of filesToMerge) {
      const fromPath = path.join(fromDir, file);
      const intoPath = path.join(intoDir, file);
      if (!fs.existsSync(fromPath)) continue;

      let fromArr: any[] = [];
      let intoArr: any[] = [];
      try { fromArr = JSON.parse(fs.readFileSync(fromPath, "utf-8")); } catch { continue; }
      try { if (fs.existsSync(intoPath)) intoArr = JSON.parse(fs.readFileSync(intoPath, "utf-8")); } catch {}
      if (!Array.isArray(fromArr) || !Array.isArray(intoArr)) continue;

      const seen = new Set(intoArr.map((r) => r.id ?? r.decisionId ?? r.artifactId).filter(Boolean));
      const additions = fromArr.filter((r) => {
        const key = r.id ?? r.decisionId ?? r.artifactId;
        return key && !seen.has(key);
      });
      // Rewrite the sessionId field so artifacts/comments report the new home.
      for (const a of additions) {
        if (a.sessionId) a.sessionId = intoId;
      }
      const merged = [...intoArr, ...additions];
      const tmp = intoPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
      fs.renameSync(tmp, intoPath);

      summary[file] = { from: fromArr.length, into: intoArr.length, merged: additions.length };
    }

    console.log(bold("\n  deepPairing sessions merge"));
    console.log(`  ${green("✓")} Merged ${fromId} → ${intoId}`);
    for (const [file, s] of Object.entries(summary)) {
      console.log(`    ${dim("·")} ${file.padEnd(22)} +${s.merged} record(s) ${dim(`(from=${s.from}, into=${s.into})`)}`);
    }
    const yes = rest.includes("--yes") || rest.includes("-y");
    const removeSrc = yes || (process.stdin.isTTY ? await confirmPrompt(`\n  Remove source ${fromId}? [y/N] `) : false);
    if (removeSrc) {
      fs.rmSync(fromDir, { recursive: true, force: true });
      console.log(`  ${green("✓")} Removed ${fromDir}`);
    } else {
      console.log(`  ${dim("Source kept. Re-run with the same args to retry, or `rm -rf` it manually.")}`);
    }
    console.log();
    console.log(`  ${dim("Restart Claude Code so the agent's wrapper picks up the merged session state.")}`);
    console.log();
    return;
  }

  if (sub === "prune") {
    const yes = rest.includes("--yes") || rest.includes("-y");
    // Prune criteria: empty (zero artifacts) AND older than 1h, OR explicitly
    // empty for >24h regardless of activity. We keep recently-empty sessions
    // because the wrapper just registered and the user hasn't done anything
    // yet; deleting it would be confusing.
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const candidates = sessions.filter((s) => {
      if (s.artifactCount > 0) return false;
      const last = s.lastActivity ? new Date(s.lastActivity).getTime() : 0;
      const ageMs = now - last;
      return ageMs > HOUR;
    });

    if (candidates.length === 0) {
      console.log(`  ${green("✓")} Nothing to prune. ${sessions.length} active session(s) remain.`);
      return;
    }

    console.log(bold(`\n  Will remove ${candidates.length} empty/stale session(s):`));
    for (const c of candidates) {
      console.log(`    ${dim("·")} ${c.id}`);
    }
    console.log();
    const confirmed = yes || (process.stdin.isTTY ? await confirmPrompt(`  Proceed? [y/N] `) : false);
    if (!confirmed) {
      console.log(`  ${dim("Cancelled.")}`);
      return;
    }
    let removed = 0;
    for (const c of candidates) {
      const dir = path.join(cwd, ".deeppairing", "sessions", c.id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch (err: any) {
        console.log(`    ${red("✗")} ${c.id}: ${err?.message ?? err}`);
      }
    }
    console.log(`  ${green("✓")} Removed ${removed} session(s).`);
    return;
  }

  console.error(`  ${red("✗")} Unknown sessions subcommand: ${sub}. Try: sessions list | sessions prune [--yes]`);
  process.exit(1);
}

function humanAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "(unknown)";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// --- CLI entry point with argument parsing ---
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "--help" || cmd === "-h" || (!cmd && args.length === 0)) {
  // With no arguments, default to init (most common use case from npx)
  if (!cmd) {
    main().catch((err) => { console.error(`  ${red("✗")} init failed: ${err?.message ?? err}`); process.exit(1); });
  } else {
    // IV2 — was 14 `npx deeppairing` lines. Pre-1.0 the package isn't
    // on npm, so `npx deeppairing` returns 404 and the user sees a
    // command that doesn't work as their first impression. III9 fixed
    // this in the README; the CLI help was missed. Now: leading `dp`
    // placeholder = whichever invocation the user reached the help
    // through (the linked `deeppairing` command after `pnpm link
    // --global`, or the by-path `node packages/.../init.js`). A leading
    // section makes the choice explicit. The grep guard test
    // (cli/__tests__/no-npx-deeppairing.test.ts) keeps a future PR
    // from putting them back.
    console.log(`
  ${bold("deepPairing")} — Human-AI collaborative development

  ${bold("This CLI:")} pre-1.0, not on npm. Invoke as either:
    ${dim("•")} ${bold("deeppairing <cmd>")}                                 (after \`cd packages/mcp-server && pnpm link --global\`)
    ${dim("•")} ${bold("node packages/mcp-server/dist/cli/init.js <cmd>")}   (no setup; works after \`pnpm build\`)

  ${bold("Commands")} (substitute one of the invocations above for \`dp\`):
    dp                                     Set up deepPairing in current project (interactive; offers demo)
    dp init [--no-demo] [-y] [--dry-run] [--minimal]
                                           Set up deepPairing in current project
                                           --no-demo skips the "see it fire" prompt; -y auto-accepts
                                           --dry-run previews CLAUDE.md + .mcp.json changes without writing
                                           --minimal writes a short stub to CLAUDE.md instead of the full protocol
    dp demo                                Watch the rejection-block fire in the companion UI (no Claude Code needed)
    dp team init [--force]                 Scaffold .deeppairing/team.json with example team conventions
    dp philosophy export                   Print your cross-project Philosophy Ledger as JSON to stdout
    dp philosophy import <f> --merge       Merge an exported ledger into your current one (idempotent)
    dp doctor [--fix] [--yes]              Diagnose — with --fix, heals stale daemon.json, gitignore, Stop hook
    dp sessions [list|prune]               List sessions for this project; prune removes empty stale ones
    dp sessions merge <from> <into> [-y]   Merge two sessions (rescues data split by old non-deterministic ids)
    dp export <format>                     Print a session as markdown
                                           (format: full | pr-description | pr-comments | adr | replay | learnings)
    dp post-pr-review <pr>                 Post the pairing session's findings as inline comments
                                           on a GitHub PR. Requires \`gh\` CLI installed + authed.
    dp --help                              Show this help message
    dp --version                           Show version
`);
  }
} else if (cmd === "--version" || cmd === "-v") {
  console.log("0.1.0");
} else if (cmd === "init") {
  const offerDemo = !args.includes("--no-demo");
  const yes = args.includes("--yes") || args.includes("-y");
  // II10 — preview-before-write flags. Dry-run prints what would happen
  // without touching the filesystem; --minimal swaps the long embedded
  // protocol for a short stub. Surfaces cautious-developer trust gap
  // around "init silently appends 156 lines to my CLAUDE.md".
  const dryRun = args.includes("--dry-run");
  const minimal = args.includes("--minimal");
  main({ offerDemo, yes, dryRun, minimal }).catch((err) => {
    console.error(`  ${red("✗")} init failed: ${err?.message ?? err}`);
    process.exit(1);
  });
} else if (cmd === "doctor") {
  const fix = args.includes("--fix");
  const yes = args.includes("--yes") || args.includes("-y");
  doctor({ fix, yes }).catch((err) => {
    console.error(`  ${red("✗")} doctor failed: ${err}`);
    process.exit(1);
  });
} else if (cmd === "export") {
  const format = args[1];
  const sessionId = args[2];
  if (!format) {
    console.error(`  ${red("✗")} export requires a format. Run 'npx deeppairing --help'.`);
    process.exit(1);
  }
  exportCmd(format, sessionId).catch((err) => {
    console.error(`  ${red("✗")} export failed: ${err?.message ?? err}`);
    process.exit(1);
  });
} else if (cmd === "demo") {
  demoCmd().catch((err) => {
    console.error(`  ${red("✗")} demo failed: ${err?.message ?? err}`);
    process.exit(1);
  });
} else if (cmd === "philosophy") {
  const sub = args[1];
  philosophyCmd(sub, args.slice(2)).catch((err) => {
    console.error(`  ${red("✗")} philosophy ${sub ?? ""} failed: ${err?.message ?? err}`);
    process.exit(1);
  });
} else if (cmd === "team") {
  const sub = args[1];
  const force = args.includes("--force");
  if (sub === "init") {
    try {
      teamInitCmd(force);
    } catch (err: any) {
      console.error(`  ${red("✗")} team init failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  } else {
    console.error(`  ${red("✗")} Unknown team subcommand: ${sub ?? "(none)"}. Try: team init [--force]`);
    process.exit(1);
  }
} else if (cmd === "sessions") {
  const sub = args[1];
  sessionsCmd(sub, args.slice(2)).catch((err) => {
    console.error(`  ${red("✗")} sessions ${sub ?? ""} failed: ${err?.message ?? err}`);
    process.exit(1);
  });
} else if (cmd === "post-pr-review") {
  const ref = args[1];
  if (!ref) {
    console.error(`  ${red("✗")} post-pr-review requires a PR number or URL.`);
    console.error(`  ${dim("   Example: npx deeppairing post-pr-review 42")}`);
    process.exit(1);
  }
  // Parse optional --session-id and --event flags
  let sessionId: string | undefined;
  let event: string | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--session-id" && args[i + 1]) { sessionId = args[i + 1]; i++; }
    else if (args[i] === "--event" && args[i + 1]) { event = args[i + 1]; i++; }
  }
  postPrReviewCmd(ref, sessionId, event).catch((err) => {
    console.error(`  ${red("✗")} post-pr-review failed: ${err?.message ?? err}`);
    process.exit(1);
  });
} else {
  console.log(`  Unknown command: ${cmd}\n  Run ${dim("npx deeppairing --help")} for usage.`);
  process.exit(1);
}
