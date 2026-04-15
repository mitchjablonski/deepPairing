import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import type { IStore } from "../store/store-interface.js";
import { FileStore } from "../store/file-store.js";
import { broadcast } from "./websocket.js";
import { formatSessionMarkdown } from "../export/format-markdown.js";

export function createHttpRoutes(store: IStore, projectRoot?: string) {
  const app = new Hono();

  app.use("/*", cors({
    origin: (origin) => {
      // Allow same-origin requests (no Origin header) and localhost on any port
      if (!origin) return origin as string;
      try {
        const url = new URL(origin);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
          return origin;
        }
      } catch { /* invalid origin */ }
      return undefined as unknown as string; // reject non-localhost origins
    },
  }));

  // Error handling
  app.onError((err, c) => {
    if (err instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    return c.json({ error: "Internal server error" }, 500);
  });

  // Full state for initial web UI hydration
  app.get("/api/state", async (c) => {
    return c.json(await store.getFullState());
  });

  // Submit a comment from the web UI
  app.post("/api/comments", async (c) => {
    const body = await c.req.json();
    const { artifactId, content, target } = body;

    if (!artifactId || !content) {
      return c.json({ error: "artifactId and content required" }, 400);
    }

    const comment = await store.addComment({
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

    await store.resolveDecision(decisionId, optionId, reasoning);

    // Update the decision artifact status
    const decision = await store.getDecision(decisionId);
    if (decision) {
      await store.updateArtifactStatus(decision.artifactId, "approved");
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

    await store.updateArtifactStatus(artifactId, status);
    await store.resolvePlanReview(artifactId, status, feedback);

    if (feedback) {
      const comment = await store.addComment({
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

  // Rename an artifact
  app.post("/api/artifacts/:artifactId/rename", async (c) => {
    const artifactId = c.req.param("artifactId");
    const body = await c.req.json();
    const { title } = body;
    if (!title || typeof title !== "string") {
      return c.json({ error: "title required" }, 400);
    }
    await store.renameArtifact(artifactId, title.trim());
    broadcast({ type: "artifact_renamed", artifactId, title: title.trim() });
    return c.json({ status: "renamed", artifactId });
  });

  // Get comments for an artifact
  app.get("/api/artifacts/:artifactId/comments", async (c) => {
    const artifactId = c.req.param("artifactId");
    return c.json({ comments: await store.getCommentsForArtifact(artifactId) });
  });

  // Export session as markdown
  app.get("/api/export", async (c) => {
    const format = (c.req.query("format") ?? "full") as "full" | "pr-description" | "adr";
    const state = await store.getFullState();
    const markdown = formatSessionMarkdown(state, format);
    return c.text(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  // Set preferences (autonomy level, etc.)
  app.post("/api/preferences", async (c) => {
    const body = await c.req.json();
    if (body.autonomyLevel) {
      await store.setAutonomyLevel(body.autonomyLevel);
      broadcast({ type: "preference_changed", autonomyLevel: body.autonomyLevel });
    }
    return c.json({ status: "updated" });
  });

  // Read a project file for the FileViewer
  app.get("/api/files", (c) => {
    const filePath = c.req.query("path");
    if (!filePath || !projectRoot) {
      return c.json({ error: "path parameter required" }, 400);
    }

    // Resolve to absolute and verify it's within the project root
    const resolved = path.resolve(projectRoot, filePath.startsWith("/") ? filePath.slice(1) : filePath);
    const resolvedRoot = path.resolve(projectRoot);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      return c.json({ error: "Path outside project root" }, 403);
    }

    try {
      const content = fs.readFileSync(resolved, "utf-8");
      return c.json({ content, filePath, lines: content.split("\n").length });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return c.json({ error: "File not found" }, 404);
      }
      return c.json({ error: "Cannot read file" }, 500);
    }
  });

  // List all active sessions (live + past) with their data
  app.get("/api/active-sessions", (c) => {
    if (!projectRoot) return c.json({ sessions: [] });
    const registryPath = path.join(projectRoot, ".deeppairing", "active-sessions.json");
    try {
      if (!fs.existsSync(registryPath)) return c.json({ sessions: [] });
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      // Filter to only alive processes
      const alive = registry.filter((e: any) => {
        try { process.kill(e.pid, 0); return true; } catch { return false; }
      });
      return c.json({ sessions: alive });
    } catch {
      return c.json({ sessions: [] });
    }
  });

  // Load a live session's artifacts from disk (for multi-agent view)
  app.get("/api/live-session/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    try {
      const state = FileStore.loadSession(projectRoot, sessionId);
      return c.json(state);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }
  });

  // Get session memory (rejected approaches, approved patterns)
  app.get("/api/memory", async (c) => {
    return c.json(await store.getSessionMemory());
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
    // Prevent path traversal — only allow safe session ID characters
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    try {
      const state = FileStore.loadSession(projectRoot, sessionId);
      return c.json(state);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }
  });

  return app;
}
