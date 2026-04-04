import { Hono } from "hono";
import { z } from "zod";
import type { ArtifactStore } from "../services/artifact-store.js";
import type { SessionStore } from "../services/session-store.js";
import type { PlanReviewResult } from "@deeppairing/mcp-server";

const UpdateStatusSchema = z.object({
  status: z.enum(["approved", "revised", "rejected"]),
  feedback: z.string().optional(),
});

export function createArtifactRoutes(
  artifactStore: ArtifactStore,
  pendingPlanReviews: Map<string, { resolve: (result: PlanReviewResult) => void }>,
  sessionStore?: SessionStore,
) {
  const router = new Hono();

  router.get("/api/sessions/:sessionId/artifacts", async (c) => {
    const artifacts = await artifactStore.getArtifactsBySession();
    return c.json({ artifacts });
  });

  router.get("/api/sessions/:sessionId/artifacts/:id", async (c) => {
    const artifactId = c.req.param("id");
    const artifacts = await artifactStore.getArtifactsBySession();
    const artifact = artifacts.find((a) => a.id === artifactId);

    if (!artifact) {
      return c.json({ error: "Artifact not found" }, 404);
    }

    const comments = await artifactStore.getCommentsForArtifact(artifactId);
    return c.json({ artifact, comments });
  });

  router.post("/api/sessions/:sessionId/artifacts/:id/status", async (c) => {
    const sessionId = c.req.param("sessionId");
    const artifactId = c.req.param("id");

    const body = await c.req.json();
    const parsed = UpdateStatusSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const { status, feedback } = parsed.data;

    await artifactStore.updateStatus(artifactId, status, feedback);

    // Resolve pending plan review (real agent path via MCP)
    const pendingReview = pendingPlanReviews.get(artifactId);
    if (pendingReview) {
      const verdict = status as PlanReviewResult["verdict"];
      pendingReview.resolve({ verdict, feedback });
      pendingPlanReviews.delete(artifactId);
    }

    // Emit plan:resolved on the session emitter (fake agent path)
    const session = sessionStore?.get(sessionId);
    if (session) {
      session.emitter.emit("plan:resolved", { verdict: status, feedback });
    }

    return c.json({ status: "updated", artifactId, newStatus: status });
  });

  return router;
}
