/**
 * III8 follow-through — `dp philosophy publish on|off`.
 *
 * The `init` one-time prompt has told every user "You can flip this later:
 * `deeppairing philosophy publish on|off`" since the opt-in shipped; these
 * tests pin that the promised subcommand exists and actually flips the
 * `globalLedgerPublish` flag in <project>/.deeppairing/preferences.json.
 *
 * Spawns the REAL CLI (under tsx, no build required) against a scratch
 * project dir with HOME pointed at a scratch dir — never the real one —
 * so nothing can touch the user's actual ~/.deeppairing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "../init.ts");
const tsxBin = path.resolve(here, "../../../node_modules/.bin/tsx");

let projectDir: string;
let scratchHome: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-pub-proj-"));
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "dp-pub-home-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

function runPublish(args: string[]): string {
  return execFileSync(tsxBin, [cliEntry, "philosophy", "publish", ...args], {
    encoding: "utf-8",
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: scratchHome,
      USERPROFILE: scratchHome, // Windows homedir()
    },
  });
}

function readPublishFlag(): unknown {
  const prefsPath = path.join(projectDir, ".deeppairing", "preferences.json");
  if (!fs.existsSync(prefsPath)) return undefined;
  return JSON.parse(fs.readFileSync(prefsPath, "utf-8")).globalLedgerPublish;
}

describe("`dp philosophy publish` — the opt-in flip init's copy promises", () => {
  it("on → off → on round-trips through preferences.json", () => {
    expect(runPublish(["on"])).toContain("on");
    expect(readPublishFlag()).toBe(true);

    expect(runPublish(["off"])).toContain("off");
    expect(readPublishFlag()).toBe(false);

    expect(runPublish(["on"])).toContain("on");
    expect(readPublishFlag()).toBe(true);
  });

  it("bare `philosophy publish` reports the current state without changing it", () => {
    expect(runPublish([])).toContain("off"); // default is off
    expect(readPublishFlag()).toBeUndefined(); // status read never writes the flag

    runPublish(["on"]);
    expect(runPublish([])).toContain("on");
    expect(readPublishFlag()).toBe(true);
  });

  it("rejects anything that isn't on/off with a non-zero exit", () => {
    expect(() => runPublish(["maybe"])).toThrow();
    expect(readPublishFlag()).toBeUndefined();
  });

  it("never writes into HOME's global ledger (publish is a per-project flag)", () => {
    runPublish(["on"]);
    expect(fs.existsSync(path.join(scratchHome, ".deeppairing", "philosophy", "v1.json"))).toBe(false);
  });
}, 60_000);
