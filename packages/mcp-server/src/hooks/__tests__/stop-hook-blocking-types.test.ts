/**
 * #680 — the Stop hook's "pending artifacts need review" set must stay equal to
 * the server's PENDING_DRAFT_TYPES (the types that owe a verdict), or a new
 * reviewable type (like `page`) lets a session declare "done" over a draft the
 * human hasn't reviewed. Pinned on BOTH the source and the generated script
 * that `deeppairing init` actually installs.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PENDING_DRAFT_TYPES } from "../../mcp/tools/types.js";
import { STOP_HOOK_SCRIPT } from "../../cli/hook-scripts.generated.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function blockingTypes(text: string): string[] {
  const m = /BLOCKING_TYPES = \[([^\]]*)\]/.exec(text);
  if (!m) throw new Error("BLOCKING_TYPES not found");
  return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!).sort();
}

describe("Stop hook BLOCKING_TYPES parity (#680)", () => {
  it("the source set equals PENDING_DRAFT_TYPES", () => {
    const src = fs.readFileSync(path.resolve(here, "../stop-hook.ts"), "utf8");
    expect(blockingTypes(src)).toEqual([...PENDING_DRAFT_TYPES].sort());
  });

  it("the generated (installed) script carries the same set", () => {
    expect(blockingTypes(STOP_HOOK_SCRIPT)).toEqual([...PENDING_DRAFT_TYPES].sort());
    expect(blockingTypes(STOP_HOOK_SCRIPT)).toContain("page");
  });
});
