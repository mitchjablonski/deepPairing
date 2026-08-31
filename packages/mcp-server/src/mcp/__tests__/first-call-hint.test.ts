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
import { buildFirstCallHint, autonomyHintFor, personaHintFor } from "../first-call-hint.js";
import { AUTONOMY_POLICY_LINE } from "../autonomy-policy.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let fx: GlobalStoreFixture;
let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  fx = withGlobalStore("dp-first-call-hint-");
  tmpDir = fx.dir;
  store = fx.track(new FileStore(tmpDir, "hint_session"));
});

afterEach(() => {
  fx.dispose();
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

  it("#195 F1 — carries the Mermaid + annotated_code AUTHORING guidance (the only place it lives)", async () => {
    // The preamble is the SOLE surface teaching how to author a diagram without
    // a first-render break (grep-confirmed: nowhere else — not SKILL.md, not
    // onboarding, not a validator). A future prose-trim must NOT silently drop
    // it again, so pin the punctuation-quoting clause + the <br/> rule + the
    // annotated_code "exact lines" clause here.
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/quote labels with punctuation like \(\)#:/);
    expect(hint).toContain("`<br/>` not");
    expect(hint).toMatch(/at the exact lines changing and why/);
  });

  it("still leads with the happy-path choreography (visuals augment, don't replace it)", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    // M2 (#220) — step 5 now teaches the middle gear: spec and/or plan (one for
    // small multi-file work, both only for large features).
    expect(hint).toMatch(/present_spec and\/or present_plan/);
    expect(hint).toMatch(/present just ONE: spec when the WHAT/);
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
 * #139 / X1 — detail density (verbosity). The setting is delivered ONCE per
 * session through this first-call hint (never in check_feedback's per-loop
 * payload). AFTER THE X1 INVERSION: terse is the DEFAULT and the SILENT baseline
 * (emits NOTHING — byte-for-byte the pre-feature hint), and rich is the OPT-IN
 * that emits the short prose-expansion block. These pin: rich emits its block;
 * terse (default and explicit) emits nothing; and the FLOOR — the
 * code-review-before-it-lands guarantee terse must never collapse is now carried
 * by the always-on preamble, and the default hint still asserts it.
 */
/**
 * #195 M4 — pending-artifact inventory for a RESTARTED agent. The session store
 * reloads across runs, so draft artifacts a prior run presented are still
 * awaiting review on this run's first call. The hint surfaces a one-line
 * obligations-tier inventory (counts + types) so the agent polls before piling
 * on new work; absent entirely when nothing is pending.
 */
describe("first-call hint — #195 M4 pending-artifact inventory", () => {
  it("surfaces a one-line count+types inventory when draft artifacts await review", async () => {
    store.createArtifact({ id: "art_cs", type: "changeset", title: "Move TTL refresh", content: { files: [{ path: "a.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }] } });
    store.createArtifact({ id: "art_spec", type: "spec", title: "Session spec", content: { summary: "s", requirements: [] } });
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/2 artifacts you presented earlier still await review/);
    expect(hint).toMatch(/changeset/);
    expect(hint).toMatch(/spec/);
    expect(hint).toMatch(/call check_feedback before presenting new work/);
  });

  it("is ABSENT when there are no pending draft artifacts", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/still await/);
  });

  it("does NOT count an already-approved artifact as pending", async () => {
    store.createArtifact({ id: "art_ap", type: "spec", title: "Approved spec", content: { summary: "s", requirements: [] } });
    store.updateArtifactStatus("art_ap", "approved", "ui_approve_button" as never);
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/still await/);
  });
});

describe("first-call hint — #139/X1 detail density (terse-by-default)", () => {
  it("emits rich prose-expansion guidance when detailDensity is 'rich'", async () => {
    // X1 INVERSION: rich is now the OPT-IN that appends bytes; terse is silent.
    store.setDetailDensity("rich");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/Detail density: RICH/);
    // The concrete instruction that IS the opt-in.
    expect(hint).toMatch(/fuller prose/);
    // The floor is untouched by rich — those surfaces are unchanged.
    expect(hint).toMatch(/Evidence, structured fields, diagrams, and artifact count are unchanged/);
  });

  it("emits NO detail-density guidance in the default (terse) mode", async () => {
    // X1: default (never set) is terse — the SILENT baseline; no density block.
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/Detail density: RICH/);
    expect(hint).not.toMatch(/Detail density:/);
  });

  it("emits NO detail-density guidance when explicitly set back to 'terse'", async () => {
    store.setDetailDensity("rich");
    store.setDetailDensity("terse");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/Detail density: RICH/);
    expect(hint).not.toMatch(/Detail density:/);
  });

  it("FLOOR — terse-by-default still carries the load-bearing floor via the always-on preamble", async () => {
    // X1: the terse block is now empty, so the floor that terse must never
    // collapse is carried by the always-on PROTOCOL_PREAMBLE (and the SKILL
    // Voice guard), not by a per-dial block. A DEFAULT (terse, no density block)
    // hint must STILL assert the code-review-before-it-lands floor. These are
    // POSITIVE presence guards: a rewrite that drops the floor from the preamble
    // deletes one of them and fails HERE.
    const hint = await buildFirstCallHint(store, 4000);
    // No density block on the default path.
    expect(hint).not.toMatch(/Detail density:/);
    // #190 — the floor mandates a REVIEW SURFACE before code lands, carried by
    // the preamble's close-the-loop headline.
    expect(hint).toMatch(/present code for review before it lands/);
    expect(hint).toMatch(/batched present_changeset by default/);
    // And the run always ends with exactly one debrief.
    expect(hint).toMatch(/present_debrief/);
  });
});

/**
 * Explanation persona (the WHO axis) — the manual OVERRIDE. Generalizes the
 * detail-density terse/rich inversion EXACTLY: "auto" is the SILENT default
 * (contributes the empty string, so a default session's hint is byte-identical
 * to a pre-feature session and the agent auto-infers the audience), and each
 * SET persona appends its short frame block. These pin the inversion, that a set
 * persona rides the (uncapped) obligations tier, and that the round-trips through
 * the store.
 */
describe("first-call hint — explanation persona override (auto-default inversion)", () => {
  it("emits NO persona block in the default (auto) mode", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/Explanation persona:/);
  });

  it("emits NO persona block when explicitly set back to 'auto'", async () => {
    store.setPersona("stakeholder");
    store.setPersona("auto");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/Explanation persona:/);
  });

  it("'auto' is byte-identical-empty, exactly like terse-default", () => {
    // The inversion contract: the default contributes the empty string, so the
    // common path pays zero extra bytes.
    expect(personaHintFor("auto")).toBe("");
  });

  it("a SET persona appends its frame block (fluent-engineer)", async () => {
    store.setPersona("fluent-engineer");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/Explanation persona: FRAME EVERYTHING FOR a FLUENT ENGINEER/);
    // It states it overrides the auto-inferred frame and is orthogonal to the
    // other two axes.
    expect(hint).toMatch(/overriding the auto-inferred frame/);
    expect(hint).toMatch(/density \(how much\) and autonomy \(how many\) are unchanged/);
  });

  it("a SET persona appends its frame block (new-to-this-code)", async () => {
    store.setPersona("new-to-this-code");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/Explanation persona: FRAME EVERYTHING FOR someone NEW TO THIS CODE/);
    expect(hint).toMatch(/blast radius/);
  });

  it("a SET persona appends its frame block (stakeholder)", async () => {
    store.setPersona("stakeholder");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/Explanation persona: FRAME EVERYTHING FOR a STAKEHOLDER/);
    expect(hint).toMatch(/route the understanding through the DECISION/);
  });

  it("personaHintFor returns a non-empty block for each of the three set personas", () => {
    for (const p of ["fluent-engineer", "new-to-this-code", "stakeholder"] as const) {
      expect(personaHintFor(p).length).toBeGreaterThan(0);
    }
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

  it("FLOOR — the autonomous block keeps a review surface before code lands and defers to guardrails", async () => {
    store.setAutonomyLevel("autonomous");
    const hint = await buildFirstCallHint(store, 4000);
    // Positive-presence pins (a softening rewrite deletes one and fails here):
    // #190 — the dial never lifts the pre-land review record, but the floor no
    // longer prescribes a per-edit card — batched present_changeset is default.
    expect(hint).toMatch(/PRESENTED FOR REVIEW BEFORE IT LANDS/);
    expect(hint).toMatch(/reviews the artifact, not raw edits on disk/);
    // …and guardrail-path escalation overrides the dial.
    expect(hint).toMatch(/guardrails override this dial/i);
    expect(hint).toMatch(/escalate to supervised/);
  });

  it("FLOOR — the balanced block restates the review-before-land floor too (review: 'go straight to the work' must not read as 'Edit directly')", async () => {
    // Review-caught asymmetry: stating the floor ONLY in the autonomous block
    // invites the inference that balanced's skip-license is broader — i.e.
    // that "skip findings and go straight to the work" licenses skipping the
    // pre-land review record as well. Pin the floor in BOTH blocks.
    store.setAutonomyLevel("balanced");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/PRESENTED FOR REVIEW BEFORE IT LANDS/);
    expect(hint).toMatch(/never the review record/);
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
            const variantStore = fx.track(new FileStore(variantRoot, "matrix_session"));
            if (autonomy !== "supervised") variantStore.setAutonomyLevel(autonomy);
            // X1: terse is now the default; only rich needs an explicit set.
            if (density !== "terse") variantStore.setDetailDensity(density);
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
 * S2 / X1 — after the terse-by-default inversion, terse is the SILENT baseline
 * (it contributes nothing), so the old adjacency hazard — a terse floor sentence
 * two lines above the autonomous "Skip the opening findings/options ceremony" —
 * is gone. What remains to guard is the OTHER direction: the RICH opt-in states
 * its OWN division of labor ("artifact count are unchanged"), so a reader can't
 * mistake fuller prose for more artifacts, and it coexists with the autonomous
 * block without weakening either side.
 */
describe("first-call hint — S2/X1: rich/autonomy division of labor", () => {
  it("the rich block states that artifact count is unchanged (prose ≠ count)", async () => {
    store.setDetailDensity("rich");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toContain("artifact count are unchanged");
  });

  it("default (terse) emits NO density clause that could clash with the autonomous block", async () => {
    store.setAutonomyLevel("autonomous");
    const hint = await buildFirstCallHint(store, 4000);
    // Terse is silent — no density line at all — so no adjacency hazard.
    expect(hint).not.toMatch(/Detail density:/);
    expect(hint).toMatch(/Skip the opening findings\/options ceremony/);
  });

  it("rich coexists with the autonomous block without weakening either side", async () => {
    store.setDetailDensity("rich");
    store.setAutonomyLevel("autonomous");
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/Detail density: RICH/);
    expect(hint).toMatch(/Skip the opening findings\/options ceremony/);
  });
});

/**
 * Q3 — THE STALE NAG. The hint is assembled BEFORE the tool handler runs
 * (server.ts builds it, dispatches, then attaches it to a SUCCESSFUL result), so
 * a session whose first call is `answer_question` used to be handed a snapshot
 * that still contained the very comment it was answering. Round 12's observed
 * symptom: answering the ONLY open question came back with "1 unanswered human
 * question awaits… Drain these before new work." — a queue the agent had just
 * drained. Every obligation lane that keys on `!answeredByCommentId` now skips
 * the ids being answered.
 */
describe("first-call hint — Q3: the answer_question snapshot is not stale", () => {
  it("does NOT nag about the question this call is answering", async () => {
    store.createArtifact({ id: "art_1", type: "plan", title: "Plan", content: { steps: [] } });
    store.addComment({
      id: "cmt_q",
      artifactId: "art_1",
      content: "why a sliding window?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_1" },
    });

    // Control: with nothing excluded the nag fires (the instrument works).
    expect(await buildFirstCallHint(store, 4000)).toContain("unanswered human question");
    // The answer_question path excludes its own commentId.
    expect(await buildFirstCallHint(store, 4000, ["cmt_q"])).not.toContain("unanswered human question");
  });

  it("still nags about the OTHER questions the agent isn't answering", async () => {
    store.createArtifact({ id: "art_1", type: "plan", title: "Plan", content: { steps: [] } });
    for (const id of ["cmt_a", "cmt_b"]) {
      store.addComment({
        id,
        artifactId: "art_1",
        content: `q ${id}`,
        author: "human",
        intent: "question",
        target: { artifactId: "art_1" },
      });
    }
    const hint = await buildFirstCallHint(store, 4000, ["cmt_a"]);
    expect(hint).toContain("1 unanswered human question awaits");
    expect(hint).not.toContain("2 unanswered human questions");
  });

  it("excludes the id from the plain-comment mirror lane too (same predicate)", async () => {
    store.createArtifact({ id: "art_1", type: "plan", title: "Plan", content: { steps: [] } });
    store.addComment({
      id: "cmt_plain",
      artifactId: "art_1",
      content: "this needs a rollback story",
      author: "human",
      target: { artifactId: "art_1" },
    });
    expect(await buildFirstCallHint(store, 4000)).toContain("without an agent reply");
    expect(await buildFirstCallHint(store, 4000, ["cmt_plain"])).not.toContain("without an agent reply");
  });
});
