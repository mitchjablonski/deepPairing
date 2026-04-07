import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { FileStore } from "../store/file-store.js";
import { broadcast } from "./websocket.js";
import { formatSessionMarkdown } from "../export/format-markdown.js";

export function createHttpRoutes(store: FileStore, projectRoot?: string) {
  const app = new Hono();

  app.use("/*", cors());

  // Error handling
  app.onError((err, c) => {
    if (err instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    return c.json({ error: "Internal server error" }, 500);
  });

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

    // Update the decision artifact status
    const decision = store.getDecision(decisionId);
    if (decision) {
      store.updateArtifactStatus(decision.artifactId, "approved");
    }

    broadcast({
      type: "decision_resolved",
      decisionId,
      artifactId: decision?.artifactId,
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

  // Export session as markdown
  app.get("/api/export", (c) => {
    const format = (c.req.query("format") ?? "full") as "full" | "pr-description" | "adr";
    const state = store.getFullState();
    const markdown = formatSessionMarkdown(state, format);
    return c.text(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  // List past sessions
  app.get("/api/sessions", (c) => {
    if (!projectRoot) return c.json({ sessions: [] });
    const sessions = FileStore.listSessions(projectRoot);
    return c.json({ sessions });
  });

  // Load a specific past session
  app.get("/api/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    try {
      const state = FileStore.loadSession(projectRoot, sessionId);
      return c.json(state);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }
  });

  return app;
}
