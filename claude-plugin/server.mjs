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
 *   3. require.resolve("@deeppairing/mcp-server")      — a locally linked build (not published to npm)
 *
 * On failure we print every path we tried so the user can fix their install
 * instead of staring at an opaque "module not found" error.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// #461 — a Node below the runtime floor would otherwise fail later with an
// opaque syntax or "is not a constructor" error (the #437 class) deep inside
// the bundle. Check first and say exactly what's wrong. Keep MIN_NODE in sync
// with packages/mcp-server/package.json's "engines" and INSTALL.md's
// Node.js support policy — this is the Node 20.11+ "deprecated, removal
// planned" floor, not the recommended 22/24.
const MIN_NODE = [20, 11];
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < MIN_NODE[0] || (nodeMajor === MIN_NODE[0] && nodeMinor < MIN_NODE[1])) {
  process.stderr.write(
    `deepPairing requires Node ${MIN_NODE[0]}.${MIN_NODE[1]}+; you're running Node ${process.versions.node}.\n` +
    "Node 22 or 24 (current LTS) is recommended; Node 20.11+ also works but is " +
    "deprecated (EOL upstream, support planned for removal no earlier than " +
    "v0.2.0).\n" +
    "Upgrade Node (e.g. via nvm: `nvm install 22`), then reload the plugin.\n",
  );
  process.exit(1);
}

// #461 — Node 20 is EOL and its deepPairing support is deprecated: still
// works today, planned for removal no earlier than v0.2.0 (not before
// January 2027). One line, stderr only — this process's stdout is the MCP
// stdio transport, so nothing may ever be written there except protocol
// frames.
if (nodeMajor === 20) {
  process.stderr.write(
    "deepPairing: Node 20 is deprecated (EOL upstream); support is planned " +
    "for removal no earlier than v0.2.0 (not before January 2027). " +
    "Move to Node 22 or 24 when convenient.\n",
  );
}

const here = dirname(fileURLToPath(import.meta.url));
// Order matters. In a monorepo dev checkout, prefer the sibling dist —
// it's the freshest build if someone ran tsc without the bundle step.
// The bundled path (./server/) is SELF-CONTAINED as of E1 (esbuild inlines
// @deeppairing/shared + every npm dep; web UI beside it) — it's what
// marketplace installs run, where no sibling exists.
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
      "  • From a marketplace plugin: re-install the plugin (the server bundle is missing).\n" +
      "  • From a clone: run `pnpm install && pnpm build` at the repo root.\n" +
      "(deepPairing is not published to npm; there is no package to install.)\n",
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
