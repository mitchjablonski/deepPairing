import { describe, it, expect, beforeEach } from "vitest";
import { bindStoreToSession } from "../../index.js";
import { createPresentFindingsTool } from "../present-findings.js";
import { createPresentOptionsTool } from "../present-options.js";
import { createPresentPlanTool } from "../present-plan.js";
import { createLogReasoningTool } from "../log-reasoning.js";
import { createCheckFeedbackTool } from "../check-feedback.js";
import {
  FakeMcpArtifactStore,
  FakeMcpDecisionManager,
  createFakePlanReview,
} from "../../__fakes__/fake-deps.js";

describe("deepPairing_present_findings", () => {
  it("creates a research artifact and returns confirmation", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    const tool = createPresentFindingsTool(store);

    const result = await (tool.handler as any)({
      summary: "Found security issues",
      findings: [
        { category: "Security", detail: "Weak hashing", evidence: "auth.ts:5", significance: "high" as const },
      ],
    });

    expect(rawStore.artifacts).toHaveLength(1);
    expect(rawStore.artifacts[0].type).toBe("research");
    expect(result.content[0]).toHaveProperty("text");
    expect((result.content[0] as any).text).toContain("Findings presented");
  });

  it("includes unacknowledged comments in response", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    // Add a pre-existing unacknowledged comment
    rawStore.comments.push({
      id: "cmt_prior",
      sessionId: "sess_test",
      target: { artifactId: "art_old" },
      parentCommentId: null,
      author: "human",
      content: "Please also check rate limiting",
      acknowledged: false,
      createdAt: new Date().toISOString(),
    });

    const tool = createPresentFindingsTool(store);
    const result = await (tool.handler as any)({
      summary: "Analysis",
      findings: [],
    });

    expect((result.content[0] as any).text).toContain("rate limiting");
  });
});

describe("deepPairing_present_options", () => {
  it("creates a decision artifact and blocks until resolved", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    const dm = new FakeMcpDecisionManager();
    dm.autoResolveWith = { optionId: "opt_a", reasoning: "Best fit" };

    const tool = createPresentOptionsTool(store, dm);

    const result = await (tool.handler as any)({
      context: "Which pattern?",
      options: [
        { id: "opt_a", title: "Service", description: "Extract service", pros: ["Clean"], cons: ["More files"], effort: "medium" as const, risk: "low" as const, recommendation: true },
        { id: "opt_b", title: "Inline", description: "Keep inline", pros: ["Quick"], cons: ["Messy"], effort: "low" as const, risk: "low" as const, recommendation: false },
      ],
    });

    expect(rawStore.artifacts).toHaveLength(1);
    expect(rawStore.artifacts[0].type).toBe("decision");
    expect((result.content[0] as any).text).toContain("Service");
    expect((result.content[0] as any).text).toContain("Best fit");
  });
});

describe("deepPairing_present_plan", () => {
  it("creates a plan artifact and returns approved result", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    const review = createFakePlanReview({ verdict: "approved" });

    const tool = createPresentPlanTool(store, review.callback);

    const result = await (tool.handler as any)({
      title: "Auth Refactor",
      steps: [
        { description: "Create service", files: ["/src/service.ts"], reasoning: "Clean separation" },
      ],
      estimatedChanges: 2,
    });

    expect(rawStore.artifacts).toHaveLength(1);
    expect(rawStore.artifacts[0].type).toBe("plan");
    expect((result.content[0] as any).text).toContain("APPROVED");
  });

  it("returns revision feedback when plan is revised", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    const review = createFakePlanReview({ verdict: "revised", feedback: "Add error handling step" });

    const tool = createPresentPlanTool(store, review.callback);

    const result = await (tool.handler as any)({
      title: "Plan",
      steps: [{ description: "Step 1", files: [], reasoning: "Because" }],
      estimatedChanges: 1,
    });

    expect((result.content[0] as any).text).toContain("REVISIONS");
    expect((result.content[0] as any).text).toContain("Add error handling step");
  });

  it("returns rejection when plan is rejected", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    const review = createFakePlanReview({ verdict: "rejected", feedback: "Wrong approach entirely" });

    const tool = createPresentPlanTool(store, review.callback);

    const result = await (tool.handler as any)({
      title: "Plan",
      steps: [{ description: "Step 1", files: [], reasoning: "Because" }],
      estimatedChanges: 1,
    });

    expect((result.content[0] as any).text).toContain("REJECTED");
    expect((result.content[0] as any).text).toContain("Wrong approach");
  });
});

describe("deepPairing_log_reasoning", () => {
  it("creates a reasoning artifact", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    const tool = createLogReasoningTool(store);

    const result = await (tool.handler as any)({
      action: "Refactor auth module",
      reasoning: "Better separation of concerns",
      alternativesConsidered: ["Keep inline"],
      confidence: "high" as const,
    });

    expect(rawStore.artifacts).toHaveLength(1);
    expect(rawStore.artifacts[0].type).toBe("reasoning");
    expect(rawStore.artifacts[0].title).toBe("Refactor auth module");
    expect((result.content[0] as any).text).toContain("Reasoning logged");
  });

  it("includes pending feedback in response", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    rawStore.comments.push({
      id: "cmt_fb",
      sessionId: "sess_test",
      target: { artifactId: "art_x" },
      parentCommentId: null,
      author: "human",
      content: "Also consider performance impact",
      acknowledged: false,
      createdAt: new Date().toISOString(),
    });

    const tool = createLogReasoningTool(store);
    const result = await (tool.handler as any)({
      action: "Change hashing",
      reasoning: "Security improvement",
      confidence: "high" as const,
    });

    expect((result.content[0] as any).text).toContain("performance impact");
  });
});

describe("deepPairing_check_feedback", () => {
  it("returns no feedback message when none exists", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    const tool = createCheckFeedbackTool(store);

    const result = await (tool.handler as any)({});

    expect((result.content[0] as any).text).toContain("No new human feedback");
  });

  it("returns and acknowledges pending comments", async () => {
    const rawStore = new FakeMcpArtifactStore();
    const store = bindStoreToSession(rawStore, "sess_test");
    rawStore.comments.push(
      {
        id: "c1",
        sessionId: "sess_test",
        target: { artifactId: "art_1", findingIndex: 0 },
        parentCommentId: null,
        author: "human",
        content: "This is critical",
        acknowledged: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: "c2",
        sessionId: "sess_test",
        target: { artifactId: "art_2", lineNumber: 5 },
        parentCommentId: null,
        author: "human",
        content: "Why not use a guard clause?",
        acknowledged: false,
        createdAt: new Date().toISOString(),
      },
    );

    const tool = createCheckFeedbackTool(store);
    const result = await (tool.handler as any)({});

    const text = (result.content[0] as any).text;
    expect(text).toContain("2 comments");
    expect(text).toContain("This is critical");
    expect(text).toContain("guard clause");
    expect(text).toContain("finding #1");
    expect(text).toContain("line 5");

    // Comments should now be acknowledged
    const remaining = await store.getUnacknowledgedComments();
    expect(remaining).toHaveLength(0);
  });
});
