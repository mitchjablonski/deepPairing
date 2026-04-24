#!/usr/bin/env node
/**
 * R6 — copy the built mcp-server into claude-plugin/server/ so the plugin
 * launcher's first resolution candidate (bundled) actually works.
 *
 * Doesn't perform full bundling — @deeppairing/shared still resolves via
 * the workspace from the copied dist. That's fine in the monorepo dev
 * context (the plugin launcher works against this path in `claude
 * --plugin-dir ./claude-plugin`). Full bundling with shared inlined is
 * a Phase-S marketplace concern.
 *
 * Runs automatically after `pnpm build` in packages/mcp-server.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDist = resolve(here, "../dist");
const pluginDir = resolve(here, "../../../claude-plugin/server");

if (!existsSync(serverDist)) {
  console.error(`[bundle-plugin] dist not found at ${serverDist} — run \`pnpm build\` first.`);
  process.exit(1);
}

if (existsSync(pluginDir)) {
  rmSync(pluginDir, { recursive: true, force: true });
}
mkdirSync(pluginDir, { recursive: true });
cpSync(serverDist, pluginDir, { recursive: true });

// A small marker so an operator looking at the directory knows where it
// came from (and that editing it is pointless — it gets blown away).
const marker = resolve(pluginDir, "GENERATED.md");
const markerText =
  `# Generated — do not edit\n\n` +
  `Copied from packages/mcp-server/dist/ by packages/mcp-server/scripts/bundle-plugin.mjs\n` +
  `on ${new Date().toISOString()}.\n\n` +
  `Edit the source in packages/mcp-server/src/ and re-run \`pnpm build\`.\n`;
(await import("node:fs/promises")).writeFile(marker, markerText);

console.log(`[bundle-plugin] ✓ Copied ${serverDist} → ${pluginDir}`);
