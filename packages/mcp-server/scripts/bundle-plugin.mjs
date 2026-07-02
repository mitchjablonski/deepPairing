#!/usr/bin/env node
/**
 * E1 — build the SELF-CONTAINED plugin server.
 *
 * R6 copied dist/ verbatim, which still resolved @deeppairing/shared (and
 * every npm dep) through the WORKSPACE's node_modules — fine in a monorepo
 * checkout, broken for anyone installing the plugin from the marketplace.
 * That gap was the gate to any external distribution.
 *
 * Now: esbuild bundles the two entries (standalone = the MCP server each
 * session spawns; daemon = the shared per-project HTTP/WS process it forks)
 * into single files with ALL deps inlined, plus the built web UI beside them:
 *
 *   claude-plugin/server/standalone.js   (bundled, self-contained)
 *   claude-plugin/server/daemon.js       (bundled, self-contained —
 *                                         daemon-lifecycle's spawn fallback
 *                                         resolves it beside standalone.js)
 *   claude-plugin/server/web/            (the daemon's webDistPath fallback
 *                                         resolves web/ beside daemon.js)
 *
 * Bundle success IS the containment proof: esbuild errors at build time on
 * any unresolvable specifier, so a workspace-only import can't slip through.
 *
 * Runs automatically after `pnpm build` in packages/mcp-server.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const serverDist = resolve(pkgRoot, "dist");
const pluginDir = resolve(pkgRoot, "../../claude-plugin/server");

if (!existsSync(serverDist)) {
  console.error(`[bundle-plugin] dist not found at ${serverDist} — run \`pnpm build\` first.`);
  process.exit(1);
}

if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true });
mkdirSync(pluginDir, { recursive: true });

// Bundle from SOURCE (not dist) so esbuild sees the original module graph.
const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  // deps use require() internally (ws's optional natives, CJS interop);
  // ESM output needs a require shim at the top of the bundle.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  // ws's OPTIONAL native accelerators — absent at runtime is fine (its own
  // try/catch falls back to JS); bundling them is impossible (native).
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
};

await build({
  ...shared,
  entryPoints: [resolve(pkgRoot, "src/standalone.ts")],
  outfile: resolve(pluginDir, "standalone.js"),
});
await build({
  ...shared,
  entryPoints: [resolve(pkgRoot, "src/daemon.ts")],
  outfile: resolve(pluginDir, "daemon.js"),
});

// The companion web UI, served by the bundled daemon via its web/ fallback.
cpSync(resolve(serverDist, "web"), resolve(pluginDir, "web"), { recursive: true });

writeFileSync(
  resolve(pluginDir, "GENERATED.md"),
  `# Generated — do not edit\n\n` +
    `Self-contained bundles built from packages/mcp-server/src/ by\n` +
    `packages/mcp-server/scripts/bundle-plugin.mjs on ${new Date().toISOString()}.\n\n` +
    `Edit the source and re-run \`pnpm build\`.\n`,
);

console.log(`[bundle-plugin] ✓ Self-contained plugin server at ${pluginDir}`);
