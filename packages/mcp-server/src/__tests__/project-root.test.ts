import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectRoot, preferredPortFor, BASE_PORT, PORT_SPAN } from "../project-root.js";

describe("preferredPortFor — deterministic per-project port", () => {
  it("is deterministic: same projectRoot → same port", () => {
    expect(preferredPortFor("/home/me/projectA")).toBe(preferredPortFor("/home/me/projectA"));
  });
  it("always lands within [BASE_PORT, BASE_PORT+PORT_SPAN)", () => {
    for (const p of ["/a", "/b/c", "/home/me/projectA", "/home/me/projectB", "/mnt/x/y/z"]) {
      const port = preferredPortFor(p);
      expect(port).toBeGreaterThanOrEqual(BASE_PORT);
      expect(port).toBeLessThan(BASE_PORT + PORT_SPAN);
    }
  });
  it("distributes distinct projects across slots (not all on the base)", () => {
    const ports = new Set(
      Array.from({ length: 20 }, (_, i) => preferredPortFor(`/home/me/project-${i}`)),
    );
    // 20 distinct roots should spread over several slots, not collapse to one.
    expect(ports.size).toBeGreaterThan(5);
  });
});

let realDir: string;
let altDir: string;

beforeEach(() => {
  realDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-projroot-"));
  altDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-projroot-alt-"));
});

afterEach(() => {
  fs.rmSync(realDir, { recursive: true, force: true });
  fs.rmSync(altDir, { recursive: true, force: true });
});

describe("resolveProjectRoot (Z2)", () => {
  it("falls back to cwd when no env vars are set (npx invocation from terminal)", () => {
    const r = resolveProjectRoot({ env: {}, cwd: () => realDir });
    expect(r.projectRoot).toBe(path.resolve(realDir));
    expect(r.source).toBe("cwd");
  });

  it("prefers CLAUDE_PROJECT_DIR over cwd (the plugin install path footgun)", () => {
    // The whole reason Z2 exists: when Claude Code spawns us via the
    // plugin, cwd is `~/.claude/plugins/...` but CLAUDE_PROJECT_DIR is
    // the user's actual workspace.
    const r = resolveProjectRoot({
      env: { CLAUDE_PROJECT_DIR: realDir },
      cwd: () => altDir, // simulating plugin install dir
    });
    expect(r.projectRoot).toBe(path.resolve(realDir));
    expect(r.source).toBe("CLAUDE_PROJECT_DIR");
  });

  it("uses DEEPPAIRING_PROJECT_ROOT as the second-priority signal (escape hatch)", () => {
    const r = resolveProjectRoot({
      env: { DEEPPAIRING_PROJECT_ROOT: realDir },
      cwd: () => altDir,
    });
    expect(r.projectRoot).toBe(path.resolve(realDir));
    expect(r.source).toBe("DEEPPAIRING_PROJECT_ROOT");
  });

  it("CLAUDE_PROJECT_DIR wins over DEEPPAIRING_PROJECT_ROOT when both are set", () => {
    const r = resolveProjectRoot({
      env: {
        CLAUDE_PROJECT_DIR: realDir,
        DEEPPAIRING_PROJECT_ROOT: altDir,
      },
      cwd: () => "/nope",
    });
    expect(r.source).toBe("CLAUDE_PROJECT_DIR");
    expect(r.projectRoot).toBe(path.resolve(realDir));
  });

  it("rejects a non-absolute env value (a bad env shouldn't poison resolution)", () => {
    const r = resolveProjectRoot({
      env: { CLAUDE_PROJECT_DIR: "./relative/path" },
      cwd: () => realDir,
    });
    expect(r.source).toBe("cwd");
    expect(r.projectRoot).toBe(path.resolve(realDir));
  });

  it("rejects an env value pointing at a non-existent dir", () => {
    const r = resolveProjectRoot({
      env: { CLAUDE_PROJECT_DIR: "/this/path/does/not/exist/anywhere" },
      cwd: () => realDir,
    });
    expect(r.source).toBe("cwd");
    expect(r.projectRoot).toBe(path.resolve(realDir));
  });

  it("rejects an env value pointing at a file (not a directory)", () => {
    const filePath = path.join(realDir, "a-file");
    fs.writeFileSync(filePath, "not a dir");
    const r = resolveProjectRoot({
      env: { CLAUDE_PROJECT_DIR: filePath },
      cwd: () => realDir,
    });
    expect(r.source).toBe("cwd");
    expect(r.projectRoot).toBe(path.resolve(realDir));
  });

  it("ignores empty / whitespace-only env values", () => {
    const r = resolveProjectRoot({
      env: { CLAUDE_PROJECT_DIR: "   " },
      cwd: () => realDir,
    });
    expect(r.source).toBe("cwd");
  });

  it("normalizes the resolved path (trailing slash, dot segments)", () => {
    const messy = realDir + "/./";
    const r = resolveProjectRoot({
      env: { CLAUDE_PROJECT_DIR: messy },
      cwd: () => "/nope",
    });
    // Allow trailing slash variations across platforms; require no /./ residue.
    expect(r.projectRoot).not.toContain("/./");
    expect(r.source).toBe("CLAUDE_PROJECT_DIR");
  });
});
