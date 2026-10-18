/**
 * #557 — the MCP-side present_* gate had the same fault as the hook: one
 * preferences.json entry with a non-string `concept` threw
 * "s.toLowerCase is not a function" out of preflightRejectedApproaches, so the
 * present_* call itself failed and no stance was checked. It now uses the same
 * per-entry guard (runPreflightGuarded) as the hook.
 *
 * A real FileStore over a real preferences.json on a tmp dir; no mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { preflightRejectedApproaches } from "../tool-helpers.js";
import { coerceStanceConcept, runPreflight, runPreflightGuarded } from "../preflight-validator.js";

const SECRET = "sk-ant-api03-MCP-BAD-ENTRY";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function storeWith(entries: unknown[]): FileStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-557-mcp-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".deeppairing"), { recursive: true });
  fs.writeFileSync(path.join(root, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches: entries }));
  return new FileStore(root, "s1");
}

async function gate(store: FileStore, prose: string, concepts: string[] = []) {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const r = await preflightRejectedApproaches(store as never, () => {}, "present_code_change", [prose], [], concepts);
    return { r, stderr: chunks.join("") };
  } finally {
    process.stderr.write = write;
  }
}

const VALID = { description: "global mutable state", reason: "Keep configuration explicit" };

describe("#557 MCP-side present_* gate", () => {
  it("a bad entry beside a valid stance no longer throws; the valid stance blocks", async () => {
    const { r, stderr } = await gate(storeWith([VALID, { description: SECRET, concept: 42 }]), "use global mutable state for config");
    expect(r.ok).toBe(false);
    expect(stderr).toContain("1 rejected-approach entry has an unreadable concept");
    expect(stderr).not.toContain(SECRET);
  });

  it("a bad concept is ignored, not the entry: it blocks on its description", async () => {
    const { r } = await gate(storeWith([{ description: "global mutable state", concept: ["x"], reason: "explicit" }]), "use global mutable state for config");
    expect(r.ok).toBe(false);
  });

  it("{ name } is coerced and matches concept-to-concept", async () => {
    const { r } = await gate(storeWith([{ description: "an unrelated description", concept: { name: "global mutable state" } }]), "refactor", ["global mutable state"]);
    expect(r.ok).toBe(false);
  });

  it("an all-valid ledger is byte-identical to the unguarded matcher and logs nothing", async () => {
    const entries = [VALID, "bare string stance", { description: "redis cache layer", concept: "redis cache", reason: 5 }, { description: "x y", concept: null }];
    const { r, stderr } = await gate(storeWith(entries), "use global mutable state for config");
    expect(stderr).toBe("");
    expect(r.ok).toBe(false);
    const memory = storeWith(entries).getSessionMemory();
    const input = { toolName: "present_code_change", proposalStrings: ["use global mutable state for config"], proposalPaths: [], proposalConcepts: [], rejectedApproaches: memory.rejectedApproaches, teamPreferences: [] };
    const guarded = runPreflightGuarded(input);
    expect(JSON.stringify(guarded.result)).toBe(JSON.stringify(runPreflight(input)));
    expect(guarded).toMatchObject({ coerced: [], skipped: [] });
    // the very same entry objects reach the matcher: nothing is copied
    expect(memory.rejectedApproaches.every((e) => coerceStanceConcept((e as { concept?: unknown }).concept).changed === false)).toBe(true);
  });

  it("never rewrites the stored entry", async () => {
    const store = storeWith([{ description: "global mutable state", concept: 42 }]);
    const file = path.join(dirs.at(-1)!, ".deeppairing", "preferences.json");
    const before = fs.readFileSync(file, "utf8");
    await gate(store, "use global mutable state for config");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("coerceStanceConcept", () => {
  it.each([
    ["a string", "redis", "redis", false],
    ["undefined", undefined, undefined, false],
    ["null", null, null, false],
    ["{ name }", { name: "redis" }, "redis", true],
    ["{ name: blank }", { name: "  " }, undefined, true],
    ["a number", 42, undefined, true],
    ["an array", ["redis"], undefined, true],
    ["a boolean", true, undefined, true],
    ["another object", { label: "redis" }, undefined, true],
  ])("%s", (_l, input, concept, changed) => {
    expect(coerceStanceConcept(input)).toEqual({ concept, changed });
  });
});
