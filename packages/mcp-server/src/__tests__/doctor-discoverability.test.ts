/**
 * U6 — `deeppairing doctor --fix` is the recovery command for most field
 * failure modes (orphan sessions, stale daemon.json, missing Stop hook,
 * misconfigured .gitignore, port conflicts). Pre-U6 it was buried in
 * --help and a council ease-of-use review flagged this as the third
 * highest friction point: users hit a failure, had no diagnostic command
 * in sight, and gave up.
 *
 * These tests pin the doctor mention in every place a user is likely to
 * encounter trouble — so a future "let's clean up these messages" PR
 * can't accidentally drop the recovery hint and re-open the friction.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → src/ → mcp-server/
const srcDir = path.resolve(here, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(srcDir, rel), "utf-8");
}

describe("`deeppairing doctor --fix` surfaces (U6)", () => {
  it("init.ts post-success output mentions doctor / --fix", () => {
    const init = read("cli/init.ts");
    // Match the actual setup-complete block so we don't false-positive on
    // doctor being mentioned inside the doctor command itself.
    expect(init).toMatch(/Setup complete![\s\S]+?npx deeppairing doctor[\s\S]+?--fix/);
  });

  it("daemon.ts non-EADDRINUSE bind failure stderr mentions doctor --fix", () => {
    const daemon = read("daemon.ts");
    // The bind-failed branch:
    expect(daemon).toMatch(/bind failed[\s\S]+?npx deeppairing doctor --fix/);
  });

  it("daemon.ts no-free-port FATAL stderr mentions doctor --fix", () => {
    const daemon = read("daemon.ts");
    expect(daemon).toMatch(/No free port in range[\s\S]+?npx deeppairing doctor --fix/);
  });

  it("standalone.ts top-level catch stderr mentions doctor --fix", () => {
    const standalone = read("standalone.ts");
    expect(standalone).toMatch(/deepPairing wrapper[\s\S]+?npx deeppairing doctor --fix/);
  });
});

describe("Companion UI surfaces mention doctor (U6)", () => {
  it("SkillLoadBanner.tsx points at doctor --fix as the fallback", () => {
    const banner = fs.readFileSync(
      path.join(srcDir, "..", "web", "src", "components", "SkillLoadBanner.tsx"),
      "utf-8",
    );
    expect(banner).toMatch(/npx deeppairing doctor --fix/);
  });

  it("safeFetch's no_active_session message mentions doctor --fix", () => {
    const api = fs.readFileSync(
      path.join(srcDir, "..", "web", "src", "lib", "api.ts"),
      "utf-8",
    );
    expect(api).toMatch(/no_active_session[\s\S]+?npx deeppairing doctor --fix/);
  });

  it("safeFetch's network-error message points at doctor", () => {
    const api = fs.readFileSync(
      path.join(srcDir, "..", "web", "src", "lib", "api.ts"),
      "utf-8",
    );
    expect(api).toMatch(/network_error[\s\S]+?npx deeppairing doctor/);
  });
});
