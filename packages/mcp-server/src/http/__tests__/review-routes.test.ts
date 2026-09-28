import { describe, expect, it } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { createReviewRoutes, type ReviewStore } from "../review-routes.js";

describe("review route boundary", () => {
  it("passes the request-selected store identity to task status updates", async () => {
    const artifact = {
      id: "art_selected",
      type: "plan",
      title: "Selected store plan",
      status: "draft",
      content: {},
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      version: 1,
    } as Artifact;
    const selectedStore = {
      getSessionId: () => "session_selected",
      getArtifacts: () => [artifact],
      updateArtifactStatus: () => undefined,
      resolvePlanReview: () => undefined,
      forceFlush: () => undefined,
    } as unknown as ReviewStore;
    let taskStore: ReviewStore | undefined;
    const app = createReviewRoutes({
      getStore: () => selectedStore,
      broadcast: () => undefined,
      log: () => undefined,
      updateTaskStatus: (_artifactId, store) => { taskStore = store; },
    });

    const response = await app.request("/api/artifacts/art_selected/status", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Session-Id": "session_selected" },
      body: JSON.stringify({ status: "approved" }),
    });

    expect(response.status).toBe(200);
    expect(taskStore).toBe(selectedStore);
  });
});
