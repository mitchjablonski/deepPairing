/**
 * Internal API routes for daemon ↔ MCP wrapper communication.
 * These are called by DaemonClient, not by the web UI.
 */
import { Hono } from "hono";
import type { FileStore } from "./store/file-store.js";
import type { Artifact, Comment } from "@deeppairing/shared";

type SessionMap = Map<string, FileStore>;
type BroadcastFn = (sessionId: string, event: any) => void;

export interface SessionMeta {
  title: string;
  project: string;
  registeredAt: string;
}

export function createDaemonRoutes(
  sessions: SessionMap,
  sessionMeta: Map<string, SessionMeta>,
  createSession: (sessionId: string) => FileStore,
  broadcast: BroadcastFn,
) {
  const app = new Hono();

  /** Get or create the FileStore for a session */
  function getStore(sessionId: string): FileStore {
    let store = sessions.get(sessionId);
    if (!store) {
      store = createSession(sessionId);
      sessions.set(sessionId, store);
    }
    return store;
  }

  // --- Session lifecycle ---

  app.post("/api/internal/sessions/:sessionId/register", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json().catch(() => ({}));
    const store = getStore(sessionId);
    // Store session metadata (title, project)
    sessionMeta.set(sessionId, {
      title: body.title ?? sessionId,
      project: body.project ?? "",
      registeredAt: new Date().toISOString(),
    });
    return c.json({ status: "registered", sessionId, state: store.getFullState() });
  });

  // Rename a session
  app.post("/api/internal/sessions/:sessionId/rename", async (c) => {
    const sessionId = c.req.param("sessionId");
    const { title } = await c.req.json();
    const meta = sessionMeta.get(sessionId);
    if (meta) meta.title = title;
    broadcast(sessionId, { type: "session_renamed", sessionId, title });
    return c.json({ status: "renamed" });
  });

  app.post("/api/internal/sessions/:sessionId/unregister", async (c) => {
    const sessionId = c.req.param("sessionId");
    const store = sessions.get(sessionId);
    if (store) store.forceFlush();
    // Don't delete from map — session data persists for the web UI
    return c.json({ status: "unregistered" });
  });

  // --- Artifacts ---

  app.post("/api/internal/sessions/:sessionId/artifacts", async (c) => {
    const sessionId = c.req.param("sessionId");
    const store = getStore(sessionId);
    const params = await c.req.json();
    const artifact = store.createArtifact(params);
    broadcast(sessionId, { type: "artifact_created", artifact });
    return c.json({ artifact });
  });

  app.get("/api/internal/sessions/:sessionId/artifacts", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ artifacts: store.getArtifacts() });
  });

  app.post("/api/internal/sessions/:sessionId/artifacts/:artifactId/status", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { status } = await c.req.json();
    store.updateArtifactStatus(c.req.param("artifactId"), status);
    broadcast(c.req.param("sessionId"), { type: "artifact_updated", artifactId: c.req.param("artifactId"), status });
    return c.json({ status: "updated" });
  });

  app.post("/api/internal/sessions/:sessionId/artifacts/:artifactId/rename", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { title } = await c.req.json();
    store.renameArtifact(c.req.param("artifactId"), title);
    broadcast(c.req.param("sessionId"), { type: "artifact_renamed", artifactId: c.req.param("artifactId"), title });
    return c.json({ status: "renamed" });
  });

  // --- Comments ---

  app.post("/api/internal/sessions/:sessionId/comments", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const params = await c.req.json();
    // params already has intent/parentCommentId when the MCP wrapper sends them
    const comment = store.addComment(params);
    broadcast(c.req.param("sessionId"), { type: "comment_added", comment });
    return c.json({ comment });
  });

  app.get("/api/internal/sessions/:sessionId/comments/unacknowledged", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ comments: store.getUnacknowledgedComments() });
  });

  app.post("/api/internal/sessions/:sessionId/comments/acknowledge", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { ids } = await c.req.json();
    store.acknowledgeComments(ids);
    return c.json({ status: "acknowledged" });
  });

  app.get("/api/internal/sessions/:sessionId/artifacts/:artifactId/comments", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ comments: store.getCommentsForArtifact(c.req.param("artifactId")) });
  });

  app.get("/api/internal/sessions/:sessionId/comments/:commentId", (c) => {
    const store = getStore(c.req.param("sessionId"));
    const comment = store.getComment(c.req.param("commentId"));
    return c.json({ comment: comment ?? null });
  });

  app.post("/api/internal/sessions/:sessionId/comments/:commentId/answered", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { answerCommentId } = await c.req.json();
    store.markCommentAnswered(c.req.param("commentId"), answerCommentId);
    return c.json({ status: "marked" });
  });

  // --- Decisions ---

  app.post("/api/internal/sessions/:sessionId/decisions", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const params = await c.req.json();
    store.recordDecisionRequest(params);
    return c.json({ status: "recorded" });
  });

  app.post("/api/internal/sessions/:sessionId/decisions/:decisionId/resolve", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { optionId, reasoning } = await c.req.json();
    store.resolveDecision(c.req.param("decisionId"), optionId, reasoning);
    broadcast(c.req.param("sessionId"), { type: "decision_resolved", decisionId: c.req.param("decisionId"), optionId, reasoning });
    return c.json({ status: "resolved" });
  });

  app.get("/api/internal/sessions/:sessionId/decisions/pending", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ decisions: store.getPendingDecisions() });
  });

  app.get("/api/internal/sessions/:sessionId/decisions/resolved", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ decisions: store.getResolvedDecisions() });
  });

  app.post("/api/internal/sessions/:sessionId/decisions/acknowledge", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { ids } = await c.req.json();
    store.acknowledgeDecisions(ids);
    return c.json({ status: "acknowledged" });
  });

  app.get("/api/internal/sessions/:sessionId/decisions/:decisionId", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ decision: store.getDecision(c.req.param("decisionId")) });
  });

  app.get("/api/internal/sessions/:sessionId/decisions/:decisionId/response", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ response: store.getDecisionResponse(c.req.param("decisionId")) });
  });

  // --- Plan Reviews ---

  app.post("/api/internal/sessions/:sessionId/plan-reviews", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { artifactId } = await c.req.json();
    store.recordPlanReview(artifactId);
    return c.json({ status: "recorded" });
  });

  app.post("/api/internal/sessions/:sessionId/plan-reviews/:artifactId/resolve", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { verdict, feedback } = await c.req.json();
    store.resolvePlanReview(c.req.param("artifactId"), verdict, feedback);
    return c.json({ status: "resolved" });
  });

  app.get("/api/internal/sessions/:sessionId/plan-reviews/pending", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ reviews: store.getPendingPlanReviews() });
  });

  app.get("/api/internal/sessions/:sessionId/plan-reviews/:artifactId/verdict", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json(store.getPlanReviewVerdict(c.req.param("artifactId")));
  });

  // --- Feedback long-poll ---

  app.get("/api/internal/sessions/:sessionId/wait-feedback", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const timeout = parseInt(c.req.query("timeout") ?? "30000", 10);
    await store.waitForFeedback(timeout);
    return c.json({ status: "complete" });
  });

  // --- State & metrics ---

  app.get("/api/internal/sessions/:sessionId/state", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json(store.getFullState());
  });

  app.get("/api/internal/sessions/:sessionId/metrics", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json(store.getEngagementMetrics());
  });

  app.post("/api/internal/sessions/:sessionId/flush", (c) => {
    const store = getStore(c.req.param("sessionId"));
    store.forceFlush();
    return c.json({ status: "flushed" });
  });

  // --- Memory ---

  app.get("/api/internal/sessions/:sessionId/memory", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json(store.getSessionMemory());
  });

  app.post("/api/internal/sessions/:sessionId/memory/rejected", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { description, reason, sourceArtifactId, concept } = await c.req.json();
    store.recordRejectedApproach(description, reason, sourceArtifactId, concept);
    return c.json({ status: "recorded" });
  });

  app.post("/api/internal/sessions/:sessionId/memory/approved", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { description } = await c.req.json();
    store.recordApprovedPattern(description);
    return c.json({ status: "recorded" });
  });

  // --- Autonomy ---

  app.get("/api/internal/sessions/:sessionId/autonomy", (c) => {
    const store = getStore(c.req.param("sessionId"));
    return c.json({ level: store.getAutonomyLevel() });
  });

  app.post("/api/internal/sessions/:sessionId/autonomy", async (c) => {
    const store = getStore(c.req.param("sessionId"));
    const { level } = await c.req.json();
    store.setAutonomyLevel(level);
    return c.json({ status: "updated" });
  });

  // --- Active sessions list ---

  app.get("/api/internal/sessions", (c) => {
    const list = Array.from(sessions.entries()).map(([id, store]) => {
      const meta = sessionMeta.get(id);
      return {
        sessionId: id,
        title: meta?.title ?? id,
        project: meta?.project ?? "",
        artifactCount: store.getArtifacts().length,
        registeredAt: meta?.registeredAt,
      };
    });
    return c.json({ sessions: list });
  });

  return app;
}
