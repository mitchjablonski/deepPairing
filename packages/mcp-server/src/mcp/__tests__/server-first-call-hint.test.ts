/**
 * D2 — split from the 3,009-line server.test.ts along tool-surface seams.
 * Test bodies are verbatim from the monolith; only the harness wiring is new.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { createMcpServer } from "../server.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

describe("MCP Tool Handlers — firstCallHint", () => {
  describe("firstCallHint — team conventions (N6.3)", () => {
    it("is absent from the hint when team.json is missing", async () => {
      // Outer beforeEach already created `store` without a team.json.
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toContain("🚫 Team rules");
    });

    it("renders require / avoid / prefer groups with scope and rationale", async () => {
      // Need a FRESH store: team.json is read in the FileStore constructor.
      // Write it to a new tmpDir, then spin up a new server bound to it.
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-hint-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({
          version: 1,
          preferences: [
            { id: "req1", kind: "require", concept: "argon2id for password hashing", rationale: "bcrypt is brute-forceable", scope: { paths: ["packages/auth/**"] } },
            { id: "avoid1", kind: "avoid", concept: "global state", rationale: "breaks testability" },
            { id: "prefer1", kind: "prefer", concept: "repository pattern", rationale: "keeps SQL out of handlers" },
          ],
        }),
      );
      const freshStore = new FileStore(freshTmp, "team_hint_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);

      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");

      expect(text).toContain("🚫 Team rules");
      expect(text).toContain("Required:");
      expect(text).toContain("argon2id for password hashing");
      expect(text).toContain("bcrypt is brute-forceable");
      expect(text).toContain("scope: packages/auth/**");
      expect(text).toContain("Avoid:");
      expect(text).toContain("global state");
      expect(text).toContain("Preferred:");
      expect(text).toContain("repository pattern");

      // Team conventions + personal philosophy + guardrails are NEVER merged —
      // each has its own header so the agent can see the authority distinction.
      expect(text).toContain("🚫 Team rules");
      // No stray merged "Team + personal" header.
      expect(text).not.toMatch(/Team\s*\+\s*personal/i);

      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });

    it("FF5 — 'require'/'avoid' route to obligations tier (uncapped), 'prefer' stays in contextual (capped)", async () => {
      // Pre-FF5 all three groups went into contextualParts and could
      // be silently dropped by HINT_BUDGET_CHARS truncation. Now hard
      // rules survive the budget; taste competes with other context.
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-ff5-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({
          version: 1,
          preferences: [
            { id: "r1", kind: "require", concept: "FF5 hard required", rationale: "regulatory" },
            { id: "a1", kind: "avoid", concept: "FF5 hard avoid", rationale: "incident history" },
            { id: "p1", kind: "prefer", concept: "FF5 soft preference", rationale: "team taste" },
          ],
        }),
      );
      const freshStore = new FileStore(freshTmp, "team_ff5_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);
      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      // Hard rules block is the obligations-tier copy.
      expect(text).toContain("🚫 Team rules");
      expect(text).toMatch(/hard.*'require' as imperatives.*'avoid' as refusal triggers/i);
      expect(text).toContain("FF5 hard required");
      expect(text).toContain("FF5 hard avoid");
      // Soft preferences are now a separate, contextual-tier block.
      expect(text).toContain("💡 Team preferences");
      expect(text).toMatch(/taste, weigh against the user's goal/i);
      expect(text).toContain("FF5 soft preference");
      // The hard-rules block precedes the soft-preferences block in the
      // assembled hint (obligations come before contextual).
      const hardIdx = text.indexOf("🚫 Team rules");
      const softIdx = text.indexOf("💡 Team preferences");
      expect(hardIdx).toBeGreaterThanOrEqual(0);
      expect(softIdx).toBeGreaterThan(hardIdx);
      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });

    it("HH6 — oversize hard rule gets truncated (not dropped) so the agent still sees the imperative", async () => {
      // Pre-HH6 a single 700-char require entry was dropped entirely:
      // agent saw "🚫 Team rules" + "Required:" + "📦 1 more rule line"
      // with NO rule body. Wrong failure mode for a hard rule. Now we
      // truncate to fit and tag with "…[truncated; full rule in
      // .deeppairing/team.json]".
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-hh6-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      // One require entry whose rendered line will exceed the budget.
      const longRationale = "the regulatory authority requires explicit attestation that ".repeat(20);
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({
          version: 1,
          preferences: [
            { id: "r1", kind: "require", concept: "HH6 oversize hard rule", rationale: longRationale },
          ],
        }),
      );
      const freshStore = new FileStore(freshTmp, "team_hh6_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);
      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      // The rule is present (concept name survives truncation).
      expect(text).toContain("HH6 oversize hard rule");
      // The truncation marker fires.
      expect(text).toMatch(/\[truncated; full rule in \.deeppairing\/team\.json\]/);
      // Critically: the section is NOT empty (no header-only output).
      expect(text).toContain("Required:");
      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });

    it("GG4 — large team.json caps the rules section at TEAM_RULES_BUDGET_CHARS + emits 📦 N more trailer", async () => {
      // Pre-GG4 obligationsParts was uncapped — a 50-rule team.json
      // dumped ~6KB into every first-call hint, dwarfing the 1500-char
      // budget. Cap is 600 chars; trailer mentions the dropped count
      // and points the agent at .deeppairing/team.json for the rest.
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-gg4-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      // 30 require + 30 avoid rules, each ~80 chars rendered. Total
      // ~5KB — well past the 600 cap.
      const preferences = [];
      for (let i = 0; i < 30; i++) {
        preferences.push({
          id: `req${i}`, kind: "require",
          concept: `GG4 required rule number ${i} with prose`,
          rationale: `regulatory requirement that exists for compliance reason number ${i}`,
        });
      }
      for (let i = 0; i < 30; i++) {
        preferences.push({
          id: `av${i}`, kind: "avoid",
          concept: `GG4 forbidden pattern number ${i}`,
          rationale: `incident history reason number ${i} that we never want to repeat`,
        });
      }
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({ version: 1, preferences }),
      );
      const freshStore = new FileStore(freshTmp, "team_gg4_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);
      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      // Header survives.
      expect(text).toContain("🚫 Team rules");
      // At least one rule survives.
      expect(text).toMatch(/GG4 (required|forbidden)/);
      // The 📦 trailer appears with a dropped count + pointer.
      expect(text).toMatch(/📦 \d+ more rule lines? — see \.deeppairing\/team\.json/);
      // The team-rules block alone is bounded — pull out just the section.
      const sectionStart = text.indexOf("🚫 Team rules");
      const nextSectionStart = (() => {
        const candidates = ["📋 From previous sessions", "🌱", "🧭", "💡 Team preferences", "📦"];
        let best = text.length;
        for (const c of candidates) {
          const idx = text.indexOf(c, sectionStart + 1);
          if (idx > 0 && idx < best) best = idx;
        }
        return best;
      })();
      const teamSection = text.slice(sectionStart, nextSectionStart);
      // Allow some overhead — must be well under the 1500-char total budget.
      expect(teamSection.length).toBeLessThan(800);
      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });

    it("omits the section entirely when the only prefs would produce empty groups", async () => {
      // With zero valid preferences, the section must not appear (low-signal
      // empty sections just add noise to the hint).
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-empty-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({ version: 1, preferences: [] }),
      );
      const freshStore = new FileStore(freshTmp, "team_empty_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);

      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");

      expect(text).not.toContain("🚫 Team rules");

      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });
  });

  describe("firstCallHint — welcome-back ledger line (R2)", () => {
    it("stays silent when the ledger has fewer than 5 concepts", async () => {
      // The outer test suite's store has an empty ledger by default.
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).not.toContain("🌱");
      expect(text).not.toContain("Your deepPairing ledger");
    });

    it("DD3 — surfaces user-seeded stances as a [SEED] block in firstCallHint blocking tier", async () => {
      // PMF + ease-of-use + MCP all flagged: pre-DD3, seeds appeared
      // anonymously in the philosophy block (low priority, lost to
      // budget truncation first). Now they get their own SEED-tagged
      // block routed through blockingParts so the agent sees them on
      // every fresh session even when the rest of the hint is heavy.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      ledger.recordInstance("DD3 seeded avoid", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "DD3 seeded avoid",
      });
      ledger.recordInstance("DD3 seeded prefer", {
        project: "manual", sessionId: "seed", verdict: "approved", description: "DD3 seeded prefer",
      });
      // A manual seed that ALSO got cited in a real session.
      ledger.recordInstance("DD3 seed and fired", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "DD3 seed and fired",
      });
      ledger.recordInstance("DD3 seed and fired", {
        project: "/some/real/project", sessionId: "real_sess", verdict: "rejected", description: "DD3 seed and fired",
      });
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).toContain("🌱 The user explicitly seeded these stances");
      expect(text).toContain("[SEED]");
      expect(text).toContain("DD3 seeded avoid");
      expect(text).toContain("DD3 seeded prefer");
      expect(text).toContain("DD3 seed and fired");
      // Cited seed shows the also-fired count.
      expect(text).toContain("also fired 1× in real sessions");
    });

    it("FF8 — when BOTH policy and contextual drop, the policy-specific hint is suppressed (single recall pointer suffices)", async () => {
      // Pre-FF8 the 📦 line ended with two hints stacked: "Call recall
      // with mode='philosophy' or mode='sessions'..." plus "Use recall
      // with mode='philosophy' source='user-seeded'..." Noisy. Now the
      // policy-specific hint only fires when ONLY policy dropped.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // Heavy seeded stances → policy tier overflows.
      for (let i = 0; i < 8; i++) {
        ledger.recordInstance(
          `FF8 long seed ${i} aaaaaaaaaaaaaa bbbbbbbbbb cccccccccccc dddddddddddddd eeeeeeeeeee`,
          { project: "manual", sessionId: "seed", verdict: "rejected", description: "x" },
        );
      }
      // AND a heavy contextual-tier rejected approach so contextual also
      // overflows. Use repeated rejections to make a chunky memory block.
      for (let i = 0; i < 6; i++) {
        store.recordRejectedApproach({
          description: `FF8 contextual rejection number ${i} with long-prose content padding to push budget over the cap aaaa bbbb cccc dddd eeee`,
          reason: "test padding to push budget consumption past the contextual cap",
        });
      }
      const { text } = await callTool("present_findings", {
        summary: "FF8 trigger",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).toContain("📦");
      // The generic recall pointer is present.
      expect(text).toMatch(/Call `recall` with mode='philosophy' or mode='sessions'/);
      // The policy-specific hint is NOT stacked on top.
      expect(text).not.toMatch(/Use `recall` with mode='philosophy' source='user-seeded'/);
    });

    it("EE1 — seeded stances respect the policy cap; cap-overflow nudges agent to recall mode='philosophy' source='user-seeded'", async () => {
      // Pre-EE1, seeded stances pushed into blockingParts which was
      // appended unconditionally before the contextual budget loop —
      // 8 long seeds could occupy ~1200 chars uncapped. With this test
      // we seed enough long-prose stances to overflow the policy cap
      // (POLICY_BUDGET_CHARS=600) and assert: the 📦 dropped-context
      // line fires AND mentions the source='user-seeded' recall path
      // so the agent knows how to retrieve what was elided.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // 8 seeded stances with long prose (~140 chars per line × 8 ≈
      // 1120 chars). Cap of 600 → at least 3 entries get dropped.
      for (let i = 0; i < 8; i++) {
        ledger.recordInstance(
          `EE1 distinctly long seeded concept number ${i} ` +
            `with sufficient distinctive prose to cross the cap aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd`,
          { project: "manual", sessionId: "seed", verdict: "rejected", description: "long" },
        );
      }
      const { text } = await callTool("present_findings", {
        summary: "EE1 cap probe",
        findings: [{ category: "y", detail: "EE1 cap probe detail", significance: "low" }],
      });
      // Header + at least one seed line survived (policy tier had room).
      expect(text).toContain("🌱 The user explicitly seeded these stances");
      // Seeds are sorted by lastSeenAt desc; latest insertions land first.
      // At least one [SEED] line is in the output.
      expect(text).toMatch(/\[SEED\] \[AVOID\] "EE1 distinctly long seeded concept number \d+/);
      // The 📦 omission line fires AND points at the seeded-source filter.
      expect(text).toContain("📦");
      expect(text).toContain("source='user-seeded'");
    });

    it("EE6 — fresh-with-seeds project (concepts < 5) gets the recall pointer in the SEED block", async () => {
      // Pre-EE6 the recall pointer was gated on R2's >=5 concept rule —
      // a fresh project with 3 seeds learned about [SEED] but never
      // about how to pull the full digest. Now the SEED block carries
      // its own pointer when R2 won't fire.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      ledger.recordInstance("EE6 only seed 1", { project: "manual", sessionId: "seed", verdict: "rejected", description: "x" });
      ledger.recordInstance("EE6 only seed 2", { project: "manual", sessionId: "seed", verdict: "rejected", description: "x" });
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      // SEED block fires.
      expect(text).toContain("EE6 only seed 1");
      // Nudge appears in the SEED block.
      expect(text).toContain("Call recall mode='ledger' for the full digest");
      expect(text).toContain("source='user-seeded'");
      // R2 welcome line (gated on >=5) does NOT fire — verify ledger
      // is below threshold.
      expect(text).not.toContain("Your deepPairing ledger:");
    });

    it("DD3 — R2 welcome-back line points the agent at recall mode='ledger'", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // 5 concepts so the R2 line activates.
      for (let i = 0; i < 5; i++) {
        ledger.recordInstance(`DD3 R2 concept ${i}`, {
          project: "project-a",
          sessionId: "s1",
          verdict: "rejected",
        });
      }
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).toContain("Call recall with mode='ledger'");
    });

    it("surfaces the compounding summary once ≥5 concepts exist across projects", async () => {
      // Seed the global ledger with 5 concepts spanning 2 projects, mix of
      // avoid + prefer — then fire the first tool call.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      ledger.recordInstance("global mutable state", {
        project: "project-a", sessionId: "s1", verdict: "rejected", reason: "broke testability",
      });
      ledger.recordInstance("god object", {
        project: "project-a", sessionId: "s1", verdict: "rejected",
      });
      ledger.recordInstance("primitive obsession", {
        project: "project-b", sessionId: "s2", verdict: "rejected",
      });
      ledger.recordInstance("repository pattern", {
        project: "project-a", sessionId: "s1", verdict: "approved",
      });
      ledger.recordInstance("service layer", {
        project: "project-b", sessionId: "s2", verdict: "approved",
      });

      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).toContain("🌱 Your deepPairing ledger");
      expect(text).toContain("5 concepts");
      expect(text).toContain("3 avoid / 2 prefer");
      expect(text).toContain("2 projects");
    });
  });

  describe("session memory on first tool call", () => {
    it("includes rejected approaches with reasons in the first tool call response", async () => {
      store.recordRejectedApproach({ description: "Deploy to Railway", reason: "too expensive for our scale" });
      store.recordApprovedPattern({ description: "Service pattern" });

      const { text } = await callTool("log_reasoning", {
        action: "first call",
        reasoning: "test",
        confidence: "low",
      });

      expect(text).toContain("From previous sessions");
      expect(text).toContain("Deploy to Railway");
      expect(text).toContain("too expensive for our scale");
      expect(text).toContain("Service pattern");
    });

    it("does NOT repeat session memory on subsequent tool calls", async () => {
      store.recordRejectedApproach({ description: "Inline refactor" });

      await callTool("log_reasoning", {
        action: "first", reasoning: "x", confidence: "low",
      });
      const { text } = await callTool("log_reasoning", {
        action: "second", reasoning: "y", confidence: "low",
      });

      expect(text).not.toContain("From previous sessions");
      expect(text).not.toContain("Inline refactor");
    });

    it("resets poll counter when feedback arrives", async () => {
      // Poll 3 times with no feedback (no drafts = no long-poll)
      await callTool("check_feedback");
      await callTool("check_feedback");
      await callTool("check_feedback");

      // Now add human feedback — counter should reset
      store.addComment({ id: "cmt_1", artifactId: "__session__", content: "hello", author: "human" });
      const { text } = await callTool("check_feedback");

      expect(text).toContain("Human directive");
      expect(text).not.toContain("No human response"); // Counter was reset
    });

    it("increments poll counter on empty polls", async () => {
      // Poll 4 times with no feedback, no drafts = instant return
      await callTool("check_feedback");
      await callTool("check_feedback");
      await callTool("check_feedback");
      // 4th poll — counter is now 4
      const { text } = await callTool("check_feedback");
      // No pending items, so escalation hint won't appear,
      // but counter is tracked correctly (tested via reset above)
      expect(text).toContain("Session:");
    });
  });

  describe("firstCallHint surfaces decision-revision-requested + plain artifact comments", () => {
    // Field bug: a human comment on a decision artifact reached the agent
    // via check_feedback, but the agent's protocol gave no clear
    // instruction for non-question comments → reply went into chat only,
    // never landed in the conversation rail. Two complementary surfacing
    // additions in firstCallHint:
    //   1. Comments tagged sectionId="decision_revision_requested" get
    //      promoted to a HIGH-PRIORITY "🔁 REVISION REQUEST" section that
    //      tells the agent to call revise_artifact, NOT answer_question.
    //   2. Plain (non-question, non-answered) comments on artifacts
    //      surface a "💬 N comments without an agent reply" line so the
    //      agent knows to mirror substantive replies via answer_question.

    // The firstCallHint only fires on the FIRST tool call per server
    // instance. To exercise it, we seed the store directly (no callTool)
    // and then make the FIRST tool call to see the hint.

    it("surfaces decision_revision_requested as a HIGH-PRIORITY revise_artifact action", async () => {
      // Seed a decision artifact directly (no first-call burnt).
      const decisionArtifact = store.createArtifact({
        id: "art_dec_seed",
        type: "decision",
        title: "Pick a matcher",
        content: { context: "Pick a matcher", options: [], decisionId: "dec_seed" },
      });
      store.addComment({
        id: "cmt_revision",
        artifactId: decisionArtifact.id,
        content: "all 4 options are matchers — what about a hybrid?",
        author: "human",
        intent: "question",
        target: { sectionId: "decision_revision_requested" } as any,
      });

      // FIRST tool call — carries the firstCallHint.
      const { text } = await callTool("present_findings", {
        summary: "trigger first-call hint",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      expect(text).toMatch(/REVISION REQUEST/);
      expect(text).toMatch(/revise_artifact/);
      expect(text).toMatch(/supersede/);
      expect(text).toContain(decisionArtifact.id);
      expect(text).toContain("cmt_revision");
      expect(text).toMatch(/all 4 options are matchers/);
      expect(text).toMatch(/Do NOT just call answer_question/);
    });

    it("does not double-count revision-requests in the plain unanswered-questions section", async () => {
      const decision = store.createArtifact({
        id: "art_dec_only",
        type: "decision",
        title: "x",
        content: { context: "x", options: [], decisionId: "dec_only" },
      });
      store.addComment({
        id: "cmt_rev_only",
        artifactId: decision.id,
        content: "redo the options",
        author: "human",
        intent: "question",
        target: { sectionId: "decision_revision_requested" } as any,
      });

      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      // With ONLY a revision-request comment (no plain question), the
      // unanswered-questions counter must not appear.
      const lines = text.split("\n");
      const unansweredLine = lines.find((l) => /❓ \d+ unanswered question/.test(l));
      expect(unansweredLine).toBeUndefined();
      expect(text).toMatch(/🔁/);
    });

    it("surfaces plain (non-question) human comments as 'mirror via answer_question'", async () => {
      const findings = store.createArtifact({
        id: "art_research_seed",
        type: "research",
        title: "x",
        content: { summary: "x", findings: [] },
      });
      store.addComment({
        id: "cmt_plain_thought",
        artifactId: findings.id,
        content: "interesting trade-off here",
        author: "human",
        // intent omitted on purpose → plain comment
      });

      const { text } = await callTool("present_findings", {
        summary: "y",
        findings: [{ category: "y", detail: "y", significance: "low" }],
      });

      expect(text).toMatch(/💬 1 human comment.*without an agent reply/);
      expect(text).toMatch(/Mirror substantive replies via answer_question/);
    });

    it("surfaces follow-up replies in active threads (parentCommentId points at agent comment) as ↳ continue-the-thread", async () => {
      // The user replied to the agent's previous answer_question reply
      // via the new Reply button. firstCallHint must surface this as a
      // distinct "continuing thread" signal so the agent calls
      // answer_question AGAIN, not addComment top-level.
      const findings = store.createArtifact({
        id: "art_thread_seed",
        type: "research",
        title: "x",
        content: { summary: "x", findings: [] },
      });
      // Original question.
      store.addComment({
        id: "h_q1",
        artifactId: findings.id,
        content: "why?",
        author: "human",
        intent: "question",
      });
      // Agent's prior reply (answer_question result).
      store.addComment({
        id: "agent_a1",
        artifactId: findings.id,
        content: "because Y",
        author: "agent",
        parentCommentId: "h_q1",
      });
      // Mark the original question as answered so it doesn't show in the
      // unanswered-questions section (which would conflict with the
      // follow-up surfacing).
      store.markCommentAnswered("h_q1", "agent_a1");
      // Human's follow-up reply — parentCommentId points at agent_a1.
      store.addComment({
        id: "h_followup",
        artifactId: findings.id,
        content: "but Y doesn't apply because Z",
        author: "human",
        parentCommentId: "agent_a1",
      });

      const { text } = await callTool("present_findings", {
        summary: "trigger first-call",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      expect(text).toMatch(/↳/);
      expect(text).toMatch(/follow-up repl/);
      expect(text).toContain("h_followup");
      expect(text).toContain("agent_a1");
      expect(text).toContain("but Y doesn't apply because Z");
      expect(text).toMatch(/answer_question.*AGAIN/);
      expect(text).toMatch(/Do NOT post a new top-level comment/);
    });

    it("does not double-count follow-up replies in the plain-comments mirror line", async () => {
      // A follow-up reply has author=human and intent=undefined (i.e.
      // matches the plain-comment filter too). It must appear in the
      // ↳ follow-up section only, not also in the 💬 mirror section.
      const findings = store.createArtifact({
        id: "art_no_dup",
        type: "research",
        title: "x",
        content: { summary: "x", findings: [] },
      });
      store.addComment({ id: "agent_a", artifactId: findings.id, content: "A", author: "agent" });
      store.addComment({
        id: "h_followup_only",
        artifactId: findings.id,
        content: "follow-up",
        author: "human",
        parentCommentId: "agent_a",
      });

      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      // Follow-up section IS present.
      expect(text).toMatch(/↳ 1 follow-up reply/);
      // Plain-comments-needing-mirror line is NOT — that comment is
      // already accounted for as a follow-up.
      expect(text).not.toMatch(/💬 \d+ human comment.*without an agent reply/);
    });

    it("does NOT surface session-level chat (artifactId='__session__') as needing a mirror", async () => {
      store.addComment({
        id: "cmt_session_chat",
        artifactId: "__session__",
        content: "hey just thinking out loud",
        author: "human",
      });
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toMatch(/💬 \d+ human comment.*without an agent reply/);
    });

    // #220 M1.6 — a bare approval ack ("ship it") on an APPROVED artifact does
    // NOT owe a reply; a substantive follow-up on the same approved artifact
    // still does (via the ↳ lane). The dogfood flagged two acks as owing.
    it("M1.6 — a bare ack on an APPROVED artifact is NOT flagged as owing a reply", async () => {
      const cs = store.createArtifact({
        id: "art_cs_approved",
        type: "changeset",
        title: "tags feature",
        content: { summary: "x", files: [] },
      });
      store.updateArtifactStatus(cs.id, "approved");
      // The dogfood's exact ack — top-level, non-question, verdictFeedback unset.
      store.addComment({
        id: "cmt_ship_it",
        artifactId: cs.id,
        content: "Yep, i+1 is exactly it. Ship it.",
        author: "human",
      });
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toMatch(/💬 \d+ human comment.*without an agent reply/);
    });

    it("M1.6 — a top-level comment on a STILL-OPEN (draft) artifact STILL owes a mirror", async () => {
      const research = store.createArtifact({
        id: "art_draft_open",
        type: "research",
        title: "x",
        content: { summary: "x", findings: [] },
      });
      // status left as draft (not approved).
      store.addComment({
        id: "cmt_open_thought",
        artifactId: research.id,
        content: "reconsider the naming here",
        author: "human",
      });
      const { text } = await callTool("present_findings", {
        summary: "y",
        findings: [{ category: "y", detail: "y", significance: "low" }],
      });
      expect(text).toMatch(/💬 1 human comment.*without an agent reply/);
    });

    it("M1.6 — a SUBSTANTIVE follow-up on an APPROVED artifact still owes (via the ↳ lane)", async () => {
      const cs = store.createArtifact({
        id: "art_cs_appr_followup",
        type: "changeset",
        title: "tags feature",
        content: { summary: "x", files: [] },
      });
      store.updateArtifactStatus(cs.id, "approved");
      store.addComment({ id: "agent_reply", artifactId: cs.id, content: "done", author: "agent" });
      // A follow-up reply to the agent's comment — parentCommentId → agent.
      store.addComment({
        id: "human_followup",
        artifactId: cs.id,
        content: "wait, does this also cover the delete path?",
        author: "human",
        parentCommentId: "agent_reply",
      });
      const { text } = await callTool("present_findings", {
        summary: "z",
        findings: [{ category: "z", detail: "z", significance: "low" }],
      });
      // The follow-up lane fires regardless of approval status.
      expect(text).toMatch(/↳ 1 follow-up reply/);
      expect(text).toContain("human_followup");
      // And it is NOT double-counted in the (now ack-gated) mirror line.
      expect(text).not.toMatch(/💬 \d+ human comment.*without an agent reply/);
    });
  });

  describe("firstCallHint budget + tier ordering (X3)", () => {
    // The hint accreted 10+ sections over many phases. Round-2 MCP review
    // flagged that priority-relevant signals (revision requests, unanswered
    // questions, follow-up replies) were getting buried under welcome
    // stats and ledger primers. X3 split the hint into two tiers:
    //   BLOCKING (always included, top of hint, never truncated)
    //   CONTEXTUAL (priority-ordered, dropped tail-first when over budget)
    // The total hint stays under HINT_BUDGET_CHARS (1500); when items
    // get dropped a "📦 N additional context sections omitted" pointer
    // tells the agent to call recall.

    it("blocking signals always appear at the top, before any contextual items", async () => {
      // Set up: a revision-request comment (BLOCKING) + a session memory
      // entry (CONTEXTUAL).
      const decision = store.createArtifact({
        id: "art_dec_x3",
        type: "decision",
        title: "x",
        content: { context: "x", options: [], decisionId: "dec_x3" },
      });
      store.addComment({
        id: "cmt_rev_x3",
        artifactId: decision.id,
        content: "redo these options",
        author: "human",
        intent: "question",
        target: { sectionId: "decision_revision_requested" } as any,
      });
      store.recordRejectedApproach({ description: "Use Railway", reason: "expensive" });

      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      // Both surface. The BLOCKING revision-request must appear BEFORE
      // the contextual rejected-approaches section.
      const revisionIdx = text.indexOf("REVISION REQUEST");
      const rejectedIdx = text.indexOf("Rejected approaches");
      expect(revisionIdx).toBeGreaterThanOrEqual(0);
      expect(rejectedIdx).toBeGreaterThanOrEqual(0);
      expect(revisionIdx).toBeLessThan(rejectedIdx);
    });

    it("blocking signals are not truncated even when contextual items would crowd", async () => {
      // Plant 50 rejected approaches to bloat the contextual tier far
      // past the budget. Then plant a revision-request that MUST still
      // appear in full.
      const decision = store.createArtifact({
        id: "art_dec_full",
        type: "decision",
        title: "x",
        content: { context: "x", options: [], decisionId: "dec_full" },
      });
      store.addComment({
        id: "cmt_rev_full",
        artifactId: decision.id,
        content: "the human's full revision context that must survive",
        author: "human",
        intent: "question",
        target: { sectionId: "decision_revision_requested" } as any,
      });
      for (let i = 0; i < 50; i++) {
        store.recordRejectedApproach({
          description: `Approach ${i} with a deliberately verbose description so the section bloats fast and pushes past the budget`,
          reason: `Long-form reason ${i} so each entry is fat enough that 50 of them blow well past 1500 chars`,
        });
      }

      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      // Blocking items are present in full (the revision content excerpt
      // and the canonical "REVISION REQUEST" header survive).
      expect(text).toMatch(/REVISION REQUEST/);
      expect(text).toContain("the human's full revision context that must survive");
      // The dropped-context pointer fires.
      expect(text).toMatch(/additional context section/);
      expect(text).toMatch(/call `recall`/i);
    });

    it("hint stays under the 1500-char budget when contextual items would otherwise overflow", async () => {
      for (let i = 0; i < 50; i++) {
        store.recordRejectedApproach({
          description: `Bulky rejected approach ${i} ${"x".repeat(80)}`,
          reason: `Bulky reason ${i} ${"y".repeat(80)}`,
        });
      }
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      // The hint is appended to the tool's response text, so the response
      // total includes the original tool message plus the hint.
      // We assert the hint portion (everything after the tool's own response)
      // doesn't blow past a generous overall ceiling. Cheaper proxy: the
      // dropped-context pointer should be present, indicating budget kicked in.
      expect(text).toMatch(/additional context section/);
    });

    it("when nothing is dropped, no '📦 N omitted' pointer appears", async () => {
      // Fresh store: no rejected approaches, no team prefs, no ledger
      // entries → contextual tier is mostly empty.
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toMatch(/additional context section/);
    });
  });

  describe("M1.5 — firstCallHint fires on the FIRST tool call (any tool)", () => {
    // Pre-M1 (Y2) the hint was gated to WRITE tools, so an agent whose opener is
    // the protocol-recommended `recall` never saw the companion-URL / protocol
    // block on call #1 (the dogfood friction). M1.5 fires it on the FIRST tool
    // call whichever tool it is — with ONE carve-out, `export_session`, whose
    // grab-and-paste markdown must stay clean. These tests pin both directions.

    it("present_findings (write) — first call carries the hint", async () => {
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).toMatch(/\[First use this session\]/);
    });

    it("first-call hint includes the pairing-protocol preamble (for bare-MCP consumers)", async () => {
      // #1 — projects wired with only the MCP server (no skill / no init) must
      // still receive the choreography on the first write tool's response.
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).toMatch(/\[deepPairing protocol\]/);
      expect(text).toMatch(/present_findings/);
      expect(text).toMatch(/check_feedback/);
      // #195 L2 — preamble prose-trim tightened "never as plain terminal text"
      // → "not plain terminal text" (same rule: route through tools as artifacts).
      expect(text).toMatch(/not plain terminal text/i);
    });

    it("recall (read) — first call NOW carries the hint (M1.5: the happy-path opener)", async () => {
      // The protocol preamble tells the agent to `recall` first; pre-M1 that
      // opener silently dropped the companion-URL / protocol block. Now it rides.
      const { text } = await callTool("recall", { query: "anything", mode: "any" });
      expect(text).toMatch(/\[First use this session\]/);
      expect(text).toMatch(/\[deepPairing protocol\]/);
    });

    it("export_session (read) — first call STILL does NOT carry the hint (grab-and-paste stays clean)", async () => {
      // export_session returns markdown the user pastes elsewhere; splicing an
      // onboarding block into it was the worst offender, so it stays the ONE
      // carve-out from M1.5's first-call delivery.
      const { text } = await callTool("export_session", { format: "full" });
      expect(text).not.toMatch(/\[First use this session\]/);
    });

    it("check_feedback (read) — first call NOW carries the hint (M1.5)", async () => {
      // A session that opens by polling should still learn the companion URL and
      // the protocol on call #1.
      const { text } = await callTool("check_feedback", {});
      expect(text).toMatch(/\[First use this session\]/);
    });

    // III1 — gate also requires !result.isError. Pre-III1 the push
    // fired on every tool reply with a content[] array, including the
    // ~17 isError:true validation/preflight-reject returns. A malformed
    // first write call got "INPUT_VALIDATION_FAILED: ..." followed by
    // a 4KB onboarding dump — exactly the parsing footgun II12 was
    // supposed to retire, just on the error branch.
    it("III1 — first-call validation error does NOT carry the hint (errors stay clean)", async () => {
      // present_findings with a malformed shape — findings array missing
      // required fields. validate-tool-input.ts returns isError:true.
      // The hint must NOT splatter on top of the error message.
      const { text, isError } = await callTool("present_findings", { summary: "x" } /* no findings → invalid */);
      expect(isError).toBe(true);
      expect(text).not.toMatch(/\[First use this session\]/);
      // And the agent still gets the validation error in content[0].
      expect(text).toMatch(/INPUT_VALIDATION_FAILED|required|missing/i);
    });

    it("#170 — first-call validation error carries a ONE-LINE protocol pointer (not the full dump)", async () => {
      // A protocol-blind agent whose opener fails validation should still get
      // oriented — but with a single line, not the 4KB onboarding hint III1
      // keeps off error responses.
      // #184 — findings present-but-wrong-type (a real schema mismatch, so the
      // example-bearing INPUT_VALIDATION_FAILED path — which the one-liner rides
      // by referencing "the example above"). `{ summary: "x" }` alone now routes
      // to the example-less TOOL_CALL_TRUNCATED lane, which deliberately carries
      // no example and therefore no "example above" one-liner.
      const { text, isError } = await callTool("present_findings", { summary: "x", findings: "nope" } /* wrong type → invalid */);
      expect(isError).toBe(true);
      // The one-liner rides the error.
      expect(text).toMatch(/New to deepPairing\? A valid minimal call/);
      expect(text).toMatch(/full pairing protocol arrives on your first successful call/);
      // The FULL hint still does not (errors stay clean).
      expect(text).not.toMatch(/\[First use this session\]/);
    });

    it("#170 — a failed first call keeps the latch armed: the first SUCCESSFUL call still gets the full hint", async () => {
      // Malformed opener — fails validation, must NOT burn the onboarding latch.
      const bad = await callTool("present_findings", { summary: "x" } /* invalid */);
      expect(bad.isError).toBe(true);
      // Now a valid call — it is the first *successful* write, so it carries
      // the full protocol the malformed opener would otherwise have lost.
      const { text } = await callTool("present_findings", {
        summary: "recovered",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).toMatch(/\[First use this session\]/);
      expect(text).toMatch(/\[deepPairing protocol\]/);
    });

    it("M1.5 — a leading recall carries the hint and BURNS the latch (fires exactly once)", async () => {
      // Pre-M1 the latch was consumed only on the first write, so a leading
      // recall kept it armed. M1.5 delivers on the FIRST tool call (recall here),
      // which burns the latch — so a subsequent present_findings does NOT repeat
      // the hint. The agent sees it exactly once, on call #1.
      const first = await callTool("recall", { query: "x", mode: "any" });
      expect(first.text).toMatch(/\[First use this session\]/);
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toMatch(/\[First use this session\]/);
    });

    it("M1.5 — export_session does NOT burn the latch: the first non-export call still gets the hint", async () => {
      // The one excluded tool must not consume the once-only latch, else a
      // session opening with an export would lose onboarding forever.
      const exp = await callTool("export_session", { format: "full" });
      expect(exp.text).not.toMatch(/\[First use this session\]/);
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).toMatch(/\[First use this session\]/);
    });
  });
});

/**
 * Q3 — the wiring end of the stale-nag fix. first-call-hint.test.ts pins the
 * predicate; this pins that the DISPATCH actually hands it the commentId, on the
 * one call shape that hits it: `answer_question` as the session's FIRST tool
 * call (the hint is built before the handler runs and attached after).
 */
describe("firstCallHint — Q3: answering the only open question doesn't nag about it", () => {
  it("answer_question as the first call reports no unanswered-question debt", async () => {
    store.createArtifact({ id: "art_q", type: "plan", title: "Rollout", content: { steps: [] } });
    store.addComment({
      id: "cmt_only_q",
      artifactId: "art_q",
      content: "why a sliding window?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_q" },
    });

    const { text } = await callTool("answer_question", {
      commentId: "cmt_only_q",
      answer: "so an active session never expires mid-request.",
    });
    expect(text).toContain("Answered cmt_only_q");
    // The whole reply (tool result + the appended hint block) must not tell the
    // agent to drain a queue it just drained.
    expect(text).not.toContain("unanswered human question");
    expect(text).not.toContain("Drain these before new work");
  });
});
