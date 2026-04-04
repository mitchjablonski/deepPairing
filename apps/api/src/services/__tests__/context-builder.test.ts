import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { buildDecisionContext, buildSessionContext } from "../context-builder.js";
import { ArtifactStore } from "../artifact-store.js";
import {
  FakeDecisionRepository,
  FakeArtifactRepository,
  FakeCommentRepository,
} from "../../repositories/__fakes__/fake-repositories.js";

function createArtifactStore() {
  const store = new ArtifactStore(new FakeArtifactRepository(), new FakeCommentRepository());
  store.bind("sess_1", new EventEmitter());
  return store;
}

describe("buildDecisionContext", () => {
  it("returns empty string when no decisions exist", async () => {
    const repo = new FakeDecisionRepository();
    const result = await buildDecisionContext(repo, "sess_1");
    expect(result).toBe("");
  });

  it("returns empty string when all decisions are pending", async () => {
    const repo = new FakeDecisionRepository();
    await repo.create({
      id: "dec_1",
      sessionId: "sess_1",
      parentDecisionId: null,
      context: "How to refactor?",
      options: [{ id: "a", title: "Option A", description: "desc" }],
      selectedOptionId: null,
      humanReasoning: null,
      agentReasoning: null,
      status: "pending",
    });

    const result = await buildDecisionContext(repo, "sess_1");
    expect(result).toBe("");
  });

  it("includes resolved decisions with chosen option", async () => {
    const repo = new FakeDecisionRepository();
    await repo.create({
      id: "dec_1",
      sessionId: "sess_1",
      parentDecisionId: null,
      context: "Which pattern to use?",
      options: [
        { id: "a", title: "Service Pattern", description: "Extract to service" },
        { id: "b", title: "Inline", description: "Keep inline" },
      ],
      selectedOptionId: null,
      humanReasoning: null,
      agentReasoning: null,
      status: "pending",
    });
    await repo.resolve("dec_1", "a", "Matches existing patterns");

    const result = await buildDecisionContext(repo, "sess_1");
    expect(result).toContain("Which pattern to use?");
    expect(result).toContain("Service Pattern");
    expect(result).toContain("Matches existing patterns");
    expect(result).toContain("Inline");
    expect(result).toContain("Rejected alternatives");
  });

  it("includes multiple resolved decisions", async () => {
    const repo = new FakeDecisionRepository();

    await repo.create({
      id: "d1", sessionId: "sess_1", parentDecisionId: null,
      context: "First decision",
      options: [{ id: "a", title: "A", description: "" }],
      selectedOptionId: null, humanReasoning: null, agentReasoning: null,
      status: "pending",
    });
    await repo.resolve("d1", "a");

    await repo.create({
      id: "d2", sessionId: "sess_1", parentDecisionId: "d1",
      context: "Second decision",
      options: [{ id: "x", title: "X", description: "" }],
      selectedOptionId: null, humanReasoning: null, agentReasoning: null,
      status: "pending",
    });
    await repo.resolve("d2", "x", "Because X");

    const result = await buildDecisionContext(repo, "sess_1");
    expect(result).toContain("First decision");
    expect(result).toContain("Second decision");
    expect(result).toContain("Prior Decisions");
  });

  it("only includes decisions for the specified session", async () => {
    const repo = new FakeDecisionRepository();

    await repo.create({
      id: "d1", sessionId: "sess_1", parentDecisionId: null,
      context: "Session 1 decision",
      options: [{ id: "a", title: "A", description: "" }],
      selectedOptionId: null, humanReasoning: null, agentReasoning: null,
      status: "pending",
    });
    await repo.resolve("d1", "a");

    await repo.create({
      id: "d2", sessionId: "sess_2", parentDecisionId: null,
      context: "Session 2 decision",
      options: [{ id: "b", title: "B", description: "" }],
      selectedOptionId: null, humanReasoning: null, agentReasoning: null,
      status: "pending",
    });
    await repo.resolve("d2", "b");

    const result = await buildDecisionContext(repo, "sess_1");
    expect(result).toContain("Session 1 decision");
    expect(result).not.toContain("Session 2 decision");
  });
});

describe("buildSessionContext", () => {
  it("returns empty string when nothing exists", async () => {
    const repo = new FakeDecisionRepository();
    const store = createArtifactStore();
    const result = await buildSessionContext(repo, store, "sess_1");
    expect(result).toBe("");
  });

  it("includes artifact status section", async () => {
    const repo = new FakeDecisionRepository();
    const store = createArtifactStore();

    await store.createArtifact({ type: "research", title: "Analysis", content: {} });
    await store.createArtifact({ type: "plan", title: "Plan", content: {} });

    const result = await buildSessionContext(repo, store, "sess_1");
    expect(result).toContain("Artifact Status");
    expect(result).toContain("Analysis");
    expect(result).toContain("Plan");
  });

  it("marks rejected artifacts as do-not-revisit", async () => {
    const repo = new FakeDecisionRepository();
    const store = createArtifactStore();

    const art = await store.createArtifact({ type: "plan", title: "Bad Plan", content: {} });
    await store.updateStatus(art.id, "rejected");

    const result = await buildSessionContext(repo, store, "sess_1");
    expect(result).toContain("DO NOT revisit");
  });

  it("includes unacknowledged feedback section", async () => {
    const repo = new FakeDecisionRepository();
    const store = createArtifactStore();

    const art = await store.createArtifact({ type: "research", title: "Research", content: {} });
    await store.addComment({
      artifactId: art.id,
      content: "Please also check the database layer",
      author: "human",
    });

    const result = await buildSessionContext(repo, store, "sess_1");
    expect(result).toContain("Unacknowledged Human Feedback");
    expect(result).toContain("database layer");
  });

  it("combines decisions, artifacts, and feedback", async () => {
    const repo = new FakeDecisionRepository();
    const store = createArtifactStore();

    // Decision
    await repo.create({
      id: "d1", sessionId: "sess_1", parentDecisionId: null,
      context: "Which approach?",
      options: [{ id: "a", title: "A", description: "" }],
      selectedOptionId: null, humanReasoning: null, agentReasoning: null,
      status: "pending",
    });
    await repo.resolve("d1", "a", "Best option");

    // Artifact
    await store.createArtifact({ type: "plan", title: "The Plan", content: {} });

    // Comment
    const art = await store.createArtifact({ type: "research", title: "Research", content: {} });
    await store.addComment({ artifactId: art.id, content: "Good work", author: "human" });

    const result = await buildSessionContext(repo, store, "sess_1");
    expect(result).toContain("Prior Decisions");
    expect(result).toContain("Artifact Status");
    expect(result).toContain("Unacknowledged Human Feedback");
  });
});
