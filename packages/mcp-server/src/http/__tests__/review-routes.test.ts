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

class CountingDecisionStore extends FileStore {
  resolveCalls = 0;

  override resolveDecision(...args: Parameters<FileStore["resolveDecision"]>) {
    this.resolveCalls++;
    return super.resolveDecision(...args);
  }
}

describe("review route boundary", () => {
  it.each([
    ["opt_a", 200],
    ["opt_b", 409],
  ] as const)("preserves the recorded answer before writing when resolving %s", async (optionId, status) => {
    const fx = withGlobalStore("dp-review-stale-");
    const store = fx.track(new CountingDecisionStore(fx.dir, "session_selected"));
    const options = ["opt_a", "opt_b"].map((id) => ({
      id, title: id, description: "d", pros: [], cons: [],
      effort: "low" as const, risk: "low" as const, recommendation: false,
    }));
    store.createArtifact({ id: "art_decision", type: "decision", title: "Choose a cache", content: { decisionId: "decision_selected", context: "Choose a cache", options } });
    store.recordDecisionRequest({ decisionId: "decision_selected", artifactId: "art_decision", context: "Choose a cache", options });
    store.resolveDecision("decision_selected", "opt_a", "first answer");
    store.forceFlush();
    store.resolveCalls = 0;
    const resolvedAt = store.getDecision("decision_selected")?.resolvedAt;
    const events: Array<{ event: unknown; sessionId?: string }> = [];
    let taskCalls = 0;
    const app = createReviewRoutes({
      getStore: () => store,
      broadcast: (event, sessionId) => events.push({ event, sessionId }),
      log: () => undefined,
      updateTaskStatus: () => { taskCalls++; },
    });
    try {
      const response = await app.request("/api/decisions/decision_selected", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Session-Id": "session_selected" },
        body: JSON.stringify({ optionId, reasoning: "replacement answer" }),
      });
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ resolution: { optionId: "opt_a", reasoning: "first answer", resolvedAt } });
      expect(body).toMatchObject(status === 200 ? { alreadyResolved: true } : { code: "verdict_already_final", currentStatus: "approved" });
      expect(store.getDecisionResponse("decision_selected")?.reasoning).toBe("first answer");
      expect(store.getDecision("decision_selected")?.resolvedAt).toBe(resolvedAt);
      expect(store.resolveCalls).toBe(0);
      expect(taskCalls).toBe(0);
      expect(events).toEqual(status === 200 ? [] : [{ event: { type: "artifact_updated", artifactId: "art_decision", status: "approved" }, sessionId: "session_selected" }]);
    } finally {
      fx.dispose();
    }
  });

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
