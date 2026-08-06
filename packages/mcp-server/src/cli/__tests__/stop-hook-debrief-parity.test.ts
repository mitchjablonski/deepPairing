/**
 * J2a (#210) — PARITY INSURANCE for the debrief-owed gate's TWO hand-maintained
 * Stop-hook copies.
 *
 * The gate ("does this session owe a closing present_debrief?") lives in three
 * places that must agree:
 *   • src/debrief-gate.ts::sessionOwesDebrief — the shared predicate, imported
 *     by check-feedback.ts AND stop-hook-entry.ts (esbuild inlines it into the
 *     committed bundle claude-plugin/server/stop.mjs);
 *   • setup-tasks.ts STOP_HOOK_SCRIPT — the init-generated .mjs, which is
 *     self-contained and CANNOT import, so it carries a hand-maintained INLINE
 *     TWIN of the same logic.
 *
 * The code-lens ask: a test asserting the two copies agree on a case matrix.
 * Since the init script can't import, we can't unit-compare functions — so this
 * runs BOTH scripts (the committed bundle + a freshly init-generated script)
 * over an identical fixture matrix and asserts (a) they agree with each other
 * and (b) they agree with the expected debrief-owed outcome.
 *
 * All fixture artifacts are `approved` so the higher-priority "pending
 * artifacts" blocking nag never fires — isolating the debrief-owed dimension.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStopHook } from "../setup-tasks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → cli → src → mcp-server → packages → repo root
const repoRoot = path.resolve(here, "../../../../..");
const committedBundle = path.join(repoRoot, "claude-plugin", "server", "stop.mjs");
const bundleBuilt = fs.existsSync(committedBundle);

const NOW = Date.now();
const recent = new Date(NOW - 60 * 1000).toISOString();
const ancient = new Date(NOW - 45 * 60 * 1000).toISOString(); // > 30-min age guard

type Art = { id: string; type: string; status: string; createdAt: string };
const cc = (id: string, createdAt = recent): Art => ({ id, type: "code_change", status: "approved", createdAt });
const cs = (id: string, createdAt = recent): Art => ({ id, type: "changeset", status: "approved", createdAt });
const dec = (id: string): Art => ({ id, type: "decision", status: "approved", createdAt: recent });
const dbf = (id: string): Art => ({ id, type: "debrief", status: "approved", createdAt: recent });

interface Case {
  name: string;
  artifacts: Art[];
  owesDebrief: boolean;
}

const MATRIX: Case[] = [
  { name: "single code_change (TRIVIAL)", artifacts: [cc("c1")], owesDebrief: false },
  { name: "two code_changes", artifacts: [cc("c1"), cc("c2")], owesDebrief: true },
  { name: "single changeset", artifacts: [cs("s1")], owesDebrief: true },
  { name: "code_change + decision", artifacts: [cc("c1"), dec("d1")], owesDebrief: true },
  { name: "code_change + debrief present", artifacts: [cc("c1"), dbf("b1")], owesDebrief: false },
  { name: "changeset + code_change", artifacts: [cs("s1"), cc("c1")], owesDebrief: true },
  { name: "no code at all", artifacts: [], owesDebrief: false },
  { name: "single code_change aged out (>30m)", artifacts: [cc("c1", ancient)], owesDebrief: false },
];

/** Runs a stop script against a project dir seeded with `artifacts`, returns
 *  whether it fired the debrief-owed nag (read from hooks-state.json). */
function runAndReadOwes(script: string, artifacts: Art[]): boolean {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-parity-"));
  try {
    const sessionDir = path.join(projectDir, ".deeppairing", "sessions", "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "artifacts.json"), JSON.stringify(artifacts));
    execFileSync("node", [script], {
      input: "",
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    const state = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".deeppairing", "hooks-state.json"), "utf-8"),
    );
    const reason = String(state.fires.at(-1)?.reason ?? "");
    return /owes debrief/.test(reason);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

describe("J2a — Stop-hook debrief-owed gate: bundle ↔ init-script parity", () => {
  let initScript: string;
  let initRoot: string;

  beforeEach(() => {
    // Generate the init-path script (setup-tasks STOP_HOOK_SCRIPT → disk).
    initRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-init-"));
    const res = ensureStopHook(initRoot);
    expect(res.ok).toBe(true);
    initScript = path.join(initRoot, ".deeppairing", "hooks", "stop.mjs");
    expect(fs.existsSync(initScript)).toBe(true);
  });

  afterEach(() => {
    fs.rmSync(initRoot, { recursive: true, force: true });
  });

  for (const c of MATRIX) {
    it.skipIf(!bundleBuilt)(`${c.name}: both copies agree (owes=${c.owesDebrief})`, () => {
      const initOwes = runAndReadOwes(initScript, c.artifacts);
      const bundleOwes = runAndReadOwes(committedBundle, c.artifacts);
      // Parity: the two hand-maintained copies must agree with EACH OTHER…
      expect(bundleOwes, `bundle vs init disagree on "${c.name}"`).toBe(initOwes);
      // …and with the expected outcome.
      expect(initOwes, `init-script wrong on "${c.name}"`).toBe(c.owesDebrief);
      expect(bundleOwes, `bundle wrong on "${c.name}"`).toBe(c.owesDebrief);
    });
  }

  it("the init-generated script is present even when the committed bundle isn't built (parity is gated on the bundle only)", () => {
    // Guards against a silent no-op: ensureStopHook must always write a runnable
    // script; only the cross-copy comparison depends on the committed bundle.
    expect(fs.existsSync(initScript)).toBe(true);
  });
});
