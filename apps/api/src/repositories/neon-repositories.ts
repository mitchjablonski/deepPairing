import { getDb } from "../db/client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
function asRows(result: unknown): Row[] {
  return result as Row[];
}
import type {
  SessionRecord,
  EventRecord,
  DecisionRecord,
  SessionRepository,
  EventRepository,
  DecisionRepository,
} from "./types.js";

export class NeonSessionRepository implements SessionRepository {
  async create(
    session: Omit<SessionRecord, "createdAt" | "updatedAt">,
  ): Promise<SessionRecord> {
    const sql = getDb();
    const rows = asRows(await sql`
      INSERT INTO sessions (id, status, prompt, cwd, agent_session_id, metadata)
      VALUES (${session.id}, ${session.status}, ${session.prompt}, ${session.cwd},
              ${session.agentSessionId}, ${JSON.stringify(session.metadata)})
      RETURNING id, status, prompt, cwd, agent_session_id as "agentSessionId",
                created_at as "createdAt", updated_at as "updatedAt", metadata
    `);
    return rows[0] as SessionRecord;
  }

  async getById(id: string): Promise<SessionRecord | null> {
    const sql = getDb();
    const rows = asRows(await sql`
      SELECT id, status, prompt, cwd, agent_session_id as "agentSessionId",
             created_at as "createdAt", updated_at as "updatedAt", metadata
      FROM sessions WHERE id = ${id}
    `);
    return (rows[0] as SessionRecord) ?? null;
  }

  async list(limit = 50): Promise<SessionRecord[]> {
    const sql = getDb();
    const rows = asRows(await sql`
      SELECT id, status, prompt, cwd, agent_session_id as "agentSessionId",
             created_at as "createdAt", updated_at as "updatedAt", metadata
      FROM sessions ORDER BY created_at DESC LIMIT ${limit}
    `);
    return rows as SessionRecord[];
  }

  async updateStatus(id: string, status: string): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE sessions SET status = ${status}, updated_at = NOW() WHERE id = ${id}
    `;
  }

  async updateAgentSessionId(id: string, agentSessionId: string): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE sessions SET agent_session_id = ${agentSessionId}, updated_at = NOW()
      WHERE id = ${id}
    `;
  }
}

export class NeonEventRepository implements EventRepository {
  async append(event: Omit<EventRecord, "createdAt">): Promise<EventRecord> {
    const sql = getDb();
    const rows = asRows(await sql`
      INSERT INTO events (id, session_id, type, data)
      VALUES (${event.id}, ${event.sessionId}, ${event.type}, ${JSON.stringify(event.data)})
      RETURNING id, session_id as "sessionId", type, data, created_at as "createdAt"
    `);
    return rows[0] as EventRecord;
  }

  async getBySession(sessionId: string, limit = 500): Promise<EventRecord[]> {
    const sql = getDb();
    const rows = asRows(await sql`
      SELECT id, session_id as "sessionId", type, data, created_at as "createdAt"
      FROM events WHERE session_id = ${sessionId}
      ORDER BY created_at ASC LIMIT ${limit}
    `);
    return rows as EventRecord[];
  }
}

export class NeonDecisionRepository implements DecisionRepository {
  async create(
    decision: Omit<DecisionRecord, "createdAt" | "resolvedAt">,
  ): Promise<DecisionRecord> {
    const sql = getDb();
    const rows = asRows(await sql`
      INSERT INTO decisions (id, session_id, parent_decision_id, context, options,
                            selected_option_id, human_reasoning, agent_reasoning, status)
      VALUES (${decision.id}, ${decision.sessionId}, ${decision.parentDecisionId},
              ${decision.context}, ${JSON.stringify(decision.options)},
              ${decision.selectedOptionId}, ${decision.humanReasoning},
              ${decision.agentReasoning ? JSON.stringify(decision.agentReasoning) : null},
              ${decision.status})
      RETURNING id, session_id as "sessionId", parent_decision_id as "parentDecisionId",
                context, options, selected_option_id as "selectedOptionId",
                human_reasoning as "humanReasoning", agent_reasoning as "agentReasoning",
                status, created_at as "createdAt", resolved_at as "resolvedAt"
    `);
    return rows[0] as DecisionRecord;
  }

  async getById(id: string): Promise<DecisionRecord | null> {
    const sql = getDb();
    const rows = asRows(await sql`
      SELECT id, session_id as "sessionId", parent_decision_id as "parentDecisionId",
             context, options, selected_option_id as "selectedOptionId",
             human_reasoning as "humanReasoning", agent_reasoning as "agentReasoning",
             status, created_at as "createdAt", resolved_at as "resolvedAt"
      FROM decisions WHERE id = ${id}
    `);
    return (rows[0] as DecisionRecord) ?? null;
  }

  async getBySession(sessionId: string): Promise<DecisionRecord[]> {
    const sql = getDb();
    const rows = asRows(await sql`
      SELECT id, session_id as "sessionId", parent_decision_id as "parentDecisionId",
             context, options, selected_option_id as "selectedOptionId",
             human_reasoning as "humanReasoning", agent_reasoning as "agentReasoning",
             status, created_at as "createdAt", resolved_at as "resolvedAt"
      FROM decisions WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    `);
    return rows as DecisionRecord[];
  }

  async resolve(
    id: string,
    selectedOptionId: string,
    humanReasoning?: string,
  ): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE decisions
      SET selected_option_id = ${selectedOptionId},
          human_reasoning = ${humanReasoning ?? null},
          status = 'resolved',
          resolved_at = NOW()
      WHERE id = ${id}
    `;
  }
}
