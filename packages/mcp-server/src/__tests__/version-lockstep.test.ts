/**
 * #136 — version lockstep guard.
 *
 * `SERVER_VERSION` (src/version.ts) is the single value the running server
 * reports on the MCP handshake, /api/daemon-info, daemon.json, check_feedback,
 * and the install-health ping. It USED to carry a doc comment begging a human
 * to "keep this in lockstep with package.json on every release bump" — and the
 * literal silently desynced THREE times regardless (the install-ping, the CLI
 * `--version` banner, the old serverInfo). A comment asking someone to remember
 * is exactly the ritual that kept failing, so this test enforces it instead.
 *
 * All four version sources must agree, in ONE commit, on every release bump:
 *   - SERVER_VERSION (src/version.ts)
 *   - packages/mcp-server/package.json
 *   - packages/shared/package.json
 *   - claude-plugin/.claude-plugin/plugin.json   (the installed-plugin version
 *     Claude Code reads to know what's running)
 *
 * We read the JSON at test time rather than importing it: version.ts
 * deliberately avoids runtime JSON resolution so the bundled plugin has no
 * JSON-resolution dependency, and this test must not establish `import`-ing
 * package.json as an allowed pattern in src.
 *
 * DELIBERATELY EXCLUDED — these look like stale release versions and are not.
 * Do not "fix" them to match SERVER_VERSION:
 *   - `.claude-plugin/marketplace.json` → `metadata.version`: the version of the
 *     marketplace CATALOG, not of the plugin. The installed-plugin version is
 *     claude-plugin/.claude-plugin/plugin.json, which this test does pin.
 *   - `packages/vscode-extension/package.json`: independently versioned (0.0.1).
 *   - `"0.1.0"` in daemon/__tests__/ping.test.ts: arbitrary fixture input to
 *     buildPingPayload, which echoes whatever it is handed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → src/ → mcp-server/ → packages/ → repo root
const mcpPkg = path.resolve(here, "../../package.json");
const sharedPkg = path.resolve(here, "../../../shared/package.json");
const pluginManifest = path.resolve(here, "../../../../claude-plugin/.claude-plugin/plugin.json");

function readVersion(file: string): string {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { version?: unknown };
  if (typeof raw.version !== "string") {
    throw new Error(`No string "version" field in ${file}`);
  }
  return raw.version;
}

describe("#136 — release version lockstep", () => {
  it("SERVER_VERSION matches all three package/plugin manifests", () => {
    const sources: Array<{ label: string; version: string }> = [
      { label: "SERVER_VERSION (src/version.ts)", version: SERVER_VERSION },
      { label: "packages/mcp-server/package.json", version: readVersion(mcpPkg) },
      { label: "packages/shared/package.json", version: readVersion(sharedPkg) },
      { label: "claude-plugin/.claude-plugin/plugin.json", version: readVersion(pluginManifest) },
    ];

    const mismatched = sources.filter((s) => s.version !== SERVER_VERSION);
    const detail = sources.map((s) => `  ${s.label} = ${s.version}`).join("\n");
    expect(
      mismatched.length,
      `Version sources desynced — a release bump must update ALL of these in one commit:\n${detail}\n` +
        `(SERVER_VERSION is ${SERVER_VERSION}; ${mismatched.length} source(s) disagree.)`,
    ).toBe(0);
  });
});
