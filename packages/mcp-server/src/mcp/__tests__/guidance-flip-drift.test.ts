/**
 * #190 — the DEFAULT-MODE FLIP wording drift guard.
 *
 * Same class-ending pattern as the tool-count drift guard (server-contract.test):
 * the flip lives across THREE guidance surfaces that must agree — SKILL.md, the
 * tool descriptions, and the first-call hint (incl. its per-dial FLOOR lines).
 * A stale sentence in ANY one makes the guidance self-contradict ("batch by
 * default" vs "present_code_change BEFORE every Write/Edit is still required"),
 * and the agent picks randomly — landing hardest in AUTONOMOUS, the debrief's own
 * target mode. This test would have caught that: it pins the flip's key phrases
 * PRESENT in SKILL.md + the assembled hint, and the stale per-edit mandates
 * ABSENT from both.
 *
 * Scoped to the two known guidance files (SKILL.md + the built first-call hint
 * across every dial), so the dated CHANGELOG's historical phrasings can't
 * false-fail. Needles are specific full sentences, not loose substrings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildFirstCallHint } from "../first-call-hint.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-flip-drift-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "flip_drift_session");
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

/** Assemble the hint across EVERY dial + density so the per-dial FLOOR lines
 *  (balanced / autonomous) and the terse floor are all in the scanned text. */
async function assembleAllHints(): Promise<string> {
  const parts: string[] = [];
  parts.push(await buildFirstCallHint(store, 4000)); // supervised default
  store.setAutonomyLevel("balanced");
  parts.push(await buildFirstCallHint(store, 4000));
  store.setAutonomyLevel("autonomous");
  parts.push(await buildFirstCallHint(store, 4000));
  store.setAutonomyLevel("supervised");
  store.setDetailDensity("terse");
  parts.push(await buildFirstCallHint(store, 4000));
  return parts.join("\n");
}

function readSkill(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // __tests__ → mcp → src → mcp-server → packages → repo root
  const repoRoot = path.resolve(here, "../../../../..");
  return fs.readFileSync(path.join(repoRoot, "claude-plugin/skills/pairing-protocol/SKILL.md"), "utf-8");
}

// The stale per-edit mandates the flip REPLACED. Their presence anywhere in the
// guidance re-introduces the contradiction Fix 1 closed.
const STALE_PHRASES: RegExp[] = [
  /present_code_change BEFORE every Write\/Edit is still required/i,
  /do NOT skip present_options or present_code_change/i,
  /BEFORE every Write\/Edit/i,
];

describe("#190 — default-mode flip: guidance wording is consistent (drift guard)", () => {
  it("SKILL.md carries the flip's key phrases", () => {
    const skill = readSkill();
    expect(skill).toMatch(/the DEFAULT for presenting code/); // changeset is default
    expect(skill).toMatch(/the \*\*exception\*\*, not the beat/); // code_change is the exception
    expect(skill).toMatch(/END EVERY feature or autonomous run/); // debrief at the end
    expect(skill).toMatch(/present_debrief/);
    expect(skill).toMatch(/\*\*sparingly\.\*\*/); // log_reasoning demoted
    // "details in chat" is a protocol violation (deliberation goes in the artifact)
    expect(skill).toMatch(/"details in chat"/);
    expect(skill).toMatch(/protocol violation/);
  });

  it("the assembled first-call hint (all dials) carries the flip's key phrases", async () => {
    const hint = await assembleAllHints();
    expect(hint).toMatch(/the DEFAULT is a batched present_changeset/);
    expect(hint).toMatch(/present_debrief — END every feature/);
    expect(hint).toMatch(/never 'details in chat'/);
    // The per-dial FLOORs mandate a review surface WITHOUT prescribing per-edit.
    expect(hint).toMatch(/PRESENTED FOR REVIEW BEFORE IT LANDS/);
    expect(hint).toMatch(/present_changeset at feature boundaries by default/);
  });

  it("NEITHER SKILL.md NOR the assembled hint contains a stale per-edit mandate", async () => {
    const skill = readSkill();
    const hint = await assembleAllHints();
    for (const stale of STALE_PHRASES) {
      expect(skill, `SKILL.md still contains stale phrasing: ${stale}`).not.toMatch(stale);
      expect(hint, `the first-call hint still contains stale phrasing: ${stale}`).not.toMatch(stale);
    }
  });
});
