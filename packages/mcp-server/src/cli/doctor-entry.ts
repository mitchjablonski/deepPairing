#!/usr/bin/env node
/** Marketplace entry: the same diagnostics as the npm CLI, without init. */
import { doctor } from "./doctor.js";
import { resolveProjectRoot } from "../project-root.js";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const entry = fileURLToPath(import.meta.url);
const help = `deepPairing doctor

Usage: node "${entry}" [--fix] [--yes | -y]

Reports without changing files by default. --fix proposes repairs; --yes accepts
project-local repairs only. Local plugin-hook removal, shared/user hooks, global
locks and daemon termination need interactive confirmation. Before removing local
hooks, verify the plugin is enabled for this project; activation is not verified.
Settings repairs back up original bytes beside the file before overwriting it.
Clock diagnostics never change host time or services.
Project: CLAUDE_PROJECT_DIR, else DEEPPAIRING_PROJECT_ROOT, else current directory.
`;
if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0] ?? "")) {
  console.log(help);
} else if (argv.some((arg) => !["--fix", "--yes", "-y"].includes(arg)) ||
  (!argv.includes("--fix") && (argv.includes("--yes") || argv.includes("-y")))) {
  console.error(`Invalid doctor arguments.\n${help}`);
  process.exitCode = 1;
} else {
  const resolved = resolveProjectRoot();
  console.log(`deepPairing project: ${resolved.projectRoot} (${resolved.source})`);
  if (resolved.worktree) {
    console.log(`  (git worktree ${resolved.worktree.workspaceRoot} shares the main checkout's project — #532)`);
  }
  void doctor(resolved.projectRoot, {
    fix: argv.includes("--fix"),
    yes: argv.includes("--yes") || argv.includes("-y"),
    protectSharedScopes: true,
    pluginManaged: true,
  }).catch((err: unknown) => {
    console.error(`doctor failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
