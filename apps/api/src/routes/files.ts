import { Hono } from "hono";
import type { FileCache } from "../services/file-cache.js";

export function createFileRoutes(fileCache: FileCache) {
  const router = new Hono();

  /** Get a cached file's content */
  router.get("/api/sessions/:sessionId/files", (c) => {
    const path = c.req.query("path");

    if (!path) {
      return c.json({ error: "path query parameter required" }, 400);
    }

    const file = fileCache.getFile(path);
    if (!file) {
      return c.json({ error: "File not cached — agent hasn't read it yet" }, 404);
    }

    return c.json(file);
  });

  /** Get a file with specific lines highlighted (for evidence viewing) */
  router.get("/api/sessions/:sessionId/files/highlight", (c) => {
    const path = c.req.query("path");
    const lineStart = parseInt(c.req.query("lineStart") ?? "0", 10);
    const lineEnd = parseInt(c.req.query("lineEnd") ?? "0", 10);

    if (!path) {
      return c.json({ error: "path query parameter required" }, 400);
    }

    const result = fileCache.getFileWithHighlight(path, lineStart, lineEnd);
    if (!result) {
      return c.json({ error: "File not cached" }, 404);
    }

    return c.json(result);
  });

  /** List all cached file paths */
  router.get("/api/sessions/:sessionId/files/list", (c) => {
    return c.json({ paths: fileCache.getAllPaths() });
  });

  return router;
}
