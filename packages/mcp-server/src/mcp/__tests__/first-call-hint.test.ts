/**
 * The first-call hint carries the ALWAYS-ON protocol preamble — the
 * orientation every agent gets on its first MCP call, even when the consuming
 * project wired only the MCP server (no pairing-protocol skill, no init). It is
 * therefore the one surface guaranteed to teach a capability.
 *
 * Regression pin: pre-this, the happy path walked recall → findings → options →
 * spec → plan → code_change but NEVER mentioned visuals, so an agent following
 * the preamble faithfully produced a wall of prose and never learned that
 * diagrams / file maps / annotated code / prototypes exist. These tests assert
 * the preamble names visuals and each kind so the capability can't fall out of
 * the guaranteed surface again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildFirstCallHint } from "../first-call-hint.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-first-call-hint-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "hint_session");
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

describe("first-call hint — always-on protocol preamble", () => {
  it("teaches the agent to attach visuals when planning, naming every kind", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/visuals\[\]/);
    expect(hint).toMatch(/diagram/);
    expect(hint).toMatch(/file_map/);
    expect(hint).toMatch(/annotated_code/);
    expect(hint).toMatch(/prototype/);
  });

  it("still leads with the happy-path choreography (visuals augment, don't replace it)", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/present_spec, then present_plan/);
    expect(hint).toMatch(/check_feedback/);
    expect(hint).toMatch(/present_code_change/);
  });

  it("teaches revise_artifact over re-posting (the adoption rule that makes the revision diff fire)", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/revise_artifact/);
    expect(hint).toMatch(/supersede/);
    // names the failure mode it's steering away from
    expect(hint).toMatch(/re-post/i);
  });

  it("steers decisions to present_options, not buried/interleaved in a plan", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/present_options/);
    // names the failure mode: don't bury / interleave a decision in a plan
    expect(hint).toMatch(/interleave|bury|own card/i);
  });

  it("I7 — pushes the LIVE companion UI URL built from the daemon's real port, and forbids guessing 5173", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    // The exact URL from the daemon's port fixture, not a placeholder.
    expect(hint).toContain("http://localhost:4000");
    // Names the hallucination it's steering away from (field: agent said 5173).
    expect(hint).toMatch(/5173/);
    expect(hint).toMatch(/never guess|NEVER guess|not a guess/i);
  });

  it("I7 — is honest when the daemon port isn't known yet (no bogus URL)", async () => {
    const hint = await buildFirstCallHint(store, 0);
    // Never emit a fabricated localhost URL when we don't have a real port.
    expect(hint).not.toMatch(/http:\/\/localhost:\d+/);
    // Point the agent at onboarding instead of guessing.
    expect(hint).toMatch(/deeppairing:\/\/onboarding/);
    expect(hint).toMatch(/5173/);
  });
});

/**
 * #139 — detail density (verbosity). The setting is delivered ONCE per session
 * through this first-call hint (never in check_feedback's per-loop payload).
 * These pin: terse emits concrete prose-tightening guidance; rich (the default)
 * emits NOTHING (byte-for-byte the pre-feature hint); and the FLOOR — terse may
 * shrink prose but the guidance must NEVER tell the agent to drop Evidence,
 * skip an artifact, or reduce the number of artifacts.
 */
describe("first-call hint — #139 detail density", () => {
  it("emits terse prose-tightening guidance when detailDensity is 'terse'", async () => {
    store.setDetailDensity("terse");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/Detail density: TERSE/);
    // The concrete instruction that IS the feature.
    expect(hint).toMatch(/1[–-]2 sentences/);
    expect(hint).toMatch(/[Ll]ead with the evidence/);
  });

  it("emits NO detail-density guidance in the default 'rich' mode", async () => {
    // Default (never set) is rich; the hint must not carry the terse block.
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/Detail density: TERSE/);
    expect(hint).not.toMatch(/detail density/i);
  });

  it("emits NO detail-density guidance when explicitly set back to 'rich'", async () => {
    store.setDetailDensity("terse");
    store.setDetailDensity("rich");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/Detail density: TERSE/);
  });

  it("FLOOR — terse guidance carries the load-bearing prohibitions verbatim", async () => {
    store.setDetailDensity("terse");
    const hint = await buildFirstCallHint(store, 4000);
    // The floor is the POSITIVE guard: these exact prohibition sentences must
    // exist, so a well-meaning rewrite that softens the floor (e.g. "attach
    // evidence when relevant") deletes one of them and fails HERE. A blacklist
    // of phrasings-we-happened-to-avoid is theater — it can't catch a novel
    // floor-violating rewrite — so this test asserts presence, not absence.
    expect(hint).toMatch(/Do NOT reduce the number of artifacts/);
    expect(hint).toMatch(/do NOT skip present_options or present_code_change/);
    expect(hint).toMatch(/NEVER omit `Evidence`/);
    // Pin the LITERAL evidence shape the agent must always attach — the whole
    // point of the floor is that terse trims prose, never the four Evidence
    // fields. If the parenthetical is dropped/reworded, this fails.
    expect(hint).toContain("`Evidence` (filePath, lineStart, lineEnd, snippet)");
    // And the explicit statement that terse trims prose, not evidence.
    expect(hint).toMatch(/never the evidence itself/);
  });
});
