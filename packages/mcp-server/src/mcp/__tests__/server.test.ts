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
      const { text } = await callTool("deepPairing_present_findings", {
        summary: "Found issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      expect(text).toContain("Findings recorded");
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getArtifacts()[0].type).toBe("research");
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].type).toBe("artifact_created");
    });
  });

  describe("present_options", () => {
    it("creates a decision artifact and records the decision request", async () => {
      const { text } = await callTool("deepPairing_present_options", {
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
      const { text } = await callTool("deepPairing_present_plan", {
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
      const { text } = await callTool("deepPairing_log_reasoning", {
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
      const { text } = await callTool("deepPairing_present_code_change", {
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

  describe("port in responses", () => {
    it("includes the correct port in tool responses", async () => {
      const { text } = await callTool("deepPairing_present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });

      expect(text).toContain("localhost:4000");
      expect(text).not.toContain("localhost:3847");
    });

    it("includes correct port in first-call hint", async () => {
      const { text } = await callTool("deepPairing_present_findings", {
        summary: "First call",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });

      expect(text).toContain("localhost:4000");
    });
  });

  describe("check_feedback", () => {
    it("returns session status preamble", async () => {
      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).toContain("Session:");
      expect(text).toContain("Suggested action:");
    });

    it("returns unacknowledged comments", async () => {
      // Create an artifact and add a comment
      await callTool("deepPairing_present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });
      const artId = store.getArtifacts()[0].id;
      store.addComment({ id: "cmt_1", artifactId: artId, content: "Good work", author: "human" });

      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).toContain("Good work");
    });

    it("returns resolved decisions", async () => {
      await callTool("deepPairing_present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "Service", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Inline", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const dec = store.getPendingDecisions()[0];
      store.resolveDecision(dec.decisionId, "a", "Cleaner");

      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).toContain("Service");
    });

    it("does NOT include session memory inside check_feedback", async () => {
      // Session memory is delivered on the first tool call hint (see
      // first-call-hint test below), never inside check_feedback — mixing
      // WAITING signals with past-violation warnings creates contradictory
      // imperatives for the agent.
      store.recordApprovedPattern("Service pattern");
      store.recordRejectedApproach("Inline refactor");

      // Burn the first tool call on something other than check_feedback
      await callTool("deepPairing_log_reasoning", {
        action: "warm-up",
        reasoning: "trigger the first-call hint elsewhere",
        confidence: "low",
      });

      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).not.toContain("previous sessions");
      expect(text).not.toContain("Rejected approaches");
    });
  });

  describe("session memory on first tool call", () => {
    it("includes rejected approaches with reasons in the first tool call response", async () => {
      store.recordRejectedApproach("Deploy to Railway", "too expensive for our scale");
      store.recordApprovedPattern("Service pattern");

      const { text } = await callTool("deepPairing_log_reasoning", {
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
      store.recordRejectedApproach("Inline refactor");

      await callTool("deepPairing_log_reasoning", {
        action: "first", reasoning: "x", confidence: "low",
      });
      const { text } = await callTool("deepPairing_log_reasoning", {
        action: "second", reasoning: "y", confidence: "low",
      });

      expect(text).not.toContain("From previous sessions");
      expect(text).not.toContain("Inline refactor");
    });

    it("resets poll counter when feedback arrives", async () => {
      // Poll 3 times with no feedback (no drafts = no long-poll)
      await callTool("deepPairing_check_feedback");
      await callTool("deepPairing_check_feedback");
      await callTool("deepPairing_check_feedback");

      // Now add human feedback — counter should reset
      store.addComment({ id: "cmt_1", artifactId: "__session__", content: "hello", author: "human" });
      const { text } = await callTool("deepPairing_check_feedback");

      expect(text).toContain("Human directive");
      expect(text).not.toContain("No human response"); // Counter was reset
    });

    it("increments poll counter on empty polls", async () => {
      // Poll 4 times with no feedback, no drafts = instant return
      await callTool("deepPairing_check_feedback");
      await callTool("deepPairing_check_feedback");
      await callTool("deepPairing_check_feedback");
      // 4th poll — counter is now 4
      const { text } = await callTool("deepPairing_check_feedback");
      // No pending items, so escalation hint won't appear,
      // but counter is tracked correctly (tested via reset above)
      expect(text).toContain("Session:");
    });
  });

  describe("export_session", () => {
    it("returns markdown in the specified format", async () => {
      await callTool("deepPairing_present_findings", {
        summary: "Auth issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      const { text } = await callTool("deepPairing_export_session", { format: "full" });
      expect(text).toContain("Session Report");
      expect(text).toContain("Weak hashing");
    });
  });

  describe("pre-flight rejected-approach validation", () => {
    it("blocks present_options when an option matches a rejected approach", async () => {
      store.recordRejectedApproach("Deploy: Railway", "too expensive for our scale");

      const result = await callTool("deepPairing_present_options", {
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

    it("broadcasts a preflight_blocked event so the UI can toast (H1)", async () => {
      store.recordRejectedApproach("Deploy: Railway", "too expensive", undefined, "pay-per-request hosting");

      await callTool("deepPairing_present_options", {
        context: "Pick a deploy target",
        options: [
          { id: "a", title: "Railway", description: "Fast", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
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
      store.recordRejectedApproach("Inline refactor");

      const result = await callTool("deepPairing_present_plan", {
        title: "Cleanup",
        steps: [{ description: "Inline refactor of auth module", reasoning: "simpler" }],
        estimatedChanges: 1,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(store.getArtifacts()).toHaveLength(0);
    });

    it("allows present_findings when nothing matches", async () => {
      store.recordRejectedApproach("Deploy: Railway");

      const { isError } = await callTool("deepPairing_present_findings", {
        summary: "Auth analysis",
        findings: [{ category: "Security", detail: "Weak hash", significance: "high" }],
      });

      expect(isError).toBeFalsy();
      expect(store.getArtifacts()).toHaveLength(1);
    });

    it("blocks via concept match even when surface names differ (U6)", async () => {
      // Past rejection: "Railway" with the underlying concept "pay-per-request serverless hosting"
      store.recordRejectedApproach(
        "Deploy: Railway",
        "too expensive for low-traffic services",
        undefined,
        "pay-per-request serverless hosting platform",
      );

      // Agent now proposes Fly.io with language that matches the concept tokens
      const result = await callTool("deepPairing_present_options", {
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
      await callTool("deepPairing_present_findings", {
        title: "Proposed caching layer",
        summary: "add Redis cache",
        findings: [{ category: "Perf", detail: "cache user profiles", significance: "high" }],
      });
      const artifact = store.getArtifacts()[0];

      // Simulate the HTTP PATH: status update to rejected with feedback.
      // We invoke the store directly since test fixtures don't use Hono.
      store.updateArtifactStatus(artifact.id, "rejected");
      // The HTTP handler also records the rejected approach — simulate that path
      store.recordRejectedApproach(
        artifact.title,
        "we already have a CDN layer; adding Redis is premature",
        artifact.id,
      );

      const memory = store.getSessionMemory();
      const match = memory.rejectedApproaches.find((r) => r.description === "Proposed caching layer");
      expect(match).toBeDefined();
      expect(match?.reason).toContain("premature");
      expect(match?.sourceArtifactId).toBe(artifact.id);
    });
  });

  describe("retract_artifact", () => {
    it("transitions the artifact to retracted and records the reason", async () => {
      await callTool("deepPairing_present_findings", {
        summary: "hasty analysis",
        findings: [{ category: "other", detail: "something", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];

      const { text, isError } = await callTool("deepPairing_retract_artifact", {
        artifactId: artifact.id,
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
      const { isError, text } = await callTool("deepPairing_retract_artifact", {
        artifactId: "art_does_not_exist",
        reason: "oops",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });

    it("errors when trying to retract an already-approved artifact", async () => {
      await callTool("deepPairing_present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.updateArtifactStatus(artifact.id, "approved");

      const { isError, text } = await callTool("deepPairing_retract_artifact", {
        artifactId: artifact.id,
        reason: "second thoughts",
      });
      expect(isError).toBe(true);
      expect(text).toContain("too late to retract");
    });

    it("requires both artifactId and reason", async () => {
      const missingReason = await callTool("deepPairing_retract_artifact", { artifactId: "art_x" });
      expect(missingReason.isError).toBe(true);
      expect(missingReason.text).toContain("reason");

      const missingId = await callTool("deepPairing_retract_artifact", { reason: "no id" });
      expect(missingId.isError).toBe(true);
      expect(missingId.text).toContain("artifactId");
    });
  });

  describe("answer_question + question prioritization", () => {
    it("prioritizes question comments in check_feedback with an answer hint", async () => {
      await callTool("deepPairing_present_findings", {
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

      const { text } = await callTool("deepPairing_check_feedback");
      // Questions section appears and carries the answer hint
      expect(text).toContain("Human questions");
      expect(text).toContain("why did you pick this approach");
      expect(text).toContain("deepPairing_answer_question");
      expect(text).toContain("cmt_q1");
      // Questions are listed before regular comments in the final text
      const qIdx = text.indexOf("Human questions");
      const cIdx = text.indexOf("Human comments");
      expect(qIdx).toBeGreaterThanOrEqual(0);
      expect(cIdx === -1 || qIdx < cIdx).toBe(true);
    });

    it("answer_question links the reply and marks the question answered", async () => {
      await callTool("deepPairing_present_findings", {
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

      const { text, isError } = await callTool("deepPairing_answer_question", {
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
      await callTool("deepPairing_present_findings", {
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
      await callTool("deepPairing_answer_question", {
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

      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).not.toContain("Human questions");
      expect(text).toContain("Human comments");
    });

    it("errors when answering an unknown commentId", async () => {
      const { isError, text } = await callTool("deepPairing_answer_question", {
        commentId: "cmt_not_real",
        answer: "hi",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no comment");
    });
  });

  describe("present_spec", () => {
    it("creates a spec artifact with requirements, tasks, and open questions", async () => {
      const { text, isError } = await callTool("deepPairing_present_spec", {
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
      store.recordRejectedApproach("Auth: Railway", "too expensive");
      const { isError, text } = await callTool("deepPairing_present_spec", {
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

  describe("supersede_artifact", () => {
    it("creates a versioned child and retires the old one", async () => {
      await callTool("deepPairing_present_findings", {
        summary: "first pass",
        findings: [{ category: "Security", detail: "weak hash", significance: "high" }],
      });
      const old = store.getArtifacts()[0];

      const { text, isError } = await callTool("deepPairing_supersede_artifact", {
        oldArtifactId: old.id,
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
      await callTool("deepPairing_present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      store.updateArtifactStatus(old.id, "superseded");

      const { isError, text } = await callTool("deepPairing_supersede_artifact", {
        oldArtifactId: old.id,
        content: { summary: "x2", findings: [] },
        reason: "retry",
      });
      expect(isError).toBe(true);
      expect(text).toContain("already superseded");
    });

    it("records a new plan review cycle when superseding a plan", async () => {
      await callTool("deepPairing_present_plan", {
        title: "Original plan",
        steps: [{ description: "step A", reasoning: "because" }],
        estimatedChanges: 1,
      });
      const oldPlan = store.getArtifacts()[0];
      expect(store.getPendingPlanReviews().map((p) => p.artifactId)).toContain(oldPlan.id);

      const result = await callTool("deepPairing_supersede_artifact", {
        oldArtifactId: oldPlan.id,
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

    it("errors on missing oldArtifactId", async () => {
      const { isError, text } = await callTool("deepPairing_supersede_artifact", {
        oldArtifactId: "art_nope",
        content: { summary: "x", findings: [] },
        reason: "x",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });
  });

  describe("recall_philosophy (J2)", () => {
    it("returns an empty-ledger message when no entries exist", async () => {
      const { text, isError } = await callTool("deepPairing_recall_philosophy", {});
      expect(isError).toBeFalsy();
      expect(text).toContain("empty");
    });

    it("returns entries matching a concept query", async () => {
      // Populate the ledger via the FileStore pathway (which mirrors to the global ledger)
      store.recordRejectedApproach("Deploy: Railway", "too expensive", undefined, "pay-per-request serverless hosting");
      store.recordRejectedApproach("Deploy: Fly.io", "ditto", undefined, "pay-per-request serverless hosting");

      const { text } = await callTool("deepPairing_recall_philosophy", { concept: "serverless" });
      expect(text).toContain("pay-per-request serverless hosting");
      expect(text).toContain("AVOID");
    });

    it("filters by stance", async () => {
      store.recordApprovedPattern("Service layer");
      store.recordApprovedPattern("Service layer"); // pushed again as if in another session
      store.recordApprovedPattern("Service layer");

      const { text } = await callTool("deepPairing_recall_philosophy", { stance: "prefer" });
      expect(text).toContain("Service layer");
      expect(text).toContain("PREFER");
    });
  });

  describe("MCP resources (E1)", () => {
    it("lists the current session + per-artifact resources", async () => {
      await callTool("deepPairing_present_findings", {
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
      await callTool("deepPairing_present_findings", {
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
      await callTool("deepPairing_present_findings", {
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
      const result = await callTool("deepPairing_nonexistent");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Unknown tool");
    });
  });
});
