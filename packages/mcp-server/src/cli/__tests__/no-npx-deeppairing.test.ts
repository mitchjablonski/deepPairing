/**
 * #170 — the unpublished-npm invocation form is a dead end. Pre-1.0 the package
 * is not on npm, so that form fetches an unrelated placeholder which exits 1
 * with a wrong repo URL — the worst possible first impression for a user
 * copy-pasting a suggestion out of an error message, a doc, or the companion UI.
 *
 * Every invocation was rewritten to the path form troubleshooting.md
 * standardizes on — `node packages/mcp-server/dist/cli/init.js <cmd>`. This
 * guard (promised in init.ts's IV2 comment but never written) keeps a future
 * PR from putting the dead end back.
 *
 * The needle is assembled from fragments below so this file does not trip its
 * own grep, and `docs/npm-placeholder-fix.md` is exempt — it exists to explain
 * the dead end, so it necessarily names it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → cli/ → src/ → mcp-server/ → packages/ → repo root
const repoRoot = path.resolve(here, "..", "..", "..", "..", "..");

// Assembled so the literal never appears in this source file.
const NEEDLE = ["npx", "deeppairing"].join(" ");

const SCAN_EXTS = new Set([".ts", ".tsx", ".md", ".mjs", ".js"]);
// Generated bundle is rebuilt from src by `pnpm build`; scanning it would be
// a chicken-and-egg gate. node_modules / dist / caches are not ours to police.
const PRUNE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "coverage",
  "server", // claude-plugin/server — the generated bundle
]);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXTS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
}

describe("no unpublished-npm-invocation dead ends (#170)", () => {
  it("no source, doc, or UI file suggests the unpublished npx invocation", () => {
    const files: string[] = [];
    // Scope the walk to the surfaces we own and ship.
    for (const rel of ["packages/mcp-server/src", "packages/mcp-server/web/src", "docs", "claude-plugin"]) {
      const abs = path.join(repoRoot, rel);
      if (fs.existsSync(abs)) walk(abs, files);
    }
    for (const rel of ["INSTALL.md", "README.md", "SECURITY.md"]) {
      const abs = path.join(repoRoot, rel);
      if (fs.existsSync(abs)) files.push(abs);
    }

    // docs/npm-placeholder-fix.md documents the dead end, so it necessarily
    // names it — the one allowed exception.
    const EXEMPT = new Set([path.join("docs", "npm-placeholder-fix.md")]);
    const offenders = files
      .filter((f) => !EXEMPT.has(path.relative(repoRoot, f)))
      .filter((f) => fs.readFileSync(f, "utf-8").includes(NEEDLE));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });
});
