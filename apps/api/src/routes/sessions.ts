import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import { CreateSessionRequestSchema } from "@deeppairing/shared";
import type { AgentEvent } from "@deeppairing/shared";
import type { AgentService } from "../services/agent-types.js";
import { AGENT_EVENTS, onAgentEvent } from "../services/agent-types.js";
import { SessionStore } from "../services/session-store.js";
import type { SessionRepository, EventRepository, DecisionRepository } from "../repositories/types.js";

export interface SessionRouteDeps {
  agentService: AgentService;
  sessionStore: SessionStore;
  sessionRepo?: SessionRepository;
  eventRepo?: EventRepository;
  decisionRepo?: DecisionRepository;
}

export function createSessionRoutes(
  agentService: AgentService,
  sessionStore: SessionStore,
  deps?: Partial<SessionRouteDeps>,
) {
  const { sessionRepo, eventRepo, decisionRepo } = deps ?? {};
  const router = new Hono();

  router.post("/api/sessions", async (c) => {
    const body = await c.req.json();
    const parsed = CreateSessionRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const sessionId = nanoid();
    const session = await agentService.startSession({
      prompt: parsed.data.prompt,
      cwd: parsed.data.cwd,
      sessionId,
    });

    sessionStore.set(session);

    return c.json({ sessionId: session.id });
  });

  router.get("/api/sessions/:id/stream", (c) => {
    const sessionId = c.req.param("id");
    const session = sessionStore.get(sessionId);

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      let eventId = 0;

      const sendEvent = async (event: AgentEvent) => {
        await stream.writeSSE({
          id: String(eventId++),
          event: event.type,
          data: JSON.stringify(event),
        });
      };

      // Send any buffered state first
      await stream.writeSSE({
        id: String(eventId++),
        event: "connected",
        data: JSON.stringify({
          sessionId,
          status: session.status,
        }),
      });

      // Replay buffered events (events emitted before SSE client connected)
      if (session.eventBuffer) {
        for (const bufferedEvent of session.eventBuffer) {
          await sendEvent(bufferedEvent);
        }
      }

      if (session.status === "completed" || session.status === "error") {
        await stream.writeSSE({
          id: String(eventId++),
          event: "done",
          data: JSON.stringify({ status: session.status }),
        });
        return;
      }

      // Stream events as they arrive
      const handler = (event: AgentEvent) => {
        sendEvent(event).catch(() => {
          // Stream closed by client
        });
      };

      onAgentEvent(session.emitter, handler);

      // Wait for completion
      await new Promise<void>((resolve) => {
        session.emitter.on(AGENT_EVENTS.done, () => {
          stream
            .writeSSE({
              id: String(eventId++),
              event: "done",
              data: JSON.stringify({ status: "completed" }),
            })
            .catch(() => {})
            .finally(resolve);
        });

        session.emitter.on(AGENT_EVENTS.error, () => {
          stream
            .writeSSE({
              id: String(eventId++),
              event: "done",
              data: JSON.stringify({ status: "error" }),
            })
            .catch(() => {})
            .finally(resolve);
        });

        stream.onAbort(() => {
          session.emitter.removeListener(AGENT_EVENTS.event, handler);
          resolve();
        });
      });
    });
  });

  router.post("/api/sessions/:id/stop", (c) => {
    const sessionId = c.req.param("id");
    const session = sessionStore.get(sessionId);

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    agentService.stopSession(sessionId);
    return c.json({ status: "stopped" });
  });

  // --- Persistence routes (require repositories) ---

  router.get("/api/sessions", async (c) => {
    if (!sessionRepo) {
      // Fallback: return in-memory sessions
      const sessions = sessionStore.list().map((s) => ({
        id: s.id,
        status: s.status,
      }));
      return c.json({ sessions });
    }

    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const sessions = await sessionRepo.list(limit);
    return c.json({ sessions });
  });

  router.get("/api/sessions/:id", async (c) => {
    const sessionId = c.req.param("id");

    if (!sessionRepo) {
      const session = sessionStore.get(sessionId);
      if (!session) return c.json({ error: "Session not found" }, 404);
      return c.json({ id: session.id, status: session.status });
    }

    const session = await sessionRepo.getById(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const decisions = decisionRepo
      ? await decisionRepo.getBySession(sessionId)
      : [];

    return c.json({ session, decisions });
  });

  return router;
}
