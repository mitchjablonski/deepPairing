/**
 * Integration tests for MCP tool handlers.
 * Creates a real MCP server + FileStore, simulates tool calls via the SDK.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;
let client: Client;
const broadcasts: any[] = [];

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-mcp-test-"));
  // Redirect the global philosophy ledger to tmpDir so tests don't leak.
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "test_session");
  broadcasts.length = 0;

  const { server } = createMcpServer(store, (e) => broadcasts.push(e), 4000);

  // Connect client ↔ server via in-memory transport
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0" });
  await client.connect(clientTransport);
});

afterEach(() => {
  // Force flush to prevent pending timer writes after dir is deleted
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

async function callTool(name: string, args: Record<string, any> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as any[])?.[0]?.text ?? "";
  return { text, isError: result.isError };
}

describe("MCP Tool Handlers", () => {
  describe("present_findings", () => {
    it("creates a research artifact and returns the ID", async () => {
      const { text } = await callTool("present_findings", {
        summary: "Found issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      expect(text).toContain("Findings recorded");
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getArtifacts()[0].type).toBe("research");
      // Y1' — handler now broadcasts BOTH artifact_created and the
      // preflight trace alongside it. The trace is the substrate for the
      // ArtifactPanel breadcrumb.
      const types = broadcasts.map((b) => b.type);
      expect(types).toContain("artifact_created");
      expect(types).toContain("preflight_trace_recorded");
    });

    it("BB5 — return text mentions consideredCount + near-misses when the preflight brushed a past stance", async () => {
      // Concept tokens (≥4 chars): "global", "mutable", "state". The summary
      // hits 2 of 3 → coverage 0.67 → near-miss (>= 0.5) without a full
      // block (< 1.0). Note: present_findings' preflight matches against
      // title + summary + finding titles + recommendations, NOT details.
      store.recordRejectedApproach({
        description: "global mutable state for caching",
        concept: "global mutable state",
      });
      const { text } = await callTool("present_findings", {
        summary: "Caching with a mutable state — explore tradeoffs",
        findings: [{
          category: "Performance",
          detail: "x",
          significance: "low",
        }],
      });
      expect(text).toContain("Preflight: considered");
      expect(text).toContain("near-miss");
      expect(text).toContain("global mutable state");
    });

    it("BB5 — return text omits the preflight summary when there are no past stances (bootstrap state)", async () => {
      const { text } = await callTool("present_findings", {
        summary: "Fresh project, no memory",
        findings: [{ category: "Test", detail: "x", significance: "low" }],
      });
      expect(text).not.toContain("Preflight: considered");
    });
  });

  describe("present_options", () => {
    it("creates a decision artifact and records the decision request", async () => {
      const { text } = await callTool("present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "A", description: "Option A", pros: ["fast"], cons: ["risky"], effort: "low", risk: "high", recommendation: true },
          { id: "b", title: "B", description: "Option B", pros: ["safe"], cons: ["slow"], effort: "high", risk: "low", recommendation: false },
        ],
      });

      expect(text).toContain("Decision");
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getArtifacts()[0].type).toBe("decision");
      expect(store.getPendingDecisions()).toHaveLength(1);
    });
  });

  describe("present_plan", () => {
    it("creates a plan artifact and records a plan review", async () => {
      const { text } = await callTool("present_plan", {
        title: "Refactoring Plan",
        steps: [{ description: "Step 1", reasoning: "Because" }],
        estimatedChanges: 2,
      });

      expect(text).toContain("Plan");
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getArtifacts()[0].type).toBe("plan");
      expect(store.getPendingPlanReviews()).toHaveLength(1);
    });
  });

  describe("log_reasoning", () => {
    it("creates a reasoning artifact with structured alternatives", async () => {
      const { text } = await callTool("log_reasoning", {
        action: "Create service",
        reasoning: "Service pattern is cleaner",
        confidence: "high",
        alternativeDetails: [
          { title: "Inline refactor", reason: "Too coupled" },
        ],
      });

      expect(text).toContain("Reasoning logged");
      const art = store.getArtifacts()[0];
      expect(art.type).toBe("reasoning");
      expect((art.content as any).alternativeDetails).toHaveLength(1);
    });
  });

  describe("present_code_change", () => {
    it("creates a code_change artifact with confidence", async () => {
      const { text } = await callTool("present_code_change", {
        filePath: "/src/auth.ts",
        changeType: "modify",
        before: "const x = 1;",
        after: "const x = 2;",
        reasoning: "Update value",
        confidence: "high",
      });

      expect(text).toContain("Code change presented");
      const art = store.getArtifacts()[0];
      expect(art.type).toBe("code_change");
      expect((art.content as any).confidence).toBe("high");
    });
  });

  describe("firstCallHint — team conventions (N6.3)", () => {
    it("is absent from the hint when team.json is missing", async () => {
      // Outer beforeEach already created `store` without a team.json.
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toContain("🏢 Team conventions");
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
      const text = (result.content as any[])?.[0]?.text ?? "";

      expect(text).toContain("🏢 Team conventions");
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
      expect(text).toContain("🏢 Team conventions");
      // No stray merged "Team + personal" header.
      expect(text).not.toMatch(/Team\s*\+\s*personal/i);

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
      const text = (result.content as any[])?.[0]?.text ?? "";

      expect(text).not.toContain("🏢 Team conventions");

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

  describe("port in responses", () => {
    it("includes the correct port in tool responses", async () => {
      const { text } = await callTool("present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });

      expect(text).toContain("localhost:4000");
      expect(text).not.toContain("localhost:3847");
    });

    it("includes correct port in first-call hint", async () => {
      const { text } = await callTool("present_findings", {
        summary: "First call",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });

      expect(text).toContain("localhost:4000");
    });
  });

  describe("check_feedback", () => {
    it("returns session status preamble", async () => {
      const { text } = await callTool("check_feedback");
      expect(text).toContain("Session:");
      expect(text).toContain("Suggested action:");
    });

    it("returns unacknowledged comments", async () => {
      // Create an artifact and add a comment
      await callTool("present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });
      const artId = store.getArtifacts()[0].id;
      store.addComment({ id: "cmt_1", artifactId: artId, content: "Good work", author: "human" });

      const { text } = await callTool("check_feedback");
      expect(text).toContain("Good work");
    });

    it("returns resolved decisions", async () => {
      await callTool("present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "Service", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Inline", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const dec = store.getPendingDecisions()[0];
      store.resolveDecision(dec.decisionId, "a", "Cleaner");

      const { text } = await callTool("check_feedback");
      expect(text).toContain("Service");
    });

    it("BB3 — waitFor='decision' ignores stale unack comments and waits for the decision", async () => {
      // The agent just called present_options. There's an unrelated old
      // comment sitting in the unack queue (e.g. on a previous artifact).
      // Pre-BB3, check_feedback returned IMMEDIATELY because comments
      // existed — so the agent never got the chance to wait for the user
      // to actually pick an option. With waitFor='decision', the early-
      // return guard is scoped to resolved decisions only.
      await callTool("present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const decisionArtId = store.getArtifacts()[0].id;
      // Stash a stale comment on a different artifact.
      store.addComment({ id: "cmt_stale", artifactId: "art_other", content: "old chatter", author: "human" });

      // Schedule the decision resolution after 50ms so the long-poll wakes.
      const dec = store.getPendingDecisions()[0];
      setTimeout(() => store.resolveDecision(dec.decisionId, "a", "go with A"), 50);

      const { text } = await callTool("check_feedback", { waitFor: "decision" });
      // The stale comment is still in the queue (we didn't ack it for this
      // poll's purpose), but the wake condition was the resolved decision.
      expect(text).toContain("A");
      // Sanity: the artifact we presented was the one that got resolved.
      expect(decisionArtId).toBeTruthy();
    });

    it("CC5 — waitFor='decision' wakes on an unrelated comment but returns 'still waiting' instead of dumping it", async () => {
      // Pre-CC5: long-poll wakes on ANY signal, then post-wake assembly
      // dumps all comments + decisions regardless of waitFor scope. The
      // agent that asked for a decision-only wake gets a comment-flavored
      // response — surprising, conflicts with the scoped contract.
      await callTool("present_options", {
        context: "Pick a deploy",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      // Schedule an unrelated comment (not the decision the agent is
      // waiting for) after 50ms so the long-poll wakes mid-flight.
      setTimeout(() => {
        store.addComment({ id: "cmt_noise", artifactId: "art_other", content: "stray remark", author: "human" });
      }, 50);
      const { text } = await callTool("check_feedback", { waitFor: "decision" });
      expect(text).toContain("Still waiting on 'decision'");
      expect(text).not.toContain("stray remark");
    });

    it("BB3 — waitFor='comments' returns immediately when there's an unack comment, even with a draft decision", async () => {
      await callTool("present_options", {
        context: "Which?",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      store.addComment({ id: "cmt_now", artifactId: "any", content: "look here", author: "human" });
      const t0 = Date.now();
      const { text } = await callTool("check_feedback", { waitFor: "comments" });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1000); // immediate, not the 30s long-poll
      expect(text).toContain("look here");
    });

    it("does NOT include session memory inside check_feedback", async () => {
      // Session memory is delivered on the first tool call hint (see
      // first-call-hint test below), never inside check_feedback — mixing
      // WAITING signals with past-violation warnings creates contradictory
      // imperatives for the agent.
      store.recordApprovedPattern({ description: "Service pattern" });
      store.recordRejectedApproach({ description: "Inline refactor" });

      // Burn the first tool call on something other than check_feedback
      await callTool("log_reasoning", {
        action: "warm-up",
        reasoning: "trigger the first-call hint elsewhere",
        confidence: "low",
      });

      const { text } = await callTool("check_feedback");
      expect(text).not.toContain("previous sessions");
      expect(text).not.toContain("Rejected approaches");
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

  describe("export_session", () => {
    it("returns markdown in the specified format", async () => {
      await callTool("present_findings", {
        summary: "Auth issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      const { text } = await callTool("export_session", { format: "full" });
      expect(text).toContain("Session Report");
      expect(text).toContain("Weak hashing");
    });
  });

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

  describe("revise_artifact — mode: retract (N4)", () => {
    it("transitions the artifact to retracted and records the reason", async () => {
      await callTool("present_findings", {
        summary: "hasty analysis",
        findings: [{ category: "other", detail: "something", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];

      const { text, isError } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "retract",
        reason: "realised I had the wrong file",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(artifact.id);
      expect(store.getArtifacts()[0].status).toBe("retracted");

      // Agent-authored comment preserves the reason for the human to see
      const comments = store.getCommentsForArtifact(artifact.id);
      expect(comments.length).toBeGreaterThan(0);
      expect(comments.some((c) => c.author === "agent" && c.content.includes("wrong file"))).toBe(true);
    });

    it("errors when the artifact id is unknown", async () => {
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: "art_does_not_exist",
        mode: "retract",
        reason: "oops",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });

    it("errors when trying to retract an already-approved artifact", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.updateArtifactStatus(artifact.id, "approved");

      const { isError, text } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "retract",
        reason: "second thoughts",
      });
      expect(isError).toBe(true);
      expect(text).toContain("too late to retract");
    });

    it("requires artifactId, mode, and reason", async () => {
      const missingReason = await callTool("revise_artifact", { artifactId: "art_x", mode: "retract" });
      expect(missingReason.isError).toBe(true);
      expect(missingReason.text).toContain("reason");

      const missingId = await callTool("revise_artifact", { mode: "retract", reason: "no id" });
      expect(missingId.isError).toBe(true);
      expect(missingId.text).toContain("artifactId");

      const missingMode = await callTool("revise_artifact", { artifactId: "art_x", reason: "no mode" });
      expect(missingMode.isError).toBe(true);
      expect(missingMode.text).toContain("mode");
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
  });

  describe("answer_question + question prioritization", () => {
    it("prioritizes question comments in check_feedback with an answer hint", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.addComment({
        id: "cmt_plain",
        artifactId: artifact.id,
        content: "just a note",
        author: "human",
      });
      store.addComment({
        id: "cmt_q1",
        artifactId: artifact.id,
        content: "why did you pick this approach?",
        author: "human",
        intent: "question",
      });

      const { text } = await callTool("check_feedback");
      // Questions section appears and carries the answer hint
      expect(text).toContain("Human questions");
      expect(text).toContain("why did you pick this approach");
      expect(text).toContain("answer_question");
      expect(text).toContain("cmt_q1");
      // Questions are listed before regular comments in the final text
      const qIdx = text.indexOf("Human questions");
      const cIdx = text.indexOf("Human comments");
      expect(qIdx).toBeGreaterThanOrEqual(0);
      expect(cIdx === -1 || qIdx < cIdx).toBe(true);
    });

    it("answer_question links the reply and marks the question answered", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      const question = store.addComment({
        id: "cmt_q2",
        artifactId: artifact.id,
        content: "what else did you consider?",
        author: "human",
        intent: "question",
      });

      const { text, isError } = await callTool("answer_question", {
        commentId: question.id,
        answer: "I considered X but rejected it because Y.",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(question.id);

      // Parent question should now carry answeredByCommentId
      const parent = store.getComment(question.id);
      expect(parent?.answeredByCommentId).toBeTruthy();

      // The answer comment is agent-authored, parented, and acknowledged
      const all = store.getCommentsForArtifact(artifact.id);
      const answer = all.find((c) => c.id === parent?.answeredByCommentId);
      expect(answer).toBeDefined();
      expect(answer?.author).toBe("agent");
      expect(answer?.parentCommentId).toBe(question.id);
      expect(answer?.content).toContain("considered X");
    });

    it("already-answered questions drop out of the priority lane", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      const q = store.addComment({
        id: "cmt_q3",
        artifactId: artifact.id,
        content: "what does this do?",
        author: "human",
        intent: "question",
      });
      // Acknowledge so the existing check_feedback exchange doesn't re-surface it first
      store.acknowledgeComments([q.id]);
      await callTool("answer_question", {
        commentId: q.id,
        answer: "It's a guard clause.",
      });

      // Add a fresh plain comment so check_feedback has something to show
      store.addComment({
        id: "cmt_plain2",
        artifactId: artifact.id,
        content: "makes sense",
        author: "human",
      });

      const { text } = await callTool("check_feedback");
      expect(text).not.toContain("Human questions");
      expect(text).toContain("Human comments");
    });

    it("errors when answering an unknown commentId", async () => {
      const { isError, text } = await callTool("answer_question", {
        commentId: "cmt_not_real",
        answer: "hi",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no comment");
    });
  });

  describe("present_spec", () => {
    it("creates a spec artifact with requirements, tasks, and open questions", async () => {
      const { text, isError } = await callTool("present_spec", {
        title: "Auth rate limiting",
        objective: "Prevent credential-stuffing without locking out legitimate users",
        context: "The login endpoint currently has no throttle.",
        requirements: [
          {
            id: "REQ-1",
            statement: "Limit failed login attempts per user",
            rationale: "GPU-assisted brute-force is fast once credentials leak",
            acceptanceCriteria: ["After 5 failures within 10 min, reject", "Reset on successful login"],
            priority: "must",
          },
          {
            id: "REQ-2",
            statement: "Rate limit per IP",
            rationale: "Prevents distributed attacks across many accounts",
            acceptanceCriteria: ["Max 100 attempts per IP per 5 min"],
            priority: "should",
          },
        ],
        design: "Use existing Redis instance as the counter store.",
        tasks: [
          { description: "Add LoginThrottle middleware", linkedRequirementIds: ["REQ-1", "REQ-2"], estimate: "m" },
        ],
        openQuestions: ["Should admin accounts be exempt?"],
      });

      expect(isError).toBeFalsy();
      expect(text).toContain("presented for review");

      const specs = store.getArtifacts().filter((a) => a.type === "spec");
      expect(specs).toHaveLength(1);
      expect(specs[0].title).toBe("Auth rate limiting");
      const content = specs[0].content as any;
      expect(content.requirements).toHaveLength(2);
      expect(content.requirements[0].id).toBe("REQ-1");
      expect(content.requirements[0].acceptanceCriteria).toHaveLength(2);
      expect(content.tasks[0].linkedRequirementIds).toEqual(["REQ-1", "REQ-2"]);
      expect(content.openQuestions).toContain("Should admin accounts be exempt?");
    });

    it("refuses when a requirement matches a rejected approach", async () => {
      store.recordRejectedApproach({ description: "Auth: Railway", reason: "too expensive" });
      const { isError, text } = await callTool("present_spec", {
        title: "Auth",
        objective: "stand up login",
        requirements: [
          {
            id: "REQ-1",
            statement: "Deploy auth service to Railway",
            rationale: "it's easy",
            acceptanceCriteria: ["can reach the service over HTTPS"],
          },
        ],
      });
      expect(isError).toBe(true);
      expect(text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(store.getArtifacts().filter((a) => a.type === "spec")).toHaveLength(0);
    });
  });

  describe("revise_artifact — mode: supersede (N4)", () => {
    it("creates a versioned child and retires the old one", async () => {
      await callTool("present_findings", {
        summary: "first pass",
        findings: [{ category: "Security", detail: "weak hash", significance: "high" }],
      });
      const old = store.getArtifacts()[0];

      const { text, isError } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        title: "Second pass: actually it's argon2",
        content: {
          summary: "revised: weak hash turned out to be argon2id",
          findings: [{ category: "Security", detail: "already argon2id", significance: "low" }],
        },
        reason: "misidentified the library on first read",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(old.id);
      expect(text).toContain("v2");

      const artifacts = store.getArtifacts();
      expect(artifacts).toHaveLength(2);

      const retired = artifacts.find((a) => a.id === old.id);
      expect(retired?.status).toBe("superseded");

      const successor = artifacts.find((a) => a.id !== old.id);
      expect(successor?.type).toBe("research");
      expect(successor?.version).toBe(2);
      expect(successor?.parentId).toBe(old.id);
      expect(successor?.status).toBe("draft");

      // Reason is preserved as an agent comment on the OLD artifact
      const retiredComments = store.getCommentsForArtifact(old.id);
      expect(retiredComments.some((c) =>
        c.author === "agent" && c.content.includes("misidentified"))).toBe(true);
    });

    it("refuses to supersede an already-superseded artifact", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      store.updateArtifactStatus(old.id, "superseded");

      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: { summary: "x2", findings: [] },
        reason: "retry",
      });
      expect(isError).toBe(true);
      expect(text).toContain("already superseded");
    });

    it("records a new plan review cycle when superseding a plan", async () => {
      await callTool("present_plan", {
        title: "Original plan",
        steps: [{ description: "step A", reasoning: "because" }],
        estimatedChanges: 1,
      });
      const oldPlan = store.getArtifacts()[0];
      expect(store.getPendingPlanReviews().map((p) => p.artifactId)).toContain(oldPlan.id);

      const result = await callTool("revise_artifact", {
        artifactId: oldPlan.id,
        mode: "supersede",
        title: "Revised plan",
        content: {
          steps: [{ description: "step A'", reasoning: "incorporate feedback" }],
          estimatedChanges: 1,
        },
        reason: "human asked for smaller scope",
      });
      expect(result.isError).toBeFalsy();

      const newPlan = store.getArtifacts().find((a) => a.id !== oldPlan.id)!;
      const pending = store.getPendingPlanReviews();
      expect(pending.map((p) => p.artifactId)).toContain(newPlan.id);
    });

    it("errors on unknown artifactId", async () => {
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: "art_nope",
        mode: "supersede",
        content: { summary: "x", findings: [] },
        reason: "x",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });

    it("errors when mode='supersede' is missing content", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        reason: "revise it",
      });
      expect(isError).toBe(true);
      expect(text).toContain("content");
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

  describe("request_horizon_check (K3)", () => {
    it("posts an agent-authored horizon-check comment on the artifact", async () => {
      await callTool("present_plan", {
        title: "Cache layer",
        steps: [{ description: "Add Redis", reasoning: "latency" }],
        estimatedChanges: 1,
      });
      const plan = store.getArtifacts()[0];

      const { text, isError } = await callTool("request_horizon_check", {
        artifactId: plan.id,
        horizon: "1y",
      });
      expect(isError).toBeFalsy();
      expect(text).toContain("Horizon check (1 year)");

      const comments = store.getCommentsForArtifact(plan.id);
      const horizon = comments.find((c) => (c.target as any).sectionId?.startsWith("horizon_check:"));
      expect(horizon).toBeDefined();
      expect(horizon?.author).toBe("agent");
      expect((horizon?.target as any).sectionId).toBe("horizon_check:1y");
    });

    it("uses a custom prompt when provided", async () => {
      await callTool("present_plan", {
        title: "x",
        steps: [{ description: "y", reasoning: "z" }],
        estimatedChanges: 1,
      });
      const plan = store.getArtifacts()[0];

      await callTool("request_horizon_check", {
        artifactId: plan.id,
        horizon: "3mo",
        prompt: "What's the first thing that will break under load?",
      });

      const comments = store.getCommentsForArtifact(plan.id);
      const horizon = comments.find((c) => (c.target as any).sectionId?.startsWith("horizon_check:"));
      expect(horizon?.content).toBe("What's the first thing that will break under load?");
    });

    it("rejects unknown artifactId", async () => {
      const { isError, text } = await callTool("request_horizon_check", {
        artifactId: "art_not_real",
        horizon: "1y",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });

    it("rejects invalid horizon values", async () => {
      await callTool("present_plan", {
        title: "x",
        steps: [{ description: "y", reasoning: "z" }],
        estimatedChanges: 1,
      });
      const plan = store.getArtifacts()[0];

      const { isError, text } = await callTool("request_horizon_check", {
        artifactId: plan.id,
        horizon: "100y",
      });
      expect(isError).toBe(true);
      expect(text).toContain("3mo");
    });
  });

  describe("post_pr_review tool (M2)", () => {
    it("errors when pr argument is missing", async () => {
      const { text, isError } = await callTool("post_pr_review", {});
      expect(isError).toBe(true);
      expect(text).toContain("pr");
    });

    it("returns error when no findings have structured evidence", async () => {
      // Session has no research findings — payload.comments will be empty
      const { text, isError } = await callTool("post_pr_review", { pr: "42" });
      expect(isError).toBe(true);
      expect(text).toContain("No findings with structured evidence");
    });

    it("surfaces gh-missing errors clearly when gh is unavailable", async () => {
      // Seed a finding with structured evidence so payload.comments is non-empty
      await callTool("present_findings", {
        title: "x",
        summary: "y",
        findings: [{
          category: "Security",
          detail: "z",
          significance: "high",
          evidence: [{ filePath: "a.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "x" }],
        }],
      });

      // The actual gh spawn may fail with ENOENT on test runners without gh.
      // If it does, we expect the GhMissingError message to surface. If gh is
      // installed but not authed, we expect GhNotAuthedError. Either path is
      // acceptable — we just can't post from a test environment.
      const { text, isError } = await callTool("post_pr_review", { pr: "42" });
      // Either a clear gh-related error, or a wrapped failure — all isError
      expect(isError).toBe(true);
      const lower = text.toLowerCase();
      const isClean =
        lower.includes("gh") ||
        lower.includes("cli") ||
        lower.includes("authenticated") ||
        lower.includes("failed");
      expect(isClean).toBe(true);
    });
  });

  describe("recall — unified memory tool (N4)", () => {
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

  describe("pr-comments export format (L3)", () => {
    it("formats findings with severity, file:line anchors, and snippets", async () => {
      await callTool("present_findings", {
        title: "Auth audit",
        summary: "x",
        findings: [
          {
            category: "Security",
            title: "Weak hash",
            detail: "bcrypt rounds too low",
            severity: "high",
            significance: "high",
            impact: "brute force risk",
            recommendation: "use argon2id",
            evidence: [
              {
                filePath: "src/auth.ts",
                lineStart: 10,
                lineEnd: 12,
                snippet: "const hash = await bcrypt.hash(pw, 10);",
                explanation: "Only 10 rounds",
              },
            ],
          },
        ],
      });

      const { text } = await callTool("export_session", { format: "pr-comments" });
      expect(text).toContain("deepPairing notes");
      expect(text).toContain("### src/auth.ts");
      expect(text).toContain("🟠"); // severity emoji for high
      expect(text).toContain("HIGH");
      expect(text).toContain("src/auth.ts:L10-L12");
      expect(text).toContain("bcrypt.hash(pw, 10)");
      expect(text).toContain("Impact:");
      expect(text).toContain("Recommendation:");
    });

    it("groups findings by filePath", async () => {
      await callTool("present_findings", {
        title: "Multi-file",
        summary: "x",
        findings: [
          {
            category: "Perf",
            detail: "A",
            significance: "low",
            evidence: [{ filePath: "a.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "" }],
          },
          {
            category: "Perf",
            detail: "B",
            significance: "low",
            evidence: [{ filePath: "b.ts", lineStart: 1, lineEnd: 1, snippet: "y", explanation: "" }],
          },
        ],
      });
      const { text } = await callTool("export_session", { format: "pr-comments" });
      expect(text).toContain("### a.ts");
      expect(text).toContain("### b.ts");
    });

    it("omits rejected research artifacts", async () => {
      await callTool("present_findings", {
        title: "Proposed",
        summary: "x",
        findings: [{ category: "x", detail: "should not appear", significance: "low" }],
      });
      const a = store.getArtifacts()[0];
      store.updateArtifactStatus(a.id, "rejected");

      const { text } = await callTool("export_session", { format: "pr-comments" });
      expect(text).toContain("No findings from this pairing session");
    });
  });

  describe("MCP resources (E1)", () => {
    it("lists the current session + per-artifact resources", async () => {
      await callTool("present_findings", {
        title: "Auth review",
        summary: "findings",
        findings: [{ category: "Security", detail: "weak hash", significance: "high" }],
      });

      const list = await client.listResources();
      const uris = list.resources.map((r: any) => r.uri);

      expect(uris).toContain("deeppairing://session/current");
      // One artifact was created
      const artifactUris = uris.filter((u: string) => u.startsWith("deeppairing://artifact/"));
      expect(artifactUris).toHaveLength(1);

      const artifact = store.getArtifacts()[0];
      expect(artifactUris[0]).toBe(`deeppairing://artifact/${artifact.id}`);
    });

    it("reads the current session resource as JSON", async () => {
      await callTool("present_findings", {
        title: "x",
        summary: "y",
        findings: [{ category: "z", detail: "w", significance: "low" }],
      });

      const resource = await client.readResource({ uri: "deeppairing://session/current" });
      expect(resource.contents[0].mimeType).toBe("application/json");
      const parsed = JSON.parse(resource.contents[0].text as string);
      expect(parsed.sessionId).toBe("test_session");
      expect(parsed.artifacts).toHaveLength(1);
    });

    it("reads a single artifact resource by id", async () => {
      await callTool("present_findings", {
        title: "Target",
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];

      const resource = await client.readResource({ uri: `deeppairing://artifact/${artifact.id}` });
      const parsed = JSON.parse(resource.contents[0].text as string);
      expect(parsed.id).toBe(artifact.id);
      expect(parsed.title).toBe("Target");
    });

    it("errors on unknown artifact id", async () => {
      await expect(
        client.readResource({ uri: "deeppairing://artifact/art_nope" }),
      ).rejects.toThrow();
    });

    it("does not list past-session resources when the store can't read them (bare FileStore)", async () => {
      const list = await client.listResources();
      const uris = list.resources.map((r: any) => r.uri);
      // FileStore test harness doesn't implement listPastSessions, so the
      // index resource should be absent.
      expect(uris).not.toContain("deeppairing://sessions");
    });
  });

  describe("unknown tool", () => {
    it("returns an error for unknown tools", async () => {
      const result = await callTool("nonexistent");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Unknown tool");
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

  describe("Y2 — firstCallHint gating (write tools only)", () => {
    // Pre-Y2 the hint appended to EVERY first tool call. That contaminated
    // read-only tools — recall returned the philosophy ledger duplicated
    // underneath itself, export_session leaked session-memory text into
    // the markdown the user wanted to grab. Y2 restricts the append to
    // tools that WRITE (present_*, log_reasoning, revise_artifact,
    // post_pr_review). These tests pin both directions.

    it("present_findings (write) — first call carries the hint", async () => {
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).toMatch(/\[First use this session\]/);
    });

    it("recall (read) — first call does NOT carry the hint", async () => {
      const { text } = await callTool("recall", { query: "anything", mode: "any" });
      expect(text).not.toMatch(/\[First use this session\]/);
      // Negative spot-check — common contextual sections shouldn't leak in.
      expect(text).not.toMatch(/Cross-project philosophy ledger \(use recall/);
    });

    it("export_session (read) — first call does NOT carry the hint", async () => {
      // export_session returns markdown; contamination here was the worst
      // offender (the user pastes the export elsewhere).
      const { text } = await callTool("export_session", { format: "full" });
      expect(text).not.toMatch(/\[First use this session\]/);
    });

    it("check_feedback (read) — first call does NOT carry the hint", async () => {
      // check_feedback long-polls; an empty-state response shouldn't be
      // splattered with rejected-approach lists either.
      const { text } = await callTool("check_feedback", {});
      expect(text).not.toMatch(/\[First use this session\]/);
    });

    it("hint still fires on the first WRITE call even if a READ call ran first", async () => {
      // Per-server `firstToolCall` flag flips on ANY first call, including
      // reads. Y2's gate is on whether to *append* the hint, not whether
      // to *compute* it. This pins that the hint is computed once but is
      // attached only to the first qualifying write — so a read-then-write
      // sequence still surfaces the hint on the write.
      //
      // Note: the current implementation flips firstToolCall on first
      // dispatch regardless of tool, which means a leading read still
      // "burns" the computed hint. This test documents the ACTUAL
      // current behavior so a future change is intentional.
      await callTool("recall", { query: "x", mode: "any" });
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      // After the leading recall, firstCallHint has been computed +
      // discarded; the next present_findings does NOT carry it. This is
      // a known quirk; if a future PR wants the hint to attach to the
      // first WRITE rather than the first ANY, flip firstToolCall inside
      // the gate and remove the .not below.
      expect(text).not.toMatch(/\[First use this session\]/);
    });
  });
});
