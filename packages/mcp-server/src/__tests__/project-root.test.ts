import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveProjectRoot,
  preferredPortFor,
  resolvePortWindow,
  BASE_PORT,
  PORT_SPAN,
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_SPAN,
} from "../project-root.js";

describe("resolvePortWindow — env-overridable port window", () => {
  /** Recording warn fake — asserts the stderr-note contract without touching stderr. */
  const recorder = () => {
    const warnings: string[] = [];
    return { warnings, warn: (m: string) => warnings.push(m) };
  };

  it("defaults to 3847/128 when the env vars are unset (zero product change)", () => {
    const r = recorder();
    expect(resolvePortWindow({}, r.warn)).toEqual({ base: DEFAULT_BASE_PORT, span: DEFAULT_PORT_SPAN });
    expect(DEFAULT_BASE_PORT).toBe(3847);
    expect(DEFAULT_PORT_SPAN).toBe(128);
    expect(r.warnings).toEqual([]);
  });

  it("honors a valid override (integer, in range) with no warning", () => {
    const r = recorder();
    expect(
      resolvePortWindow({ DEEPPAIRING_PORT_BASE: "20000", DEEPPAIRING_PORT_SPAN: "64" }, r.warn),
    ).toEqual({ base: 20000, span: 64 });
    expect(r.warnings).toEqual([]);
  });

  it("falls back to defaults on garbage, with a stderr-style note per bad var", () => {
    const r = recorder();
    for (const bad of ["banana", "12.5", "-1", "1023", "65001"]) {
      expect(resolvePortWindow({ DEEPPAIRING_PORT_BASE: bad }, r.warn).base).toBe(DEFAULT_BASE_PORT);
    }
    for (const bad of ["0", "-5", "4097", "wide"]) {
      expect(resolvePortWindow({ DEEPPAIRING_PORT_SPAN: bad }, r.warn).span).toBe(DEFAULT_PORT_SPAN);
    }
    expect(r.warnings).toHaveLength(9);
    expect(r.warnings[0]).toMatch(/DEEPPAIRING_PORT_BASE/);
    expect(r.warnings.at(-1)).toMatch(/DEEPPAIRING_PORT_SPAN/);
  });

  it("treats empty/whitespace values as unset (no warning)", () => {
    const r = recorder();
    expect(resolvePortWindow({ DEEPPAIRING_PORT_BASE: "", DEEPPAIRING_PORT_SPAN: "  " }, r.warn))
      .toEqual({ base: DEFAULT_BASE_PORT, span: DEFAULT_PORT_SPAN });
    expect(r.warnings).toEqual([]);
  });

  it("a bad var falls back independently — the other override still applies", () => {
    const r = recorder();
    expect(
      resolvePortWindow({ DEEPPAIRING_PORT_BASE: "garbage", DEEPPAIRING_PORT_SPAN: "16" }, r.warn),
    ).toEqual({ base: DEFAULT_BASE_PORT, span: 16 });
    expect(r.warnings).toHaveLength(1);
  });

  it("clamps a window that would run past port 65535 (with a note)", () => {
    const r = recorder();
    expect(
      resolvePortWindow({ DEEPPAIRING_PORT_BASE: "65000", DEEPPAIRING_PORT_SPAN: "4096" }, r.warn),
    ).toEqual({ base: 65000, span: 536 });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/65535/);
  });

  it("the module-level BASE_PORT/PORT_SPAN are exactly the resolution of process.env", () => {
    // Under vitest the port-window setup exports a per-worker base, so this
    // simultaneously proves (a) consts follow the env and (b) the test window
    // is active for this process.
    expect({ base: BASE_PORT, span: PORT_SPAN }).toEqual(resolvePortWindow(process.env, () => {}));
  });
});

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
