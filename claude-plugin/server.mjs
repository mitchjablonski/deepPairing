#!/usr/bin/env node
/**
 * deepPairing MCP server launcher.
 *
 * Resolves the right standalone.js across three install paths so the plugin's
 * .mcp.json can be portable instead of hardcoding a relative path that only
 * works in a monorepo checkout.
 *
 * Resolution order:
 *   1. ./server/standalone.js                          — bundled into the plugin (marketplace pack)
 *   2. ../packages/mcp-server/dist/standalone.js       — monorepo dev checkout
 *   3. require.resolve("@deeppairing/mcp-server")      — globally / locally npm-installed package
 *
 * On failure we print every path we tried so the user can fix their install
 * instead of staring at an opaque "module not found" error.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
// Order matters. The monorepo-sibling path resolves npm deps via the
// workspace's node_modules — that works today. The bundled path
// (./server/) is structured for a future marketplace tarball with deps
// inlined; in dev it'd fail to find @modelcontextprotocol/sdk. Until
// the marketplace bundle is real, prefer the sibling path when it exists.
const candidates = [
  resolve(here, "../packages/mcp-server/dist/standalone.js"),
  resolve(here, "server/standalone.js"),
];

let target = candidates.find(existsSync) ?? null;

if (!target) {
  try {
    const require = createRequire(import.meta.url);
    target = require.resolve("@deeppairing/mcp-server");
  } catch {
    process.stderr.write(
      "deepPairing: could not locate the MCP server entry point.\n\n" +
      "Tried these paths:\n" +
      candidates.map((p) => `  - ${p}`).join("\n") + "\n" +
      "  - require.resolve(\"@deeppairing/mcp-server\")\n\n" +
      "Fix one of:\n" +
      "  • From a monorepo checkout: run `pnpm --filter @deeppairing/mcp-server build`.\n" +
      "  • From a published install: run `npm i -g @deeppairing/mcp-server`.\n" +
      "  • From a marketplace plugin: re-install the plugin (server bundle is missing).\n",
    );
    process.exit(1);
  }
}

// standalone.js executes main() on import (top-level await + catch). Importing
// it inside this process lets us keep stdin/stdout/stderr wired to Claude Code
// for the MCP stdio transport — no extra child process / pipe juggling.
await import(pathToFileURL(target).href).catch((err) => {
  process.stderr.write(`deepPairing: failed to start server (${target}): ${err?.stack ?? err}\n`);
  process.exit(1);
});
