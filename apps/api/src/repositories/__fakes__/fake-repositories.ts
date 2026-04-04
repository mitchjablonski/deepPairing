import type {
  SessionRecord,
  EventRecord,
  DecisionRecord,
  ArtifactRecord,
  CommentRecord,
  SessionRepository,
  EventRepository,
  DecisionRepository,
  ArtifactRepository,
  CommentRepository,
} from "../types.js";

export class FakeSessionRepository implements SessionRepository {
  private sessions = new Map<string, SessionRecord>();

  async create(
    session: Omit<SessionRecord, "createdAt" | "updatedAt">,
  ): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = { ...session, createdAt: now, updatedAt: now };
    this.sessions.set(record.id, record);
    return record;
  }

  async getById(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async list(limit = 50): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async updateStatus(id: string, status: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
      session.updatedAt = new Date().toISOString();
    }
  }

  async updateAgentSessionId(id: string, agentSessionId: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.agentSessionId = agentSessionId;
      session.updatedAt = new Date().toISOString();
    }
  }
}

export class FakeEventRepository implements EventRepository {
  private events: EventRecord[] = [];

  async append(event: Omit<EventRecord, "createdAt">): Promise<EventRecord> {
    const record: EventRecord = { ...event, createdAt: new Date().toISOString() };
    this.events.push(record);
    return record;
  }

  async getBySession(sessionId: string, limit = 500): Promise<EventRecord[]> {
    return this.events
      .filter((e) => e.sessionId === sessionId)
      .slice(0, limit);
  }
}

export class FakeDecisionRepository implements DecisionRepository {
  private decisions = new Map<string, DecisionRecord>();

  async create(
    decision: Omit<DecisionRecord, "createdAt" | "resolvedAt">,
  ): Promise<DecisionRecord> {
    const record: DecisionRecord = {
      ...decision,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.decisions.set(record.id, record);
    return record;
  }

  async getById(id: string): Promise<DecisionRecord | null> {
    return this.decisions.get(id) ?? null;
  }

  async getBySession(sessionId: string): Promise<DecisionRecord[]> {
    return Array.from(this.decisions.values())
      .filter((d) => d.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async resolve(
    id: string,
    selectedOptionId: string,
    humanReasoning?: string,
  ): Promise<void> {
    const decision = this.decisions.get(id);
    if (decision) {
      decision.selectedOptionId = selectedOptionId;
      decision.humanReasoning = humanReasoning ?? null;
      decision.status = "resolved";
      decision.resolvedAt = new Date().toISOString();
    }
  }
}

export class FakeArtifactRepository implements ArtifactRepository {
  private artifacts = new Map<string, ArtifactRecord>();

  async create(
    artifact: Omit<ArtifactRecord, "createdAt" | "updatedAt">,
  ): Promise<ArtifactRecord> {
    const now = new Date().toISOString();
    const record: ArtifactRecord = { ...artifact, createdAt: now, updatedAt: now };
    this.artifacts.set(record.id, record);
    return record;
  }

  async getById(id: string): Promise<ArtifactRecord | null> {
    return this.artifacts.get(id) ?? null;
  }

  async getBySession(sessionId: string): Promise<ArtifactRecord[]> {
    return Array.from(this.artifacts.values())
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateStatus(id: string, status: string): Promise<void> {
    const artifact = this.artifacts.get(id);
    if (artifact) {
      artifact.status = status;
      artifact.updatedAt = new Date().toISOString();
    }
  }
}

export class FakeCommentRepository implements CommentRepository {
  private comments: CommentRecord[] = [];

  async create(comment: Omit<CommentRecord, "createdAt">): Promise<CommentRecord> {
    const record: CommentRecord = { ...comment, createdAt: new Date().toISOString() };
    this.comments.push(record);
    return record;
  }

  async getByArtifact(artifactId: string): Promise<CommentRecord[]> {
    return this.comments
      .filter((c) => c.artifactId === artifactId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getBySession(sessionId: string): Promise<CommentRecord[]> {
    return this.comments.filter((c) => c.sessionId === sessionId);
  }

  async getUnacknowledged(sessionId: string): Promise<CommentRecord[]> {
    return this.comments.filter(
      (c) => c.sessionId === sessionId && !c.acknowledged,
    );
  }

  async acknowledge(ids: string[]): Promise<void> {
    for (const comment of this.comments) {
      if (ids.includes(comment.id)) {
        comment.acknowledged = true;
      }
    }
  }
}
