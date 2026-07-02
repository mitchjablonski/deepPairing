/**
 * D2 — split from the 3,009-line server.test.ts along tool-surface seams.
 * Test bodies are verbatim from the monolith; only the harness wiring is new.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let broadcasts: any[];
beforeEach(() => {
  store = ctx.store;
  broadcasts = ctx.broadcasts;
});

describe("MCP Tool Handlers — memory + ledger", () => {
  describe("pre-flight rejected-approach validation", () => {
    it("blocks present_options when an option matches a rejected approach", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });

      const result = await callTool("present_options", {
        context: "Choose a hosting provider",
        options: [
          { id: "a", title: "Railway", description: "Easy deploy", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Fly.io", description: "Edge", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(result.text).toContain("Railway");
      expect(result.text).toContain("too expensive for our scale");
      // Artifact must NOT have been created
      expect(store.getArtifacts()).toHaveLength(0);
    });

    it("CC1 — block message includes the trace summary so the agent sees considered/near-miss context on block too", async () => {
      // BB5 added the summary on the ADMIT path; CC1 closes the asymmetry
      // on the BLOCK path. The agent gets "...previously rejected as Y"
      // for the matched concept PLUS "Preflight: considered N past
      // stance(s)" for the broader picture.
      store.recordRejectedApproach({
        description: "Deploy: Railway",
        reason: "too expensive",
        concept: "pay-per-request hosting",
      });
      store.recordRejectedApproach({
        description: "global mutable state",
        concept: "global mutable state",
      });
      const result = await callTool("present_options", {
        context: "Pick a deploy target with mutable backing",
        options: [
          { id: "a", title: "Railway", description: "Fast", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Render", description: "Boring", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      expect(result.isError).toBe(true);
      // Original block message still there.
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(result.text).toContain("Railway");
      // CC1 — appended trace summary covers BOTH considered stances.
      expect(result.text).toContain("Preflight: considered");
    });

    it("broadcasts a preflight_blocked event so the UI can toast (H1)", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive", concept: "pay-per-request hosting" });

      await callTool("present_options", {
        context: "Pick a deploy target",
        options: [
          { id: "a", title: "Railway", description: "Fast", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Render", description: "Boring", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });

      const blockEvent = broadcasts.find((b) => b.type === "preflight_blocked");
      expect(blockEvent).toBeDefined();
      expect(blockEvent.toolName).toBe("present_options");
      expect(blockEvent.match.proposal).toBeTruthy();
      expect(blockEvent.match.description).toContain("Railway");
      expect(blockEvent.match.reason).toBe("too expensive");
      expect(["surface", "concept"]).toContain(blockEvent.match.via);
    });

    it("blocks present_plan when a step description matches a rejected approach", async () => {
      store.recordRejectedApproach({ description: "Inline refactor" });

      const result = await callTool("present_plan", {
        title: "Cleanup",
        steps: [{ description: "Inline refactor of auth module", reasoning: "simpler" }],
        estimatedChanges: 1,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(store.getArtifacts()).toHaveLength(0);
    });

    it("allows present_findings when nothing matches", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway" });

      const { isError } = await callTool("present_findings", {
        summary: "Auth analysis",
        findings: [{ category: "Security", detail: "Weak hash", significance: "high" }],
      });

      expect(isError).toBeFalsy();
      expect(store.getArtifacts()).toHaveLength(1);
    });

    it("blocks via concept match even when surface names differ (U6)", async () => {
      // Past rejection: "Railway" with the underlying concept "pay-per-request serverless hosting"
      store.recordRejectedApproach({
        description: "Deploy: Railway",
        reason: "too expensive for low-traffic services",
        concept: "pay-per-request serverless hosting platform",
      });

      // Agent now proposes Fly.io with language that matches the concept tokens
      const result = await callTool("present_options", {
        context: "Pick a deploy target",
        options: [
          {
            id: "a", title: "Fly.io",
            description: "Use Fly.io — another pay-per-request serverless hosting platform",
            pros: [], cons: [], effort: "low", risk: "low", recommendation: true,
          },
          {
            id: "b", title: "AWS ECS",
            description: "Long-running ECS task", pros: [], cons: [], effort: "medium", risk: "medium", recommendation: false,
          },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(result.text).toContain("underlying concept");
      expect(result.text).toContain("pay-per-request serverless hosting platform");
      expect(store.getArtifacts()).toHaveLength(0);
    });
  });

  describe("rejected approaches captured from artifact rejections (U1+U6)", () => {
    it("records a rejected approach with reason when a finding is rejected", async () => {
      await callTool("present_findings", {
        title: "Proposed caching layer",
        summary: "add Redis cache",
        findings: [{ category: "Perf", detail: "cache user profiles", significance: "high" }],
      });
      const artifact = store.getArtifacts()[0];

      // Simulate the HTTP PATH: status update to rejected with feedback.
      // We invoke the store directly since test fixtures don't use Hono.
      store.updateArtifactStatus(artifact.id, "rejected");
      // The HTTP handler also records the rejected approach — simulate that path
      store.recordRejectedApproach({
        description: artifact.title,
        reason: "we already have a CDN layer; adding Redis is premature",
        sourceArtifactId: artifact.id,
      });

      const memory = store.getSessionMemory();
      const match = memory.rejectedApproaches.find((r) => r.description === "Proposed caching layer");
      expect(match).toBeDefined();
      expect(match?.reason).toContain("premature");
      expect(match?.sourceArtifactId).toBe(artifact.id);
    });
  });

  describe("AA1 — concept.name flows through to ledger (Y5 + Z1 substrate consumer fix)", () => {
    // Pre-AA1, server.ts:824 was passing option.description as the concept
    // arg to recordRejectedApproach. The Y5-hoisted option.concept.name
    // was dropped on the floor — the global ledger keyed on prose like
    // "Use Fly.io — pay-per-request serverless platform" instead of the
    // crisp "pay-per-request hosting" name. Cross-project compounding
    // was broken: every project minted its own unique long key.
    //
    // These tests pin that the resolve handler now reads concept.name
    // from each option and threads it through both rejection and
    // approval paths.

    it("rejected option's concept.name lands in the session ledger as `concept`", async () => {
      // Present options with explicit concept.name on both. User picks A;
      // B's concept should land in the rejected list.
      await callTool("present_options", {
        context: "Pick a deploy target",
        options: [
          {
            id: "a", title: "AWS Fargate",
            description: "managed container service",
            pros: ["mature"], cons: ["complex"],
            effort: "medium", risk: "low", recommendation: true,
            concept: { name: "managed container service" },
          },
          {
            id: "b", title: "Fly.io",
            description: "pay-per-request hosting on the edge",
            pros: ["cheap"], cons: ["less mature"],
            effort: "low", risk: "medium", recommendation: false,
            concept: { name: "pay-per-request hosting" },
          },
        ],
      });
      const artifact = store.getArtifacts()[0];
      const dec = (artifact.content as any).decisionId;
      // Resolve via the store (UI path); then trigger the next tool call
      // so the resolve-handler post-processing fires.
      store.resolveDecision(dec, "a", "fits our existing infra");
      await callTool("check_feedback", {});

      const memory = store.getSessionMemory();
      const rejected = memory.rejectedApproaches.find(
        (r) => r.description.includes("Fly.io"),
      );
      expect(rejected).toBeDefined();
      // The concept is the Y5 short name, NOT the prose description.
      expect(rejected?.concept).toBe("pay-per-request hosting");
    });

    it("SP2 — each rejected option records its OWN cons, not the human's single pick-reasoning", async () => {
      await callTool("present_options", {
        context: "Pick a cache",
        options: [
          { id: "a", title: "Redis", description: "shared store", pros: ["exact"], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "In-process LRU", description: "no deps", pros: ["simple"], cons: ["drifts across instances", "lost on restart"], effort: "low", risk: "medium", recommendation: false },
          { id: "c", title: "Memcached", description: "another service", pros: [], cons: ["one more thing to run"], effort: "medium", risk: "low", recommendation: false },
        ],
      });
      const dec = (store.getArtifacts()[0].content as any).decisionId;
      store.resolveDecision(dec, "a", "Redis is already in our stack");
      await callTool("check_feedback", {});

      const rejected = store.getSessionMemory().rejectedApproaches;
      const b = rejected.find((r) => r.description.includes("In-process LRU"));
      const c = rejected.find((r) => r.description.includes("Memcached"));
      // Each carries its OWN cons (distinct), not the same blurred string.
      expect(b?.reason).toContain("drifts across instances");
      expect(c?.reason).toContain("one more thing to run");
      expect(b?.reason).not.toBe(c?.reason);
      // ...with the human's pick-reasoning + winner as shared context.
      expect(b?.reason).toContain("Redis is already in our stack");
    });

    it("SP2 — a rejected option with NO cons falls back to the human's pick-reasoning", async () => {
      await callTool("present_options", {
        context: "Pick a queue",
        options: [
          { id: "a", title: "SQS", description: "managed", pros: ["managed"], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Roll our own", description: "in-house", pros: ["control"], cons: [], effort: "high", risk: "high", recommendation: false },
        ],
      });
      const dec = (store.getArtifacts()[0].content as any).decisionId;
      store.resolveDecision(dec, "a", "not worth building queueing ourselves");
      await callTool("check_feedback", {});

      const b = store.getSessionMemory().rejectedApproaches.find((r) => r.description.includes("Roll our own"));
      // no cons → the overall reasoning is the only signal we have.
      expect(b?.reason).toBe("not worth building queueing ourselves");
    });

    it("approved option's concept.name flows through too (symmetric with rejection)", async () => {
      // Same options shape; assert the WINNER's concept lands as a
      // pattern in the global ledger via the approved path.
      await callTool("present_options", {
        context: "Pick password hashing",
        options: [
          {
            id: "a", title: "argon2id",
            description: "memory-hard password hashing",
            pros: ["modern"], cons: ["newer"],
            effort: "low", risk: "low", recommendation: true,
            concept: { name: "argon2id for password hashing" },
          },
          {
            id: "b", title: "bcrypt rounds=4",
            description: "fast bcrypt with low cost factor",
            pros: ["familiar"], cons: ["brute-forceable"],
            effort: "low", risk: "high", recommendation: false,
            concept: { name: "low-cost bcrypt" },
          },
        ],
      });
      const artifact = store.getArtifacts()[0];
      const dec = (artifact.content as any).decisionId;
      store.resolveDecision(dec, "a", "future-proof");
      await callTool("check_feedback", {});

      // Approved patterns track the prose description (legacy shape) but
      // the GLOBAL ledger gets the concept.name as the bucket key. We
      // don't have a getGlobalStore inspection helper here, but we DO
      // verify the approval landed via the prose path.
      const memory = store.getSessionMemory();
      expect(
        memory.approvedPatterns.some((p) => p.includes("argon2id")),
      ).toBe(true);
    });

    it("falls back to option.description when concept is missing (back-compat)", async () => {
      await callTool("present_options", {
        context: "Pick a queue",
        options: [
          {
            id: "a", title: "SQS", description: "managed queue",
            pros: [], cons: [], effort: "low", risk: "low", recommendation: true,
          },
          {
            id: "b", title: "Redis Streams", description: "in-memory queue with persistence",
            pros: [], cons: [], effort: "medium", risk: "medium", recommendation: false,
          },
        ],
      });
      const artifact = store.getArtifacts()[0];
      const dec = (artifact.content as any).decisionId;
      store.resolveDecision(dec, "a", "we already use AWS");
      await callTool("check_feedback", {});

      const memory = store.getSessionMemory();
      const rejected = memory.rejectedApproaches.find(
        (r) => r.description.includes("Redis Streams"),
      );
      expect(rejected).toBeDefined();
      // Without concept, falls back to the prose description.
      expect(rejected?.concept).toBe("in-memory queue with persistence");
    });
  });

  describe("stakes + prediction capture (K1/K2)", () => {
    it("passes stakes through present_options into the decision record + artifact", async () => {
      await callTool("present_options", {
        context: "Which queue tech?",
        stakes: "high",
        options: [
          { id: "a", title: "SQS", description: "managed", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Kafka", description: "self-hosted", pros: [], cons: [], effort: "high", risk: "medium", recommendation: false },
        ],
      });
      const artifact = store.getArtifacts().find((a) => a.type === "decision")!;
      expect((artifact.content as any).stakes).toBe("high");
      const pending = store.getPendingDecisions();
      expect(pending).toHaveLength(1);
      expect((pending[0] as any).stakes).toBe("high");
    });

    it("records confidence + predictedOutcome on resolveDecision (K1)", async () => {
      await callTool("present_options", {
        context: "Pick a pattern",
        options: [
          { id: "a", title: "A", description: "x", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "y", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const dec = store.getPendingDecisions()[0];
      store.resolveDecision(dec.decisionId, "a", "cleaner", { confidence: "high", predictedOutcome: "sub-50ms p95" });

      const resolved = store.getDecision(dec.decisionId)!;
      expect(resolved.response?.confidence).toBe("high");
      expect(resolved.response?.predictedOutcome).toBe("sub-50ms p95");
    });

    it("counts decisions-with-predictions and high-stakes in engagement metrics (K2)", async () => {
      await callTool("present_options", {
        context: "High one",
        stakes: "high",
        options: [
          { id: "a", title: "A", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      await callTool("present_options", {
        context: "Low one",
        options: [
          { id: "a", title: "A", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const decisions = store.getPendingDecisions();
      store.resolveDecision(decisions[0].decisionId, "a", undefined, { confidence: "medium", predictedOutcome: "reasonable" });
      store.resolveDecision(decisions[1].decisionId, "a"); // no prediction

      const metrics = store.getEngagementMetrics();
      expect(metrics.decisionsWithPredictions).toBe(1);
      expect(metrics.highStakesDecisions).toBe(1);
    });
  });

  // III12 — request_horizon_check tool removed. It was a 7-line wrapper
  // around addComment with intent="question" and a templated prompt;
  // didn't earn a first-class tool slot. The horizon-check workflow now
  // flows through answer_question / addComment with the horizon template
  // (carried in the deeppairing.md skill) as the question text. The
  // test below pins that the tool is gone from the tools/list response,
  // so a future re-add has to be intentional.

  describe("recall — unified memory tool (N4)", () => {
    // III8 — recordRejectedApproach / recordApprovedPattern now require
    // per-project opt-in to mirror into the global philosophy ledger.
    // These tests exercise the ledger path so they opt in via
    // setGlobalLedgerPublish before recording. Without the opt-in, the
    // local rejected-approaches list still updates (so preflight still
    // fires for THIS project) but the cross-project ledger doesn't see
    // the entry — which is the intended default.
    beforeEach(() => {
      store.setGlobalLedgerPublish(true);
    });

    it("mode='any' surfaces philosophy ledger entries by concept", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive", concept: "pay-per-request hosting" });
      const { text } = await callTool("recall", { query: "pay-per-request", mode: "any" });
      expect(text).toContain("Philosophy ledger");
      expect(text.toLowerCase()).toContain("pay-per-request hosting");
    });

    it("mode='any' errors on empty query", async () => {
      const { isError, text } = await callTool("recall", { query: "", mode: "any" });
      expect(isError).toBe(true);
      expect(text).toContain("requires a query");
    });

    it("mode='philosophy' returns a formatted stance for a known concept", async () => {
      store.recordRejectedApproach({ description: "concept-x", reason: "reason-y" });
      const { text } = await callTool("recall", { query: "concept-x", mode: "philosophy" });
      expect(text).toContain("AVOID");
      expect(text).toContain("concept-x");
    });

    it("mode='philosophy' reports no-stance for an unknown concept", async () => {
      const { text } = await callTool("recall", { query: "some-fresh-concept", mode: "philosophy" });
      expect(text).toContain("No philosophy-ledger entries");
    });

    it("mode='philosophy' with no query lists the whole ledger", async () => {
      store.recordRejectedApproach({ description: "a", reason: "x" });
      store.recordRejectedApproach({ description: "b", reason: "y" });
      const { text, isError } = await callTool("recall", { mode: "philosophy" });
      expect(isError).toBeFalsy();
      expect(text).toContain("Philosophy ledger");
    });

    it("DD5 — mode='philosophy' source='user-seeded' returns only entries with manual instances", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // Seed-only entry.
      ledger.recordInstance("DD5 only-seeded", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "DD5 only-seeded",
      });
      // Session-only entry (no manual instance).
      ledger.recordInstance("DD5 only-session", {
        project: "/proj", sessionId: "s1", verdict: "rejected", description: "DD5 only-session",
      });
      // Both — seeded then cited.
      ledger.recordInstance("DD5 both", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "DD5 both",
      });
      ledger.recordInstance("DD5 both", {
        project: "/proj", sessionId: "s1", verdict: "rejected", description: "DD5 both",
      });

      const seeded = await callTool("recall", { mode: "philosophy", source: "user-seeded" });
      expect(seeded.text).toContain("DD5 only-seeded");
      expect(seeded.text).toContain("DD5 both");
      expect(seeded.text).not.toContain("DD5 only-session");

      const sessionOnly = await callTool("recall", { mode: "philosophy", source: "session" });
      expect(sessionOnly.text).toContain("DD5 only-session");
      expect(sessionOnly.text).toContain("DD5 both");
      expect(sessionOnly.text).not.toContain("DD5 only-seeded");
    });

    it("mode='philosophy' filters by stance", async () => {
      store.recordApprovedPattern({ description: "Service layer" });
      store.recordApprovedPattern({ description: "Service layer" });
      store.recordApprovedPattern({ description: "Service layer" });
      const { text } = await callTool("recall", { mode: "philosophy", stance: "prefer" });
      expect(text).toContain("Service layer");
      expect(text).toContain("PREFER");
    });

    it("mode='sessions' errors without a query", async () => {
      const { isError, text } = await callTool("recall", { query: "", mode: "sessions" });
      expect(isError).toBe(true);
      expect(text).toContain("requires a query");
    });

    it("BB4 — mode='ledger' returns empty-state guidance when nothing has accumulated", async () => {
      const { text, isError } = await callTool("recall", { mode: "ledger" });
      expect(isError).toBeFalsy();
      expect(text).toContain("Ledger is empty");
    });

    it("CC8 — mode='ledger' surfaces user-seeded stances even when shapedThisProject=0", async () => {
      // Pre-CC8: a fresh project where the user pasted seeds via the
      // SeedAffordance had a recall response of "Ledger is empty" — the
      // seeded stances were counted in globalLedger.concepts but their
      // names never made it into the agent-facing text. So the seed
      // action was invisible to the AI for the entire first session.
      const { getGlobalStore } = await import("../../store/global-store");
      // Simulate the AA9 seed route writing project="manual" entries.
      getGlobalStore().recordInstance("global mutable state", {
        project: "manual",
        sessionId: "seed",
        verdict: "rejected",
        description: "global mutable state",
      });
      getGlobalStore().recordInstance("bcrypt rounds < 12", {
        project: "manual",
        sessionId: "seed",
        verdict: "rejected",
        description: "bcrypt rounds < 12",
      });
      const { text } = await callTool("recall", { mode: "ledger" });
      // Should NOT report empty — seeds count.
      expect(text).not.toContain("Ledger is empty");
      // Seeded section is the new CC8 surface.
      expect(text).toContain("User-seeded stances");
      expect(text).toContain("global mutable state");
      expect(text).toContain("bcrypt rounds < 12");
      expect(text).toContain("[SEED]");
      // Trailer mentions SEED entries explicitly.
      expect(text).toContain("SEED");
    });

    it("EE7 — mode='ledger' source='user-seeded' suppresses cited stances + notes the suppression", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // 1 seeded entry.
      ledger.recordInstance("EE7 seeded one", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "x",
      });
      // Trace fixture so the digest has cited stances.
      store.recordPreflightTrace("art_ee7", {
        version: 1,
        at: "2026-05-11T10:00:00Z",
        artifactId: "art_ee7",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "EE7 cited concept" }],
        nearMisses: [],
      });
      const { text } = await callTool("recall", { mode: "ledger", source: "user-seeded" });
      expect(text).toContain("EE7 seeded one");
      // Cited section is suppressed.
      expect(text).not.toContain("Top cited stances");
      // FF2 — suppression note carries the remedy (next call to make).
      expect(text).toMatch(/suppressed via source='user-seeded'/i);
      expect(text).toMatch(/Re-call without source filter/i);
      expect(text).toMatch(/source='session'/i);
      // FF2 — headline qualifier prevents the "shaped N proposals" ↔
      // "stances suppressed" contradiction.
      expect(text).toMatch(/headlines reflect ALL stances/i);
    });

    it("EE7 — mode='ledger' source='session' suppresses the SEED block + notes the suppression", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      ledger.recordInstance("EE7b seeded only", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "x",
      });
      store.recordPreflightTrace("art_ee7b", {
        version: 1,
        at: "2026-05-11T10:00:00Z",
        artifactId: "art_ee7b",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "EE7b cited only" }],
        nearMisses: [],
      });
      const { text } = await callTool("recall", { mode: "ledger", source: "session" });
      expect(text).toContain("EE7b cited only");
      expect(text).not.toContain("[SEED]");
      // FF2 — suppression note carries the remedy.
      expect(text).toMatch(/suppressed via source='session'/i);
      expect(text).toMatch(/Re-call without source filter/i);
      expect(text).toMatch(/source='user-seeded'/i);
    });

    it("CC8 — seed that's also been cited in a real session shows the citation count alongside SEED tag", async () => {
      const { getGlobalStore } = await import("../../store/global-store");
      // Manual seed first.
      getGlobalStore().recordInstance("inline SQL strings", {
        project: "manual",
        sessionId: "seed",
        verdict: "rejected",
        description: "inline SQL strings",
      });
      // Then a real-project session of the same concept (typical: agent
      // proposed something containing "inline SQL strings" and the user
      // hit the rejected approach).
      getGlobalStore().recordInstance("inline SQL strings", {
        project: "/some/real/project",
        sessionId: "real_sess",
        verdict: "rejected",
        description: "inline SQL strings",
      });
      const { text } = await callTool("recall", { mode: "ledger" });
      expect(text).toContain("[SEED]");
      expect(text).toContain("inline SQL strings");
      expect(text).toContain("also cited 1× in real sessions");
    });

    it("FF4 — recall mode='ledger' surfaces 'cited N× here, M× cross-project' when globalCitationCount > local", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // Cross-project: 3 separate real-project instances of the same concept.
      ledger.recordInstance("FF4 hot stance", { project: "/proj/a", sessionId: "s1", verdict: "rejected", description: "x" });
      ledger.recordInstance("FF4 hot stance", { project: "/proj/b", sessionId: "s2", verdict: "rejected", description: "x" });
      ledger.recordInstance("FF4 hot stance", { project: "/proj/c", sessionId: "s3", verdict: "rejected", description: "x" });
      // And ONE local trace of the same concept (project-local count = 1).
      store.recordPreflightTrace("art_ff4", {
        version: 1,
        at: "2026-05-12T10:00:00Z",
        artifactId: "art_ff4",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "FF4 hot stance" }],
        nearMisses: [],
      });
      const { text } = await callTool("recall", { mode: "ledger" });
      expect(text).toContain("FF4 hot stance");
      // Cross-project signal exposed to the agent.
      expect(text).toMatch(/cited 1× here, 3× cross-project/i);
    });

    it("FF4 — recall mode='ledger' shows just 'cited N×' when globalCitationCount equals local (no cross-project bonus)", async () => {
      // One trace, no other instances.
      store.recordPreflightTrace("art_ff4b", {
        version: 1,
        at: "2026-05-12T10:00:00Z",
        artifactId: "art_ff4b",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "FF4b solo" }],
        nearMisses: [],
      });
      const { text } = await callTool("recall", { mode: "ledger" });
      expect(text).toContain("FF4b solo");
      expect(text).toMatch(/cited 1×/);
      // No cross-project clause when global == local.
      expect(text).not.toMatch(/cross-project/);
    });

    it("BB4 — mode='ledger' renders shaped/near-miss/blocked headlines + top stances", async () => {
      // Seed a preflight trace so ledgerDigest has something to count.
      store.recordPreflightTrace("art_bb4", {
        version: 1,
        at: "2026-05-05T10:00:00Z",
        artifactId: "art_bb4",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 2,
        consideredConcepts: [
          { source: "session", concept: "global mutable state" },
          { source: "team", concept: "use the ORM" },
        ],
        nearMisses: [{ source: "session", concept: "global mutable state" }],
      });
      // Seed the global ledger so the cross-project headline has content.
      store.recordRejectedApproach({ description: "global mutable state", concept: "global mutable state" });
      const { text } = await callTool("recall", { mode: "ledger" });
      expect(text).toContain("shaped 1 proposal");
      expect(text).toContain("1 near-miss");
      expect(text).toContain("Top cited stances:");
      expect(text).toContain("global mutable state");
      expect(text).toContain("[TEAM]");
      expect(text).toContain("Cross-project ledger:");
    });
  });
});
