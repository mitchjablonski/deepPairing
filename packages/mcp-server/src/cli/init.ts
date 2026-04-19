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
(e.g. you noticed an error after the fact), call retract_artifact with the
artifact id and a short reason. Do NOT bail out to the terminal. Keep polling
check_feedback for the human's response.
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

function main() {
  console.log(bold("\n  deepPairing init\n"));

  // 1. Create .mcp.json
  const mcpPath = path.join(cwd, ".mcp.json");
  const serverConfig = getMcpServerConfig();

  if (fs.existsSync(mcpPath)) {
    let existing: any = {};
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    } catch {
      console.log(`  ${dim("⚠")} Existing .mcp.json has invalid JSON — backing up and creating new one`);
      fs.copyFileSync(mcpPath, mcpPath + ".backup");
    }
    if (existing?.mcpServers?.deeppairing) {
      console.log(`  ${dim("✓")} .mcp.json already has deeppairing configured`);
    } else {
      existing.mcpServers = existing.mcpServers ?? {};
      existing.mcpServers.deeppairing = serverConfig;
      fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
      console.log(`  ${green("✓")} Updated .mcp.json with deeppairing server`);
    }
  } else {
    const mcpConfig = {
      mcpServers: {
        deeppairing: serverConfig,
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(`  ${green("✓")} Created .mcp.json`);
  }

  // 2. Update .gitignore
  const gitignorePath = path.join(cwd, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".deeppairing/")) {
      fs.appendFileSync(gitignorePath, "\n.deeppairing/\n");
      console.log(`  ${green("✓")} Added .deeppairing/ to .gitignore`);
    } else {
      console.log(`  ${dim("✓")} .gitignore already has .deeppairing/`);
    }
  } else {
    fs.writeFileSync(gitignorePath, ".deeppairing/\n");
    console.log(`  ${green("✓")} Created .gitignore with .deeppairing/`);
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
    // Try to load full skill file from package, fall back to embedded template
    const skillSources = [
      path.join(__thisDir, "../../deeppairing.md"),
      path.join(__thisDir, "../deeppairing.md"),
    ];
    let skillContent = "";
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

    const block = `\n\n${dpMarker}\n${skillContent}\n`;
    fs.appendFileSync(claudeMdPath, block);
    console.log(`  ${green("✓")} Added deepPairing protocol to CLAUDE.md`);
  }

  // 4. Create .deeppairing directory
  const dpDir = path.join(cwd, ".deeppairing");
  if (!fs.existsSync(dpDir)) {
    fs.mkdirSync(dpDir, { recursive: true });
    console.log(`  ${green("✓")} Created .deeppairing/ directory`);
  }

  // 5. Set up Claude Code hooks for deepPairing workflow
  const claudeDir = path.join(cwd, ".claude");
  const hooksFile = path.join(claudeDir, "settings.local.json");

  let hooksNeedSetup = true;
  if (fs.existsSync(hooksFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
      if (settings.hooks?.Stop) {
        hooksNeedSetup = false;
        console.log(`  ${dim("✓")} Claude Code hooks already configured`);
      }
    } catch {}
  }

  if (hooksNeedSetup) {
    fs.mkdirSync(claudeDir, { recursive: true });

    // Read existing settings or create new
    let settings: any = {};
    if (fs.existsSync(hooksFile)) {
      try { settings = JSON.parse(fs.readFileSync(hooksFile, "utf-8")); } catch {}
    }

    // Add Stop hook — checks for pending deepPairing artifacts and forces continue
    settings.hooks = settings.hooks ?? {};
    settings.hooks.Stop = settings.hooks.Stop ?? [];

    // Check if we already have a deepPairing stop hook
    const hasDpHook = settings.hooks.Stop.some((h: any) => h.command?.includes("deeppairing"));
    if (!hasDpHook) {
      settings.hooks.Stop.push({
        command: `node -e "const fs=require('fs'),p=require('path');try{const d=p.join(process.cwd(),'.deeppairing','sessions');if(!fs.existsSync(d))process.exit(0);const s=fs.readdirSync(d);for(const id of s){const f=p.join(d,id,'artifacts.json');if(!fs.existsSync(f))continue;const a=JSON.parse(fs.readFileSync(f,'utf-8'));if(a.some(x=>x.status==='draft'&&['research','spec','plan','decision','code_change'].includes(x.type))){console.log('deepPairing: pending artifacts need review — call check_feedback');process.exit(2)}}}catch{process.exit(0)}"`,
      });
      fs.writeFileSync(hooksFile, JSON.stringify(settings, null, 2));
      console.log(`  ${green("✓")} Added Claude Code Stop hook (prevents stopping with pending reviews)`);
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
`);
}

/**
 * `deeppairing doctor` — one-shot diagnostic. Prints daemon PID/port, the
 * daemon.json state, /api/state response, and a log tail so the user doesn't
 * have to manually run lsof/cat/ls to debug a stuck MCP.
 */
async function doctor() {
  console.log(bold("\n  deepPairing doctor\n"));

  const dpDir = path.join(cwd, ".deeppairing");
  const infoFile = path.join(dpDir, "daemon.json");
  const logFile = path.join(dpDir, "daemon.log");

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
    }
  } else {
    console.log(`  ${yellow("!")} .deeppairing/daemon.json missing`);
  }

  // 2. PID liveness
  if (info?.pid) {
    let alive = false;
    try { process.kill(info.pid, 0); alive = true; } catch {}
    console.log(`  ${alive ? green("✓") : red("✗")} PID ${info.pid} is ${alive ? "alive" : "not running"}`);
  }

  // 3. Probe /api/state on the reported port (or default)
  const port = info?.port ?? 3847;
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
  if (fs.existsSync(logFile)) {
    try {
      const content = fs.readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n").slice(-10);
      console.log(`\n  ${bold("Log tail")} ${dim("(last 10 lines of .deeppairing/daemon.log):")}`);
      for (const line of lines) console.log(`  ${dim(line)}`);
    } catch (err) {
      console.log(`  ${red("✗")} Could not read daemon.log: ${err}`);
    }
  } else {
    console.log(`  ${yellow("!")} No daemon.log found`);
  }

  // 6. Overall verdict
  console.log();
  if (probeOk) {
    console.log(`  ${green(bold("Daemon healthy"))} on port ${port}`);
  } else if (info?.pid) {
    console.log(`  ${red(bold("Daemon unhealthy"))} — daemon.json points at PID ${info.pid} but port ${port} is not responding`);
    console.log(`  ${dim("Try: kill ") + info.pid + dim(" && rm .deeppairing/daemon.json")}`);
  } else {
    console.log(`  ${yellow(bold("No daemon detected"))} on port ${port}`);
    console.log(`  ${dim("Start one by opening a Claude Code session with deepPairing configured, or run the daemon directly.")}`);
  }
  console.log();
}

/**
 * `deeppairing export <format> [sessionId]` — print a session export to
 * stdout so users can pipe it into clipboard / file / PR tooling.
 *   format: full | pr-description | pr-review | adr | replay
 *   sessionId: defaults to the most recent session in this project
 */
async function exportCmd(format: string, sessionId?: string) {
  const validFormats = ["full", "pr-description", "pr-review", "adr", "replay"];
  if (!validFormats.includes(format)) {
    console.error(`  ${red("✗")} Unknown format "${format}". Valid: ${validFormats.join(", ")}`);
    process.exit(1);
  }

  // Prefer the daemon if it's reachable — it has active-session data. Fall
  // back to reading the session directly from disk via FileStore.
  const port = 3847;
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

// --- CLI entry point with argument parsing ---
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "--help" || cmd === "-h" || (!cmd && args.length === 0)) {
  // With no arguments, default to init (most common use case from npx)
  if (!cmd) {
    main();
  } else {
    console.log(`
  ${bold("deepPairing")} — Human-AI collaborative development

  ${bold("Usage:")}
    npx deeppairing                    Set up deepPairing in current project
    npx deeppairing init               Set up deepPairing in current project
    npx deeppairing doctor             Diagnose a running / misbehaving daemon
    npx deeppairing export <format>    Print a session as markdown
                                       (format: full | pr-description | pr-review | adr | replay)
    npx deeppairing --help             Show this help message
    npx deeppairing --version          Show version
`);
  }
} else if (cmd === "--version" || cmd === "-v") {
  console.log("0.1.0");
} else if (cmd === "init") {
  main();
} else if (cmd === "doctor") {
  doctor().catch((err) => {
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
} else {
  console.log(`  Unknown command: ${cmd}\n  Run ${dim("npx deeppairing --help")} for usage.`);
  process.exit(1);
}
