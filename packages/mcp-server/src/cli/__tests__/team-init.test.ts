/**
 * P3 — .deeppairing/team.json must accept a JSONC header (line comments)
 * so the scaffold `node packages/mcp-server/dist/cli/init.js team init` writes can document what
 * each kind means without breaking JSON.parse. FileStore.getTeamPreferences
 * is the contract these tests pin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-init-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTeamFile(content: string): void {
  const dir = path.join(tmpDir, ".deeppairing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "team.json"), content);
}

describe("team.json loader", () => {
  it("accepts a JSONC-style header with `//` comments and still loads preferences", () => {
    writeTeamFile(
      `// .deeppairing/team.json — committable team conventions.\n` +
      `// Kinds: require / avoid / prefer. Pre-flight enforces require + avoid.\n` +
      `\n` +
      `{\n` +
      `  "version": 1,\n` +
      `  "preferences": [\n` +
      `    {\n` +
      `      "id": "p1",\n` +
      `      "kind": "avoid",\n` +
      `      "concept": "global state for config",\n` +
      `      "rationale": "broke testability on prior project"\n` +
      `    }\n` +
      `  ]\n` +
      `}\n`,
    );
    const store = new FileStore(tmpDir, "test_sess");
    const prefs = store.getTeamPreferences();
    expect(prefs).toHaveLength(1);
    expect(prefs[0].kind).toBe("avoid");
    expect(prefs[0].concept).toContain("global state");
    store.forceFlush();
  });

  it("ignores // only at line start (after whitespace) — doesn't clobber URLs in strings", () => {
    writeTeamFile(
      `// team.json header\n` +
      `{\n` +
      `  "version": 1,\n` +
      `  "preferences": [\n` +
      `    {\n` +
      `      "id": "p1",\n` +
      `      "kind": "prefer",\n` +
      `      "concept": "docs linked at https://example.com/guide",\n` +
      `      "rationale": "team reference"\n` +
      `    }\n` +
      `  ]\n` +
      `}\n`,
    );
    const store = new FileStore(tmpDir, "test_sess");
    const prefs = store.getTeamPreferences();
    expect(prefs).toHaveLength(1);
    // The `//` in the URL survived the strip because it wasn't line-leading.
    expect(prefs[0].concept).toContain("https://example.com/guide");
    store.forceFlush();
  });

  it("returns [] (not throws) when the file is malformed JSON", () => {
    writeTeamFile(`// header\n{ not valid json`);
    const store = new FileStore(tmpDir, "test_sess");
    expect(store.getTeamPreferences()).toEqual([]);
    store.forceFlush();
  });
});
