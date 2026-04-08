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

function main() {
  console.log(bold("\n  deepPairing init\n"));

  // 1. Create .mcp.json
  const mcpPath = path.join(cwd, ".mcp.json");
  if (fs.existsSync(mcpPath)) {
    const existing = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    if (existing?.mcpServers?.deeppairing) {
      console.log(`  ${dim("✓")} .mcp.json already has deeppairing configured`);
    } else {
      existing.mcpServers = existing.mcpServers ?? {};
      existing.mcpServers.deeppairing = {
        command: "npx",
        args: ["@deeppairing/mcp-server"],
      };
      fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
      console.log(`  ${green("✓")} Updated .mcp.json with deeppairing server`);
    }
  } else {
    const mcpConfig = {
      mcpServers: {
        deeppairing: {
          command: "npx",
          args: ["@deeppairing/mcp-server"],
        },
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

  // 3. Copy skill file
  const skillDest = path.join(cwd, ".deeppairing.md");
  if (fs.existsSync(skillDest)) {
    console.log(`  ${dim("✓")} .deeppairing.md already exists`);
  } else {
    // Try to find the skill file relative to this script
    const skillSources = [
      path.join(__thisDir, "../../deeppairing.md"),
      path.join(__thisDir, "../deeppairing.md"),
    ];
    let copied = false;
    for (const src of skillSources) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, skillDest);
        console.log(`  ${green("✓")} Created .deeppairing.md (collaboration protocol)`);
        copied = true;
        break;
      }
    }
    if (!copied) {
      console.log(`  ${dim("⚠")} Could not find skill file — create .deeppairing.md manually`);
    }
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

  ${dim("Next steps:")}
  1. Restart Claude Code to pick up the MCP configuration
  2. Open ${bold("http://localhost:3847")} for the companion UI
  3. Ask Claude to analyze your codebase — deepPairing tools will activate

  ${dim("The companion UI shows rich artifacts, decisions, and lets you")}
  ${dim("comment on code, approve plans, and steer the agent's work.")}
`);
}

main();
