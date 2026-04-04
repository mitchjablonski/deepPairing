import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { EventEmitter } from "node:events";
import { createArtifactRoutes } from "../artifacts.js";
import { createCommentRoutes } from "../comments.js";
import { ArtifactStore } from "../../services/artifact-store.js";
import {
  FakeArtifactRepository,
  FakeCommentRepository,
} from "../../repositories/__fakes__/fake-repositories.js";
import type { PlanReviewResult } from "@deeppairing/mcp-server";

function createTestApp() {
  const artifactRepo = new FakeArtifactRepository();
  const commentRepo = new FakeCommentRepository();
  const artifactStore = new ArtifactStore(artifactRepo, commentRepo);
  const emitter = new EventEmitter();
  artifactStore.bind("sess_test", emitter);

  const pendingPlanReviews = new Map<
    string,
    { resolve: (result: PlanReviewResult) => void }
  >();

  const app = new Hono();
  app.route("/", createArtifactRoutes(artifactStore, pendingPlanReviews));
  app.route("/", createCommentRoutes(artifactStore));

  return { app, artifactStore, pendingPlanReviews };
}

describe("GET /api/sessions/:sessionId/artifacts", () => {
  it("returns empty list when no artifacts", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions/sess_test/artifacts");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.artifacts).toEqual([]);
  });

  it("returns artifacts for the session", async () => {
    const { app, artifactStore } = createTestApp();

    await artifactStore.createArtifact({
      type: "research",
      title: "Analysis",
      content: { summary: "Found things" },
    });

    const res = await app.request("/api/sessions/sess_test/artifacts");
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].type).toBe("research");
  });
});

describe("GET /api/sessions/:sessionId/artifacts/:id", () => {
  it("returns artifact with comments", async () => {
    const { app, artifactStore } = createTestApp();

    const artifact = await artifactStore.createArtifact({
      type: "plan",
      title: "Plan",
      content: { steps: [] },
    });

    await artifactStore.addComment({
      artifactId: artifact.id,
      content: "Looks good",
      author: "human",
    });

    const res = await app.request(
      `/api/sessions/sess_test/artifacts/${artifact.id}`,
    );
    const body = await res.json();

    expect(body.artifact.id).toBe(artifact.id);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].content).toBe("Looks good");
  });

  it("returns 404 for unknown artifact", async () => {
    const { app } = createTestApp();

    const res = await app.request(
      "/api/sessions/sess_test/artifacts/nonexistent",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:sessionId/artifacts/:id/status", () => {
  it("approves an artifact", async () => {
    const { app, artifactStore } = createTestApp();

    const artifact = await artifactStore.createArtifact({
      type: "plan",
      title: "Plan",
      content: {},
    });

    const res = await app.request(
      `/api/sessions/sess_test/artifacts/${artifact.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.newStatus).toBe("approved");
  });

  it("revises an artifact with feedback", async () => {
    const { app, artifactStore } = createTestApp();

    const artifact = await artifactStore.createArtifact({
      type: "plan",
      title: "Plan",
      content: {},
    });

    const res = await app.request(
      `/api/sessions/sess_test/artifacts/${artifact.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "revised",
          feedback: "Add error handling to step 2",
        }),
      },
    );

    expect(res.status).toBe(200);

    // Feedback should create a comment
    const comments = await artifactStore.getCommentsForArtifact(artifact.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe("Add error handling to step 2");
  });

  it("resolves a pending plan review when status is updated", async () => {
    const { app, artifactStore, pendingPlanReviews } = createTestApp();

    const artifact = await artifactStore.createArtifact({
      type: "plan",
      title: "Plan",
      content: {},
    });

    // Simulate a blocked plan review
    let reviewResult: PlanReviewResult | null = null;
    const reviewPromise = new Promise<PlanReviewResult>((resolve) => {
      pendingPlanReviews.set(artifact.id, { resolve });
    }).then((r) => {
      reviewResult = r;
    });

    // Approve via HTTP
    await app.request(
      `/api/sessions/sess_test/artifacts/${artifact.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved", feedback: "Ship it" }),
      },
    );

    await reviewPromise;
    expect(reviewResult).not.toBeNull();
    expect(reviewResult!.verdict).toBe("approved");
    expect(reviewResult!.feedback).toBe("Ship it");
    expect(pendingPlanReviews.has(artifact.id)).toBe(false);
  });

  it("rejects invalid status", async () => {
    const { app, artifactStore } = createTestApp();

    const artifact = await artifactStore.createArtifact({
      type: "plan",
      title: "Plan",
      content: {},
    });

    const res = await app.request(
      `/api/sessions/sess_test/artifacts/${artifact.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "invalid_status" }),
      },
    );

    expect(res.status).toBe(400);
  });
});

describe("POST /api/sessions/:sessionId/comments", () => {
  it("adds a comment to an artifact", async () => {
    const { app, artifactStore } = createTestApp();

    const artifact = await artifactStore.createArtifact({
      type: "research",
      title: "Research",
      content: {},
    });

    const res = await app.request("/api/sessions/sess_test/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { artifactId: artifact.id, findingIndex: 0 },
        content: "This finding is critical",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comment.author).toBe("human");
    expect(body.comment.content).toBe("This finding is critical");
    expect(body.comment.target.findingIndex).toBe(0);
  });

  it("adds a line-level comment", async () => {
    const { app, artifactStore } = createTestApp();

    const artifact = await artifactStore.createArtifact({
      type: "code_change",
      title: "Edit auth.ts",
      content: {},
    });

    const res = await app.request("/api/sessions/sess_test/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { artifactId: artifact.id, lineNumber: 15 },
        content: "Why not use a guard clause here?",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comment.target.lineNumber).toBe(15);
  });

  it("rejects empty content", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions/sess_test/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { artifactId: "art_1" },
        content: "",
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:sessionId/artifacts/:id/comments", () => {
  it("returns comments for an artifact", async () => {
    const { app, artifactStore } = createTestApp();

    const artifact = await artifactStore.createArtifact({
      type: "research",
      title: "Research",
      content: {},
    });

    await artifactStore.addComment({
      artifactId: artifact.id,
      content: "Comment 1",
      author: "human",
    });
    await artifactStore.addComment({
      artifactId: artifact.id,
      content: "Comment 2",
      author: "agent",
    });

    const res = await app.request(
      `/api/sessions/sess_test/artifacts/${artifact.id}/comments`,
    );
    const body = await res.json();

    expect(body.comments).toHaveLength(2);
  });
});
