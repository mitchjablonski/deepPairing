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
import { buildFirstCallHint, autonomyHintFor } from "../first-call-hint.js";
import { AUTONOMY_POLICY_LINE } from "../autonomy-policy.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import crypto from "node:crypto";
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

/**
 * #148 — the autonomy dial reaches the OPENING artifacts. Pre-#148 the level
 * was delivered ONLY via check_feedback (which runs after the agent's first
 * artifacts), so "Light"/"Minimal" users still watched the full
 * findings→options→spec→plan ceremony before the dial ever spoke. These pin:
 * balanced/autonomous each emit their block in the first-call hint; supervised
 * (the default) emits NOTHING — the contribution is pinned as the literal
 * empty string, plus a sha self-consistency check that an explicit set equals
 * never-set; and the FLOOR — NEITHER balanced nor autonomous lifts
 * present_code_change, and autonomous still defers to guardrail escalation.
 */
describe("first-call hint — #148 autonomy dial guidance", () => {
  it("emits the balanced block iff autonomy is 'balanced'", async () => {
    store.setAutonomyLevel("balanced");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/Autonomy: BALANCED/);
    // Leads with the SAME policy line check_feedback repeats — no drift.
    expect(hint).toContain(AUTONOMY_POLICY_LINE.balanced);
    // The opening-ceremony instruction that IS the fix.
    expect(hint).toMatch(/skip present_findings/i);
    expect(hint).toMatch(/genuine architectural tradeoffs/);
    // Full sequence still applies to substantial work.
    expect(hint).toMatch(/Substantial work .* still gets the full sequence/);
    // Never the other level's block.
    expect(hint).not.toMatch(/Autonomy: AUTONOMOUS/);
  });

  it("emits the autonomous block iff autonomy is 'autonomous'", async () => {
    store.setAutonomyLevel("autonomous");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/Autonomy: AUTONOMOUS/);
    expect(hint).toContain(AUTONOMY_POLICY_LINE.autonomous);
    expect(hint).not.toMatch(/Autonomy: BALANCED/);
  });

  it("FLOOR — the autonomous block keeps present_code_change required and defers to guardrails", async () => {
    store.setAutonomyLevel("autonomous");
    const hint = await buildFirstCallHint(store, 4000);
    // Positive-presence pins (a softening rewrite deletes one and fails here):
    // the dial never lifts the pre-write review record…
    expect(hint).toMatch(/present_code_change BEFORE every Write\/Edit is still required/);
    expect(hint).toMatch(/it is the review record/);
    // …and guardrail-path escalation overrides the dial.
    expect(hint).toMatch(/guardrails override this dial/i);
    expect(hint).toMatch(/escalate to supervised/);
  });

  it("FLOOR — the balanced block restates present_code_change too (review: 'go straight to the work' must not read as 'Edit directly')", async () => {
    // Review-caught asymmetry: stating the floor ONLY in the autonomous block
    // invites the inference that balanced's skip-license is broader — i.e.
    // that "skip findings and go straight to the work" licenses skipping the
    // pre-write review record as well. Pin the floor in BOTH blocks.
    store.setAutonomyLevel("balanced");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/present_code_change BEFORE every Write\/Edit is still required/);
    expect(hint).toMatch(/this dial only trims findings\/options/);
  });

  it("supervised (default) contributes the EMPTY STRING — and an explicit set equals never-set", async () => {
    // The actual invariant, pinned directly: supervised's contribution to the
    // hint is zero bytes. (Deliberately NOT a recorded sha of the whole hint —
    // that would false-fail on every legitimate preamble edit.)
    expect(autonomyHintFor("supervised")).toBe("");
    // Self-consistency: explicitly setting supervised produces the same hint
    // as a never-set default store.
    const defaultHint = await buildFirstCallHint(store, 4000);
    store.setAutonomyLevel("supervised");
    const supervisedHint = await buildFirstCallHint(store, 4000);
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    expect(sha(supervisedHint)).toBe(sha(defaultHint));
    // And no autonomy-dial text leaks into the default path (zero hot-path bytes).
    expect(defaultHint).not.toMatch(/Autonomy: (BALANCED|AUTONOMOUS|SUPERVISED)/);
    expect(defaultHint).not.toContain(AUTONOMY_POLICY_LINE.balanced);
    expect(defaultHint).not.toContain(AUTONOMY_POLICY_LINE.autonomous);
  });

  it("round-trips: setting back to supervised removes the block again", async () => {
    store.setAutonomyLevel("autonomous");
    store.setAutonomyLevel("supervised");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/Autonomy: (BALANCED|AUTONOMOUS)/);
  });
});

/**
 * S1 — guardrails must survive EVERY dial combination. Pre-fix, the 🛡
 * section rode the CAPPED contextual tier while #139's terse block and
 * #148's autonomy blocks rode the uncapped obligations tier AND were
 * charged against the contextual budget (baselineLen includes
 * obligations). Under {balanced|autonomous} × terse only ~260 chars of
 * contextual budget remained, so the guardrails section was evicted —
 * exactly when the autonomous block says "escalate to supervised for
 * changes in guardrail paths". Guardrails have NO recall mode and no
 * preflight backstop: evicted means gone. This matrix pins the invariant:
 * guardrails present in ALL 24 variants whenever guardrails exist.
 */
describe("first-call hint — S1: guardrails survive all 24 dial variants", () => {
  const AUTONOMIES = ["supervised", "balanced", "autonomous"] as const;
  const DENSITIES = ["rich", "terse"] as const;
  const FLAGS = [false, true] as const;

  it("🛡 section (header + path lines) present whenever guardrails exist, across the full matrix", async () => {
    const failures: string[] = [];
    for (const autonomy of AUTONOMIES) {
      for (const density of DENSITIES) {
        for (const withGuardrails of FLAGS) {
          for (const withRejected of FLAGS) {
            // Fresh project root per variant — guardrails are sensed from the
            // filesystem at FileStore construction.
            const variantRoot = fs.mkdtempSync(path.join(tmpDir, "variant-"));
            if (withGuardrails) {
              fs.mkdirSync(path.join(variantRoot, "migrations"), { recursive: true });
              fs.mkdirSync(path.join(variantRoot, ".github", "workflows"), { recursive: true });
            }
            const variantStore = new FileStore(variantRoot, "matrix_session");
            if (autonomy !== "supervised") variantStore.setAutonomyLevel(autonomy);
            if (density !== "rich") variantStore.setDetailDensity(density);
            if (withRejected) {
              variantStore.recordRejectedApproach({
                description: "Store session state in a module-level global singleton",
                reason: "hides lifecycle and breaks multi-session isolation",
              });
            }
            const hint = await buildFirstCallHint(variantStore, 4000);
            variantStore.forceFlush();
            const label = `${autonomy} × ${density} × guardrails=${withGuardrails} × rejected=${withRejected}`;
            if (withGuardrails) {
              // Header AND the actual path lines — a header without the list
              // is unactionable ("escalate in guardrail paths"… which paths?).
              if (!hint.includes("🛡 Project guardrails")) {
                failures.push(`${label}: 🛡 guardrails section EVICTED`);
              } else if (!hint.includes("migrations") || !hint.includes(".github/workflows")) {
                failures.push(`${label}: 🛡 header present but path lines missing`);
              }
            } else if (hint.includes("🛡 Project guardrails")) {
              failures.push(`${label}: phantom 🛡 section with no guardrails`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

/**
 * S2 — the terse block's floor sentence ("do NOT skip present_options or
 * present_code_change") sits two lines above the autonomous block's "Skip
 * the opening findings/options ceremony". Adjacent absolutes pointing
 * opposite ways on the same tool invite inconsistent behavior. The terse
 * line now states the division of labor: terse governs TEXT only; whether
 * an artifact posts at all is the Autonomy dial's call.
 */
describe("first-call hint — S2: terse/autonomy division of labor", () => {
  it("terse block names the Autonomy dial as the authority on whether artifacts post", async () => {
    store.setDetailDensity("terse");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toContain("Terse governs TEXT only");
    expect(hint).toContain("Autonomy dial");
    // The floor sentence itself is intact (also pinned by the #139 FLOOR test).
    expect(hint).toMatch(/do NOT skip present_options or present_code_change/);
  });

  it("the clause coexists with the autonomous block without weakening either side", async () => {
    store.setDetailDensity("terse");
    store.setAutonomyLevel("autonomous");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toContain("Terse governs TEXT only");
    expect(hint).toMatch(/Skip the opening findings\/options ceremony/);
  });
});
