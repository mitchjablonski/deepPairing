/**
 * IV7 — drift-protect the ERROR_CODES contract.
 *
 * The same code string lives in four places:
 *   1. http/routes.ts / daemon/routes.ts / daemon/index.ts emit them.
 *   2. error-codes.ts is the single source of truth.
 *   3. docs/troubleshooting.md keys H2 headers off the user-facing subset.
 *   4. DaemonClient (and future MCP clients) match on them to decide retry.
 *
 * Pre-IV7 a typo at any of those four surfaces silently broke the
 * contract — a user pasting `session_not_registereed` into their
 * search bar would not find the doc, and an automated retry that
 * matched on the prose-misspelled code would silently fall through to
 * the bare throw. These tests catch every form of drift before merge.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, USER_FACING_ERROR_CODES, TOOL_ERROR_CODES, TOOL_ERROR_RETRYABLE } from "../error-codes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

describe("IV7 — ERROR_CODES drift protection", () => {
  it("ERROR_CODES keys and values are identical (no typo'd const value)", () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it("TOOL_ERROR_CODES keys and values are identical (no typo'd const value)", () => {
    for (const [key, value] of Object.entries(TOOL_ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it("#183 — EXAMPLE_ECHO_REJECTED is registered with a retryability entry", () => {
    expect(TOOL_ERROR_CODES.EXAMPLE_ECHO_REJECTED).toBe("EXAMPLE_ECHO_REJECTED");
    // The Record<ToolErrorCode, boolean> type forces an entry at compile time;
    // pin the value (retryable — the agent can substitute real content) too.
    expect(TOOL_ERROR_RETRYABLE[TOOL_ERROR_CODES.EXAMPLE_ECHO_REJECTED]).toBe(true);
  });

  it("#184 — TOOL_CALL_TRUNCATED is registered with a retryability entry", () => {
    expect(TOOL_ERROR_CODES.TOOL_CALL_TRUNCATED).toBe("TOOL_CALL_TRUNCATED");
    expect(TOOL_ERROR_RETRYABLE[TOOL_ERROR_CODES.TOOL_CALL_TRUNCATED]).toBe(true);
  });

  it("every TOOL_ERROR_CODES code has a TOOL_ERROR_RETRYABLE entry (no drift)", () => {
    for (const code of Object.values(TOOL_ERROR_CODES)) {
      expect(TOOL_ERROR_RETRYABLE).toHaveProperty(code);
      expect(typeof TOOL_ERROR_RETRYABLE[code]).toBe("boolean");
    }
  });

  it("USER_FACING_ERROR_CODES is a real subset of ERROR_CODES", () => {
    for (const code of USER_FACING_ERROR_CODES) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it("docs/troubleshooting.md has an H2 entry for every USER_FACING_ERROR_CODES code", () => {
    const troubleshooting = fs.readFileSync(path.join(repoRoot, "docs", "troubleshooting.md"), "utf-8");
    for (const code of USER_FACING_ERROR_CODES) {
      // Match either `## \`code\` — ...` or `## code — ...` so future
      // editorial restyling doesn't break the test. The code itself
      // (verbatim, including underscores) must appear in an H2 line.
      const h2Re = new RegExp(`^##\\s+\\\`?${code}\\\`?\\b`, "m");
      expect(troubleshooting, `docs/troubleshooting.md missing H2 entry for "${code}"`).toMatch(h2Re);
    }
  });

  it("every `code: \"...\"` literal in src/ resolves to an ERROR_CODES value", () => {
    // Walk the source dir and grep for `code: "<literal>"` patterns.
    // Each literal must appear in ERROR_CODES — anything else is drift.
    const srcDir = path.join(repoRoot, "packages/mcp-server/src");
    const allowed = new Set<string>(Object.values(ERROR_CODES));
    // Also-allowed values that AREN'T error codes but match the regex
    // shape. Kept minimal so the test catches real drift; extend
    // deliberately only when something legitimately can't migrate.
    const allowedNonCodes = new Set<string>([
      // `code:` inside a Zod issue / schema-error map — those are
      // Zod's own codes, not ours.
      "invalid_type",
      "custom",
      // Build / Vite plugin internals occasionally use the same key.
    ]);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(srcDir);

    // Match: `code: "literal"` OR `code: \"literal\"` — what we emit
    // through Hono c.json(). Skips template strings + identifiers.
    const codeRe = /\bcode\s*:\s*["']([a-z_][a-z0-9_]*)["']/g;
    const drift: Array<{ file: string; code: string }> = [];
    for (const file of files) {
      // Skip the const file itself — its values define the truth.
      if (file.endsWith("error-codes.ts")) continue;
      const src = fs.readFileSync(file, "utf-8");
      for (const m of src.matchAll(codeRe)) {
        const code = m[1];
        if (allowed.has(code) || allowedNonCodes.has(code)) continue;
        drift.push({ file: path.relative(repoRoot, file), code });
      }
    }
    expect(drift, `Found code literals not in ERROR_CODES: ${JSON.stringify(drift, null, 2)}`).toEqual([]);
  });

  it("no `code: \"literal\"` survives in http/routes.ts / daemon/routes.ts / daemon/index.ts (post-migration)", () => {
    // After IV7 migration these three files MUST reference ERROR_CODES
    // instead of inlining string literals. The previous test would
    // catch a typo'd literal but not a *correct* literal that bypassed
    // the const — this one pins the import-from-const convention.
    const targets = [
      "packages/mcp-server/src/http/routes.ts",
      "packages/mcp-server/src/daemon/routes.ts",
      "packages/mcp-server/src/daemon/index.ts",
      // #157 — the daemon's route composition (incl. the evict route's
      // evict_pid_mismatch) moved into the factory; keep it pinned too.
      "packages/mcp-server/src/daemon/create-daemon.ts",
    ];
    for (const rel of targets) {
      const src = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
      const literalRe = /\bcode\s*:\s*["'](daemon_auth_required|session_not_registered|project_mismatch|project_hash_mismatch|evict_pid_mismatch|body_too_large|no_active_session|validation_error)["']/g;
      const inlined = [...src.matchAll(literalRe)].map((m) => m[1]);
      expect(inlined, `${rel} still inlines code string(s): ${JSON.stringify(inlined)}`).toEqual([]);
    }
  });
});
