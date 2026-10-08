import { describe, expect, it } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { createReviewRoutes, type ReviewStore } from "../review-routes.js";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { SessionReviewConflictError } from "../../store/session-records.js";
import { withGlobalStore } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";

class FailingDecisionStore extends FileStore {
  reviewError: Error = new Error("review write failed");

  override resolveDecision(): never {
    throw this.reviewError;
  }
}

describe("review route boundary", () => {
  it.each([
    [Object.assign(new Error("preferences lock busy"), { code: "ELOCKED", path: "/tmp/preferences.json.lock" }), 503, "lock_busy"],
    [new SessionReviewConflictError("art_decision"), 409, "session_review_conflict"],
  ] as const)("inherits the parent error mapping for %s", async (error, status, code) => {
    const fx = withGlobalStore("dp-review-errors-");
    const store = fx.track(new FailingDecisionStore(fx.dir, "session_errors"));
    store.reviewError = error;
    store.createArtifact({
      id: "art_decision", type: "decision", title: "Choose a cache",
      content: { decisionId: "decision_errors", context: "Choose a cache", options: [] },
    });
    const events: unknown[] = [];
    const app = withHash(createHttpRoutes(store, fx.dir, (event) => events.push(event)), fx.dir);
    try {
      const response = await app.request("/api/decisions/decision_errors", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Session-Id": "session_errors" },
        body: JSON.stringify({ optionId: "cache" }),
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: code, code });
      expect(events).toEqual([]);
      expect(store.getArtifacts()[0]?.status).toBe("draft");
    } finally {
      fx.dispose();
    }
  });

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
