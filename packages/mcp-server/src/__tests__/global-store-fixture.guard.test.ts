/**
 * F3 (#197) — lint-style guard that keeps the #134 flake class retired.
 *
 * Mirrors the no-npx-deeppairing grep-guard: walk every test/harness/setup
 * source and assert none redirects the global-store singleton directly. All
 * redirection must go through withGlobalStore() (global-store-fixture.ts),
 * which OWNS create + register + dispose + cleanup — so a future test can't
 * reintroduce a `set + rm-without-dispose` teardown that fires a debounced
 * flush against a gone tmpdir.
 *
 * The needle is assembled from fragments so this guard does not trip itself.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → src/ → mcp-server/
const srcRoot = path.resolve(here, "..");

// Assembled so the literal never appears in this source file.
const NEEDLE = ["setGlobal", "StoreForTests"].join("");

const PRUNE_DIRS = new Set(["node_modules", "dist", ".turbo"]);

/** Only the test-support surfaces can redirect the ledger; product code can't. */
function isTestSupport(file: string): boolean {
  return /\.(test|harness|setup)\.ts$/.test(file) || file.split(path.sep).includes("__tests__");
}

const EXEMPT = new Set([
  // The fixture itself — the ONE sanctioned owner of the redirect.
  "global-store-fixture.ts",
  // The setupFile that redirects the singleton for EVERY server test.
  "global-store-guard.setup.ts",
  // This guard (also needle-shielded above) and the ledger-guard, which name
  // the function in prose to explain what they protect.
  "global-store-fixture.guard.test.ts",
  "ledger-guard.test.ts",
  // Odd lifecycle (top-level beforeEach with no matching afterEach + nested
  // beforeAll/afterAll suites); disposes its stores manually (forceFlush).
  // Documented inline in the file. See rule (d) of F3.
  "daemon-integration.test.ts",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

describe("global-store redirect guard (#197 F3 — the #134 flake class stays retired)", () => {
  it("no test/harness/setup file calls the redirect outside withGlobalStore()", () => {
    const files: string[] = [];
    walk(srcRoot, files);
    const offenders = files
      .filter(isTestSupport)
      .filter((f) => !EXEMPT.has(path.basename(f)))
      .filter((f) => fs.readFileSync(f, "utf-8").includes(NEEDLE))
      .map((f) => path.relative(srcRoot, f));
    expect(offenders).toEqual([]);
  });
});
