/**
 * #681 — npm packaging readiness for `@deeppairing/mcp-server` (no publish).
 *
 * The real tarball needs a build (dist/ and dist/web/ are generated), which a
 * focused unit run doesn't have. So this runs the REAL `npm pack --dry-run`
 * against the REAL package.json in a temp directory holding a fake build tree:
 * the CLI entry, web assets, the copied skill stub, and the things that must
 * never ship (compiled tests, TypeScript sources, web sources). npm's own
 * packlist logic decides what goes in, from our `files` allowlist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..", "..");
const repoRoot = path.resolve(pkgDir, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));

describe("npm package fields (#681)", () => {
  it("ships the deeppairing CLI bin at the built entry", () => {
    expect(pkg.bin.deeppairing).toBe("./dist/cli/init.js");
    const source = fs.readFileSync(path.join(pkgDir, "src", "cli", "init.ts"), "utf8");
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("publishes publicly with a Node floor and an allowlist", () => {
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.engines.node).toMatch(/^>=20\./);
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/", "skills/"]));
    expect(pkg.files.some((f: string) => /^(src|web)\b/.test(f))).toBe(false);
  });

  it("prepublish copies the repo-root skill stub that `files` expects", () => {
    expect(pkg.scripts.prepublishOnly).toContain("'../../skills','skills'");
    expect(fs.existsSync(path.join(repoRoot, "skills", "deeppairing", "SKILL.md"))).toBe(true);
  });
});

describe("npm pack --dry-run over a fake build tree (#681)", () => {
  let dir: string;
  let packed: string[];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-npm-pack-"));
    fs.copyFileSync(path.join(pkgDir, "package.json"), path.join(dir, "package.json"));
    const fake = [
      "dist/cli/init.js",
      "dist/standalone.js",
      "dist/daemon/index.js",
      "dist/web/index.html",
      "dist/web/assets/index-abc123.js",
      "dist/web/assets/index-abc123.css",
      "dist/cli/__tests__/guide.test.js",
      "dist/store/file-store.test.js",
      "src/cli/init.ts",
      "web/src/App.tsx",
      "e2e/standalone.e2e.ts",
      "deeppairing.md",
      "README.md",
    ];
    for (const rel of fake) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), "x\n");
    }
    // What prepublishOnly copies in from the repo root.
    fs.cpSync(path.join(repoRoot, "skills"), path.join(dir, "skills"), { recursive: true });
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, npm_config_loglevel: "silent", npm_config_update_notifier: "false" },
      shell: process.platform === "win32",
    });
    packed = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
  }, 60_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("contains the CLI entry, the web assets and the skill stub", () => {
    expect(packed).toEqual(expect.arrayContaining([
      "dist/cli/init.js",
      "dist/web/index.html",
      "dist/web/assets/index-abc123.js",
      "skills/deeppairing/SKILL.md",
      "README.md",
      "package.json",
    ]));
  });

  it("excludes tests and sources", () => {
    expect(packed.filter((p) => /__tests__|\.test\.|^src\/|^web\/|^e2e\//.test(p))).toEqual([]);
  });
});
