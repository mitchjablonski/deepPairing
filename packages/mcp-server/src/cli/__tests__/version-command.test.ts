/**
 * #136 — `dp --version` must print the single SERVER_VERSION source of truth,
 * never a hardcoded literal. A user runs `dp --version` to confirm a plugin
 * update actually took; a stale literal would mislead them into the exact
 * stale-daemon confusion this change set exists to end. This test spawns the
 * REAL CLI (under tsx, no build required) so a future release bump that forgets
 * to touch this path fails loudly here rather than silently misreporting.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → cli/ → src/ → mcp-server/
const cliEntry = path.resolve(here, "../init.ts");
const tsxBin = path.resolve(here, "../../../node_modules/.bin/tsx");

function runVersion(flag: "--version" | "-v"): string {
  return execFileSync(tsxBin, [cliEntry, flag], { encoding: "utf-8" }).trim();
}

describe("#136 — `dp --version` reads SERVER_VERSION", () => {
  it("--version prints exactly SERVER_VERSION", () => {
    expect(runVersion("--version")).toBe(SERVER_VERSION);
  });

  it("-v is an alias for the same output", () => {
    expect(runVersion("-v")).toBe(SERVER_VERSION);
  });
}, 30_000);
