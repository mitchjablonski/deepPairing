import { Hono } from "hono";
import { z } from "zod";
import type { ArtifactStore } from "../services/artifact-store.js";
import type { PlanReviewResult } from "@deeppairing/mcp-server";

const UpdateStatusSchema = z.object({
  status: z.enum(["approved", "revised", "rejected"]),
  feedback: z.string().optional(),
});

export function createArtifactRoutes(
  artifactStore: ArtifactStore,
  pendingPlanReviews: Map<string, { resolve: (result: PlanReviewResult) => void }>,
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
    const artifactId = c.req.param("id");

    const body = await c.req.json();
    const parsed = UpdateStatusSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const { status, feedback } = parsed.data;

    await artifactStore.updateStatus(artifactId, status, feedback);

    // If there's a pending plan review for this artifact, resolve it
    const pendingReview = pendingPlanReviews.get(artifactId);
    if (pendingReview) {
      const verdict = status as PlanReviewResult["verdict"];
      pendingReview.resolve({ verdict, feedback });
      pendingPlanReviews.delete(artifactId);
    }

    return c.json({ status: "updated", artifactId, newStatus: status });
  });

  return router;
}
