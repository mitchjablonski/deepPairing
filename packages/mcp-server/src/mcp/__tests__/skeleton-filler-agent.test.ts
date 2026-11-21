// #686 P3 — the edit-only skeleton-filler agent (ported from skeleton-skills).
// Its value is the tool restriction, so the allowlist is pinned exactly: a
// widened list (Bash, Write, Agent, an MCP tool) must be a deliberate change.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const agentFile = path.join(repoRoot, "claude-plugin", "agents", "skeleton-filler.md");
const fillCommand = path.join(repoRoot, "claude-plugin", "commands", "skeleton-fill.md");

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(m, "frontmatter").not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of m![1]!.split("\n")) {
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

describe("#686 skeleton-filler agent", () => {
  const fm = frontmatter(fs.readFileSync(agentFile, "utf8"));

  it("is named and described for the skeleton fill only", () => {
    expect(fm.name).toBe("skeleton-filler");
    expect(fm.description).toMatch(/skeleton-fill/);
    expect(fm.model).toBe("inherit");
  });

  it("may only read and edit: the tool allowlist is exact", () => {
    expect(list(fm.tools)).toEqual(["Read", "Grep", "Glob", "Edit", "MultiEdit"]);
  });

  it("explicitly disallows shell, file creation and sub-agents", () => {
    const denied = list(fm.disallowedTools);
    for (const tool of ["Bash", "PowerShell", "Monitor", "Write", "NotebookEdit", "Agent"]) {
      expect(denied, tool).toContain(tool);
    }
    expect(list(fm.tools).some((t) => denied.includes(t))).toBe(false);
  });

  it("is the fill command's delegate, with a fallback when it is unavailable", () => {
    const text = fs.readFileSync(fillCommand, "utf8");
    expect(text).toContain("skeleton-filler");
    expect(text).toMatch(/If the agent isn't\s+available/);
  });
});
