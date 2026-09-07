/**
 * #342 — staleness gate for the generated standalone hook scripts.
 *
 * `src/cli/hook-scripts.generated.ts` is generated-but-committed, exactly like
 * `claude-plugin/server/`: the emitted `.deeppairing/hooks/*.mjs` must be
 * esbuild output of `src/cli/*-hook-entry.ts`, and an edit to the hook source
 * without `pnpm --filter @deeppairing/mcp-server gen:hooks` would silently ship
 * the previous behaviour to every `deeppairing init`.
 *
 * That is the #333 failure mode one level up, so it gets a gate rather than a
 * convention.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CHECKPOINT_HOOK_SCRIPT, STOP_HOOK_SCRIPT } from "../../cli/hook-scripts.generated.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../../..");
const generator = path.join(pkgRoot, "scripts/generate-hook-scripts.mjs");

describe("generated hook scripts", () => {
  it("match a fresh regeneration byte-for-byte", async () => {
    const { renderGeneratedModule, GENERATED_PATH } = await import(generator);
    const committed = fs.readFileSync(GENERATED_PATH, "utf8");
    // Not a snapshot: a real re-bundle of the real entrypoints.
    expect(committed).toBe(renderGeneratedModule());
  }, 60_000);

  it.each([
    ["stop", STOP_HOOK_SCRIPT],
    ["checkpoint", CHECKPOINT_HOOK_SCRIPT],
  ])("%s is a self-contained ESM script with no external imports", (_name, script) => {
    expect(script.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // Every `import ... from "x"` must be a node: builtin. Anything else means
    // the emitted script would need node_modules the user project doesn't have.
    const specifiers = [...script.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s.startsWith("node:")).toBe(true);
    expect(script).not.toContain("require(");
  });

  it.each([
    ["stop", STOP_HOOK_SCRIPT],
    ["checkpoint", CHECKPOINT_HOOK_SCRIPT],
  ])("%s parses as ESM and calls no identifier from the generator's scope", (name, script) => {
    // #333: the emitted script called errorMessage(), which existed only in
    // setup-tasks.ts's module scope — a ReferenceError inside the hook's own
    // error handler. esbuild would now fail the build, but pin it anyway.
    expect(script).not.toContain("errorMessage(");
    // `node --check` parses the file as ESM (by the .mjs extension) without
    // executing it, so an unterminated template or a bad escape from the
    // generator fails here rather than in a user's project.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-hook-parse-"));
    try {
      const file = path.join(dir, `${name}.mjs`);
      fs.writeFileSync(file, script);
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 20_000 });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
