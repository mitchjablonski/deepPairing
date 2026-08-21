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

type Art = { id: string; type: string; status: string; createdAt: string; content?: unknown };
const cc = (id: string, createdAt = recent): Art => ({ id, type: "code_change", status: "approved", createdAt });
const cs = (id: string, createdAt = recent): Art => ({ id, type: "changeset", status: "approved", createdAt });
/** Q6 (#232) — a changeset that is somebody ELSE'S code (a GitHub PR on the
 *  review surface). Invisible to the debrief gate: the pair reviewed it, they
 *  did not write it, and the session's output is the review they post back. */
const csExternal = (id: string, createdAt = recent): Art => ({
  id, type: "changeset", status: "approved", createdAt,
  content: { files: [], reviewIntent: "external", source: { kind: "github-pr", number: 123 } },
});
/** The control: a changeset that carries content but is explicitly LOCAL. Guards
 *  against a carve-out that accidentally keys on "has content" or "has a
 *  reviewIntent key at all" rather than on the value. */
const csLocal = (id: string, createdAt = recent): Art => ({
  id, type: "changeset", status: "approved", createdAt,
  content: { files: [], reviewIntent: "local" },
});
const dec = (id: string): Art => ({ id, type: "decision", status: "approved", createdAt: recent });
const dbf = (id: string): Art => ({ id, type: "debrief", status: "approved", createdAt: recent });
const plan = (id: string): Art => ({ id, type: "plan", status: "approved", createdAt: recent });
const spec = (id: string): Art => ({ id, type: "spec", status: "approved", createdAt: recent });
const ccSuperseded = (id: string): Art => ({ id, type: "code_change", status: "superseded", createdAt: recent });
const dbfRetracted = (id: string): Art => ({ id, type: "debrief", status: "retracted", createdAt: recent });

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
  // F1 — a spec or plan means the work was feature-shaped, not a surgical fix.
  { name: "code_change + plan (F1)", artifacts: [cc("c1"), plan("p1")], owesDebrief: true },
  { name: "code_change + spec (F1)", artifacts: [cc("c1"), spec("sp1")], owesDebrief: true },
  // F2 — a superseded code_change + its live revision is ONE live change (a
  // tweaked trivial fix keeps its carve-out), not two.
  { name: "superseded code_change + live code_change (F2)", artifacts: [ccSuperseded("c0"), cc("c1")], owesDebrief: false },
  // F2 — a RETRACTED debrief no longer satisfies the obligation; the close was
  // attempted but isn't standing, so it's still owed.
  { name: "code_change + retracted debrief (F2)", artifacts: [cc("c1"), dbfRetracted("b0")], owesDebrief: true },
  // Q6 (#232) — the EXTERNAL-REVIEW carve-out. A changeset carrying
  // reviewIntent:"external" is a colleague's PR pulled onto the review surface;
  // it is never "code was presented", so it never puts the session in
  // debrief-owed territory. Five cases pin the whole shape of the decision.
  //
  // (a) the intended case: a session whose entire output is a PR review.
  { name: "single EXTERNAL changeset (Q6 carve-out)", artifacts: [csExternal("x1")], owesDebrief: false },
  // (b) the control — an explicitly LOCAL changeset with content still owes, so
  //     the carve-out keys on the VALUE, not on the presence of content.
  { name: "single LOCAL changeset with content (Q6 control)", artifacts: [csLocal("s1")], owesDebrief: true },
  // (c) reviewing a PR does NOT escalate the pair's own trivial fix: the
  //     colleague's diff says nothing about how big your own one-file change was.
  { name: "EXTERNAL changeset + one code_change stays TRIVIAL (Q6)", artifacts: [csExternal("x1"), cc("c1")], owesDebrief: false },
  // (d) the carve-out is scoped: real local work alongside a PR review still owes.
  { name: "EXTERNAL changeset + LOCAL changeset (Q6 scope)", artifacts: [csExternal("x1"), cs("s1")], owesDebrief: true },
  // (e) …and ceremony still escalates over the top of it (a decision means the
  //     pair shaped something of their own, whatever else the session read).
  { name: "EXTERNAL changeset + code_change + decision (Q6 scope)", artifacts: [csExternal("x1"), cc("c1"), dec("d1")], owesDebrief: true },
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
