import { Hono } from "hono";
import { DecisionResponseSchema } from "@deeppairing/shared";
import type { DecisionManager } from "../services/decision-manager.js";
import type { SessionStore } from "../services/session-store.js";

export function createDecisionRoutes(
  decisionManager: DecisionManager,
  sessionStore?: SessionStore,
) {
  const router = new Hono();

  router.post("/api/sessions/:sessionId/decisions/:decisionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const decisionId = c.req.param("decisionId");

    if (!decisionManager.isPending(decisionId)) {
      return c.json({ error: "No pending decision found" }, 404);
    }

    const body = await c.req.json();
    const parsed = DecisionResponseSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    try {
      decisionManager.resolveDecision(decisionId, parsed.data);

      // Notify the session emitter so the fake agent can continue
      const session = sessionStore?.get(sessionId);
      if (session) {
        session.emitter.emit("decision:resolved", parsed.data);
      }

      return c.json({ status: "resolved", decisionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: message }, 400);
    }
  });

  router.get("/api/sessions/:sessionId/decisions/pending", (c) => {
    const pendingIds = decisionManager.getPendingIds();
    return c.json({ pending: pendingIds });
  });

  return router;
}
