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
**Always use log_reasoning** before every Edit or Write.

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
`;
const __thisDir = path.dirname(fileURLToPath(import.meta.url));

function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
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

  // Done
  console.log(`
  ${bold("Setup complete!")}

  ${dim("What happened:")}
  - .mcp.json configured (Claude Code will start the deepPairing server)
  - CLAUDE.md updated (Claude will follow the collaboration protocol)
  - .deeppairing/ created (session data stored here)

  ${dim("Next steps:")}
  1. Restart Claude Code to activate deepPairing
  2. Start coding — Claude will use deepPairing tools automatically
  3. Open the companion UI (URL shown when the server starts)

  ${dim("Claude will present findings, decisions, and plans. You review")}
  ${dim("and steer in the companion UI. Try: \"Analyze the auth module.\"")}
`);
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
    npx deeppairing              Set up deepPairing in current project
    npx deeppairing init         Set up deepPairing in current project
    npx deeppairing --help       Show this help message
    npx deeppairing --version    Show version
`);
  }
} else if (cmd === "--version" || cmd === "-v") {
  console.log("0.1.0");
} else if (cmd === "init") {
  main();
} else {
  console.log(`  Unknown command: ${cmd}\n  Run ${dim("npx deeppairing --help")} for usage.`);
  process.exit(1);
}
