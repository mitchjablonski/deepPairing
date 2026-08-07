/**
 * L1 (#218) follow-up — the surfaces the first pass skipped. The CLAUDE.md
 * protocol templates (EMBEDDED_PROTOCOL / MINIMAL_PROTOCOL) and the `--help`
 * block hardcoded the source-form `node packages/mcp-server/dist/cli/init.js …`.
 * For an npm-installed user, `deeppairing init` bakes that nonexistent path into
 * THEIR CLAUDE.md — the exact class this batch closes. These templates are
 * rendered at init/help time (layout known), so they now route through
 * cliInvocation(). Pinned as a source-shape guard against reintroduction; the
 * per-layout WRITTEN output is proven by the tarball hermetic smoke.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const initSrc = fs.readFileSync(path.resolve(here, "../init.ts"), "utf-8");
const SOURCE_ONLY_INIT_PATH = "node packages/mcp-server/dist/cli/init.js init";

// Scope to each protocol literal's body so the file-header `Usage:` JSDoc and
// runtime command handlers don't pollute the assertions.
const embedded = initSrc.slice(
  initSrc.indexOf("const EMBEDDED_PROTOCOL"),
  initSrc.indexOf("const __thisDir"),
);
const minimal = initSrc.slice(
  initSrc.indexOf("const MINIMAL_PROTOCOL"),
  initSrc.indexOf("async function main"),
);

describe("L1 (#218) — CLAUDE.md protocol templates render the CLI invocation layout-aware", () => {
  it("sanity: both template bodies were located", () => {
    expect(embedded.length).toBeGreaterThan(100);
    expect(minimal.length).toBeGreaterThan(50);
  });

  it("EMBEDDED_PROTOCOL routes its `init` ref through cliInvocation, not a hardcoded source path", () => {
    expect(embedded).toContain('${cliInvocation("init")}');
    expect(embedded).not.toContain(SOURCE_ONLY_INIT_PATH);
  });

  it("MINIMAL_PROTOCOL routes its `init` ref through cliInvocation, not a hardcoded source path", () => {
    expect(minimal).toContain('${cliInvocation("init")}');
    expect(minimal).not.toContain(SOURCE_ONLY_INIT_PATH);
  });
});

describe("L1 (#218) — `--help` preamble is layout-aware", () => {
  it("branches on isInstalledPackage: npx CLI-bin form for installed, node path for source", () => {
    expect(initSrc).toMatch(/isInstalledPackage\(\)/);
    // Installed bullet renders the CLI-bin form via cliInvocation("<cmd>").
    expect(initSrc).toContain('cliInvocation("<cmd>")');
    // Source bullet keeps the by-path node form.
    expect(initSrc).toContain("node packages/mcp-server/dist/cli/init.js <cmd>");
  });
});
