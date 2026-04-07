import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import type { FileStore } from "../store/file-store.js";
import { broadcast } from "./websocket.js";

export function createHttpRoutes(store: FileStore) {
  const app = new Hono();

  app.use("/*", cors());

  // Full state for initial web UI hydration
  app.get("/api/state", (c) => {
    return c.json(store.getFullState());
  });

  // Submit a comment from the web UI
  app.post("/api/comments", async (c) => {
    const body = await c.req.json();
    const { artifactId, content, target } = body;

    if (!artifactId || !content) {
      return c.json({ error: "artifactId and content required" }, 400);
    }

    const comment = store.addComment({
      id: `cmt_${nanoid(10)}`,
      artifactId,
      content,
      author: "human",
      target,
    });

    broadcast({ type: "comment_added", comment });
    return c.json({ comment });
  });

  // Resolve a decision from the web UI
  app.post("/api/decisions/:decisionId", async (c) => {
    const decisionId = c.req.param("decisionId");
    const body = await c.req.json();
    const { optionId, reasoning } = body;

    if (!optionId) {
      return c.json({ error: "optionId required" }, 400);
    }

    store.resolveDecision(decisionId, optionId, reasoning);

    broadcast({
      type: "decision_resolved",
      decisionId,
      optionId,
      reasoning,
    });

    return c.json({ status: "resolved", decisionId });
  });

  // Approve/revise/reject a plan from the web UI
  app.post("/api/artifacts/:artifactId/status", async (c) => {
    const artifactId = c.req.param("artifactId");
    const body = await c.req.json();
    const { status, feedback } = body;

    if (!["approved", "revised", "rejected"].includes(status)) {
      return c.json({ error: "status must be approved, revised, or rejected" }, 400);
    }

    store.updateArtifactStatus(artifactId, status);
    store.resolvePlanReview(artifactId, status, feedback);

    if (feedback) {
      const comment = store.addComment({
        id: `cmt_${nanoid(10)}`,
        artifactId,
        content: feedback,
        author: "human",
      });
      broadcast({ type: "comment_added", comment });
    }

    broadcast({
      type: "artifact_updated",
      artifactId,
      status,
    });

    return c.json({ status: "updated", artifactId });
  });

  // Get comments for an artifact
  app.get("/api/artifacts/:artifactId/comments", (c) => {
    const artifactId = c.req.param("artifactId");
    return c.json({ comments: store.getCommentsForArtifact(artifactId) });
  });

  return app;
}
