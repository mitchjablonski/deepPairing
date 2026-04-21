/**
 * N2.3: the plugin's .mcp.json must invoke a portable launcher (server.mjs)
 * rather than hardcoding `${CLAUDE_PLUGIN_ROOT}/../packages/...` — the latter
 * only resolves in a monorepo checkout. Lock that in.
 *
 * We don't spawn the launcher (it would start a real daemon and bind a port).
 * We assert the wiring: the launcher file exists, the .mcp.json points at it,
 * and the dev-checkout candidate path the launcher will try first resolves to
 * a real file after build.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → src/ → mcp-server/ → packages/ → repo root
const repoRoot = path.resolve(here, "../../../..");
const pluginDir = path.join(repoRoot, "claude-plugin");

describe("plugin launcher wiring", () => {
  it("claude-plugin/server.mjs exists", () => {
    expect(fs.existsSync(path.join(pluginDir, "server.mjs"))).toBe(true);
  });

  it("plugin .mcp.json invokes the launcher (not a relative dist path)", () => {
    const mcpJson = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf-8"));
    const args = mcpJson?.mcpServers?.deeppairing?.args ?? [];
    expect(args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server.mjs"]);
    // Make absolutely sure nobody slips back to the brittle relative path.
    const joined = JSON.stringify(mcpJson);
    expect(joined).not.toContain("packages/mcp-server/dist");
  });

  it("launcher tries plugin-bundled and monorepo-sibling paths in order", () => {
    const launcherSrc = fs.readFileSync(path.join(pluginDir, "server.mjs"), "utf-8");
    // Match the CANDIDATES array only (the header mentions these paths too, so
    // naive indexOf catches the comment). Pin to each path's position inside
    // the array braces via a regex that requires `resolve(here,` before it.
    const resolveCall = /resolve\(here,\s*"([^"]+)"\)/g;
    const inOrder = [...launcherSrc.matchAll(resolveCall)].map((m) => m[1]);
    expect(inOrder).toEqual([
      "server/standalone.js",
      "../packages/mcp-server/dist/standalone.js",
    ]);
    // npm fallback is reached via require.resolve only when both candidates miss.
    expect(launcherSrc).toMatch(/require\.resolve\("@deeppairing\/mcp-server"\)/);
  });

  it("monorepo-sibling candidate exists after build", () => {
    // Skip this assertion when running pre-build (e.g., a fresh clone).
    // CI runs build before tests so this normally passes; locally it nudges
    // contributors to keep the build artifact in sync.
    const sibling = path.join(pluginDir, "..", "packages", "mcp-server", "dist", "standalone.js");
    if (!fs.existsSync(sibling)) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin-launcher.test] dist/standalone.js missing — run \`pnpm --filter @deeppairing/mcp-server build\``);
      return;
    }
    expect(fs.existsSync(sibling)).toBe(true);
  });
});
