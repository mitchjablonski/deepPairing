import { Hono } from "hono";
import { CreateCommentRequestSchema } from "@deeppairing/shared";
import type { ArtifactStore } from "../services/artifact-store.js";

export function createCommentRoutes(artifactStore: ArtifactStore) {
  const router = new Hono();

  router.post("/api/sessions/:sessionId/comments", async (c) => {
    const body = await c.req.json();
    const parsed = CreateCommentRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const sessionId = c.req.param("sessionId");
    const comment = await artifactStore.addComment(sessionId, {
      artifactId: parsed.data.target.artifactId,
      content: parsed.data.content,
      author: "human",
      lineNumber: parsed.data.target.lineNumber,
      findingIndex: parsed.data.target.findingIndex,
      stepIndex: parsed.data.target.stepIndex,
      sectionId: parsed.data.target.sectionId,
      parentCommentId: parsed.data.parentCommentId ?? undefined,
    });

    return c.json({ comment });
  });

  router.get("/api/sessions/:sessionId/artifacts/:id/comments", async (c) => {
    const artifactId = c.req.param("id");
    const comments = await artifactStore.getCommentsForArtifact(artifactId);
    return c.json({ comments });
  });

  return router;
}
