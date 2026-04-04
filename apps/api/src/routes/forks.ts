import { Hono } from "hono";
import { z } from "zod";
import type { ForkManager } from "../services/fork-manager.js";
import type { SessionStore } from "../services/session-store.js";

const ForkRequestSchema = z.object({
  optionId: z.string(),
  optionTitle: z.string(),
});

export function createForkRoutes(
  forkManager: ForkManager,
  sessionStore: SessionStore,
) {
  const router = new Hono();

  router.post("/api/sessions/:sessionId/decisions/:decisionId/fork", async (c) => {
    const sessionId = c.req.param("sessionId");
    const decisionId = c.req.param("decisionId");

    const session = sessionStore.get(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = await c.req.json();
    const parsed = ForkRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const fork = await forkManager.createFork({
      parentSessionId: sessionId,
      decisionId,
      optionId: parsed.data.optionId,
      optionTitle: parsed.data.optionTitle,
      cwd: "/tmp", // In real usage, this comes from the session
      originalPrompt: "Explore alternative",
    });

    return c.json({
      forkId: fork.id,
      status: fork.status,
    });
  });

  router.get("/api/sessions/:sessionId/forks", (c) => {
    const sessionId = c.req.param("sessionId");
    const forks = forkManager.getForksForSession(sessionId);
    return c.json({
      forks: forks.map((f) => ({
        id: f.id,
        decisionId: f.decisionId,
        optionId: f.optionId,
        status: f.status,
        eventCount: f.events.length,
      })),
    });
  });

  router.get("/api/forks/:forkId", (c) => {
    const forkId = c.req.param("forkId");
    const fork = forkManager.getFork(forkId);

    if (!fork) {
      return c.json({ error: "Fork not found" }, 404);
    }

    return c.json({
      id: fork.id,
      decisionId: fork.decisionId,
      optionId: fork.optionId,
      status: fork.status,
      events: fork.events,
      worktreePath: fork.worktree?.path ?? null,
    });
  });

  router.get("/api/forks/:forkId/diff", async (c) => {
    const forkId = c.req.param("forkId");
    const fork = forkManager.getFork(forkId);

    if (!fork) {
      return c.json({ error: "Fork not found" }, 404);
    }

    const diff = await forkManager.getDiff(forkId, "/tmp");
    return c.json({ diff });
  });

  router.delete("/api/forks/:forkId", async (c) => {
    const forkId = c.req.param("forkId");
    await forkManager.cleanup(forkId);
    return c.json({ status: "deleted" });
  });

  return router;
}
