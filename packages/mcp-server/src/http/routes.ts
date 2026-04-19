import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import type { IStore } from "../store/store-interface.js";
import { FileStore } from "../store/file-store.js";
import { broadcast as defaultBroadcast } from "./websocket.js";
import { formatSessionMarkdown } from "../export/format-markdown.js";

type StoreGetter = (sessionId?: string) => IStore;
type BroadcastFn = (event: any, sessionId?: string) => void;

/** Extract sessionId from X-Session-Id header */
function getSessionId(c: any): string | undefined {
  return c.req.header("X-Session-Id") ?? undefined;
}

export function createHttpRoutes(
  storeOrGetter: IStore | StoreGetter,
  projectRoot?: string,
  broadcastFn?: BroadcastFn,
) {
  const getStore: StoreGetter = typeof storeOrGetter === "function"
    ? storeOrGetter as StoreGetter
    : () => storeOrGetter;

  const broadcast: BroadcastFn = broadcastFn ?? ((event) => defaultBroadcast(event));

  const app = new Hono();

  app.use("/*", cors({
    origin: (origin) => {
      if (!origin) return origin as string;
      try {
        const url = new URL(origin);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
          return origin;
        }
      } catch {}
      return undefined as unknown as string;
    },
  }));

  app.onError((err, c) => {
    if (err instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    return c.json({ error: "Internal server error" }, 500);
  });

  // Full state for initial web UI hydration
  app.get("/api/state", async (c) => {
    const store = getStore(getSessionId(c));
    return c.json(await store.getFullState());
  });

  // Submit a comment from the web UI
  app.post("/api/comments", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    const body = await c.req.json();
    const { artifactId, content, target, intent, parentCommentId } = body;

    if (!artifactId || !content) {
      return c.json({ error: "artifactId and content required" }, 400);
    }

    const comment = await store.addComment({
      id: `cmt_${nanoid(10)}`,
      artifactId,
      content,
      author: "human",
      target,
      intent,
      parentCommentId: parentCommentId ?? null,
    });

    broadcast({ type: "comment_added", comment }, sid);
    return c.json({ comment });
  });

  // Resolve a decision from the web UI
  app.post("/api/decisions/:decisionId", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    const decisionId = c.req.param("decisionId");
    const body = await c.req.json();
    const { optionId, reasoning, confidence, predictedOutcome } = body;

    if (!optionId) {
      return c.json({ error: "optionId required" }, 400);
    }

    const prediction = confidence || predictedOutcome
      ? { confidence, predictedOutcome }
      : undefined;
    await store.resolveDecision(decisionId, optionId, reasoning, prediction);

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
    }, sid);

    return c.json({ status: "resolved", decisionId });
  });

  // Approve/revise/reject a plan from the web UI
  app.post("/api/artifacts/:artifactId/status", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
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
      broadcast({ type: "comment_added", comment }, sid);
    }

    // When a non-decision artifact is rejected, remember the approach so
    // pre-flight blocks any future re-proposal. Description is the artifact
    // title; reason is the feedback comment (required client-side).
    if (status === "rejected") {
      const artifacts = await store.getArtifacts();
      const artifact = artifacts.find((a) => a.id === artifactId);
      if (artifact && artifact.type !== "decision") {
        await store.recordRejectedApproach(
          artifact.title,
          feedback?.trim() || undefined,
          artifactId,
        );
      }
    }

    broadcast({ type: "artifact_updated", artifactId, status }, sid);

    return c.json({ status: "updated", artifactId });
  });

  // Rename an artifact
  app.post("/api/artifacts/:artifactId/rename", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    const artifactId = c.req.param("artifactId");
    const body = await c.req.json();
    const { title } = body;
    if (!title || typeof title !== "string") {
      return c.json({ error: "title required" }, 400);
    }
    await store.renameArtifact(artifactId, title.trim());
    broadcast({ type: "artifact_renamed", artifactId, title: title.trim() }, sid);
    return c.json({ status: "renamed", artifactId });
  });

  // Get comments for an artifact
  app.get("/api/artifacts/:artifactId/comments", async (c) => {
    const store = getStore(getSessionId(c));
    const artifactId = c.req.param("artifactId");
    return c.json({ comments: await store.getCommentsForArtifact(artifactId) });
  });

  // Export session as markdown
  app.get("/api/export", async (c) => {
    const store = getStore(getSessionId(c));
    const format = (c.req.query("format") ?? "full") as "full" | "pr-description" | "pr-review" | "adr" | "replay";
    const state = await store.getFullState();
    const markdown = formatSessionMarkdown(state, format);
    return c.text(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  // Set preferences (autonomy level, etc.)
  app.post("/api/preferences", async (c) => {
    const sid = getSessionId(c);
    const store = getStore(sid);
    const body = await c.req.json();
    if (body.autonomyLevel) {
      await store.setAutonomyLevel(body.autonomyLevel);
      broadcast({ type: "preference_changed", autonomyLevel: body.autonomyLevel }, sid);
    }
    return c.json({ status: "updated" });
  });

  // Read a project file for the FileViewer
  app.get("/api/files", (c) => {
    const filePath = c.req.query("path");
    if (!filePath || !projectRoot) {
      return c.json({ error: "path parameter required" }, 400);
    }
    const resolved = path.resolve(projectRoot, filePath.startsWith("/") ? filePath.slice(1) : filePath);
    const resolvedRoot = path.resolve(projectRoot);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      return c.json({ error: "Path outside project root" }, 403);
    }
    try {
      const content = fs.readFileSync(resolved, "utf-8");
      return c.json({ content, filePath, lines: content.split("\n").length });
    } catch (err: any) {
      if (err?.code === "ENOENT") return c.json({ error: "File not found" }, 404);
      return c.json({ error: "Cannot read file" }, 500);
    }
  });

  // Get session memory (rejected approaches, approved patterns)
  app.get("/api/memory", async (c) => {
    const store = getStore(getSessionId(c));
    return c.json(await store.getSessionMemory());
  });

  // List past sessions
  app.get("/api/sessions", (c) => {
    if (!projectRoot) return c.json({ sessions: [] });
    const sessions = FileStore.listSessions(projectRoot);
    return c.json({ sessions });
  });

  // Cross-session search
  app.get("/api/search", (c) => {
    if (!projectRoot) return c.json({ results: [] });
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ results: [] });
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const results = FileStore.searchAll(projectRoot, q, limit);
    return c.json({ results });
  });

  // Load a specific past session
  app.get("/api/sessions/:sessionId", (c) => {
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

  // --- Session annotations (learner's replay notes) ---

  app.get("/api/sessions/:sessionId/annotations", (c) => {
    const sessionId = c.req.param("sessionId");
    if (!projectRoot) return c.json({ annotations: [] });
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    try {
      const s = new FileStore(projectRoot, sessionId);
      return c.json({ annotations: s.getAnnotations() });
    } catch {
      return c.json({ annotations: [] });
    }
  });

  app.post("/api/sessions/:sessionId/annotations", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    const body = await c.req.json();
    const { targetEventId, note, tags } = body ?? {};
    if (!targetEventId || !note) {
      return c.json({ error: "targetEventId and note required" }, 400);
    }
    const s = new FileStore(projectRoot, sessionId);
    const annotation = s.addAnnotation({ targetEventId, note, tags });
    return c.json({ annotation });
  });

  // Save a re-pair prompt to .deeppairing/prompts/ so the developer can
  // reference it from their filesystem in a fresh Claude Code session.
  app.post("/api/prompts", async (c) => {
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    const body = await c.req.json();
    const content = typeof body?.content === "string" ? body.content : "";
    if (!content.trim()) return c.json({ error: "content required" }, 400);

    const sanitize = (s: unknown): string =>
      String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const decisionTag = sanitize(body?.decisionId);
    const sessionTag = sanitize(body?.sessionId);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = [ts, sessionTag, decisionTag].filter(Boolean).join("_") + ".md";

    const promptsDir = path.join(projectRoot, ".deeppairing", "prompts");
    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      const fullPath = path.join(promptsDir, filename);
      // Final safety: resolve and ensure the write stays inside promptsDir
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(promptsDir) + path.sep)) {
        return c.json({ error: "invalid path" }, 400);
      }
      fs.writeFileSync(resolved, content, "utf-8");
      const relPath = path.relative(projectRoot, resolved);
      return c.json({ status: "saved", path: resolved, relPath });
    } catch (err: any) {
      return c.json({ error: err?.message ?? "Save failed" }, 500);
    }
  });

  app.delete("/api/sessions/:sessionId/annotations/:annotationId", (c) => {
    const sessionId = c.req.param("sessionId");
    const annotationId = c.req.param("annotationId");
    if (!projectRoot) return c.json({ error: "No project root" }, 500);
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    const s = new FileStore(projectRoot, sessionId);
    const ok = s.deleteAnnotation(annotationId);
    return c.json({ deleted: ok });
  });

  return app;
}
