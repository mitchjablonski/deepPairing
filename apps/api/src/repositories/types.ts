import type { AgentEvent } from "@deeppairing/shared";

export interface SessionRecord {
  id: string;
  status: string;
  prompt: string;
  cwd: string;
  agentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface EventRecord {
  id: string;
  sessionId: string;
  type: string;
  data: AgentEvent;
  createdAt: string;
}

export interface DecisionRecord {
  id: string;
  sessionId: string;
  parentDecisionId: string | null;
  context: string;
  options: unknown;
  selectedOptionId: string | null;
  humanReasoning: string | null;
  agentReasoning: unknown | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SessionRepository {
  create(session: Omit<SessionRecord, "createdAt" | "updatedAt">): Promise<SessionRecord>;
  getById(id: string): Promise<SessionRecord | null>;
  list(limit?: number): Promise<SessionRecord[]>;
  updateStatus(id: string, status: string): Promise<void>;
  updateAgentSessionId(id: string, agentSessionId: string): Promise<void>;
}

export interface EventRepository {
  append(event: Omit<EventRecord, "createdAt">): Promise<EventRecord>;
  getBySession(sessionId: string, limit?: number): Promise<EventRecord[]>;
}

export interface DecisionRepository {
  create(decision: Omit<DecisionRecord, "createdAt" | "resolvedAt">): Promise<DecisionRecord>;
  getById(id: string): Promise<DecisionRecord | null>;
  getBySession(sessionId: string): Promise<DecisionRecord[]>;
  resolve(id: string, selectedOptionId: string, humanReasoning?: string): Promise<void>;
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  type: string;
  version: number;
  parentId: string | null;
  title: string;
  status: string;
  content: Record<string, unknown>;
  agentReasoning: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentRecord {
  id: string;
  sessionId: string;
  artifactId: string;
  lineNumber: number | null;
  findingIndex: number | null;
  stepIndex: number | null;
  sectionId: string | null;
  parentCommentId: string | null;
  author: string;
  content: string;
  acknowledged: boolean;
  createdAt: string;
}

export interface ArtifactRepository {
  create(artifact: Omit<ArtifactRecord, "createdAt" | "updatedAt">): Promise<ArtifactRecord>;
  getById(id: string): Promise<ArtifactRecord | null>;
  getBySession(sessionId: string): Promise<ArtifactRecord[]>;
  updateStatus(id: string, status: string): Promise<void>;
}

export interface CommentRepository {
  create(comment: Omit<CommentRecord, "createdAt">): Promise<CommentRecord>;
  getByArtifact(artifactId: string): Promise<CommentRecord[]>;
  getBySession(sessionId: string): Promise<CommentRecord[]>;
  getUnacknowledged(sessionId: string): Promise<CommentRecord[]>;
  acknowledge(ids: string[]): Promise<void>;
}
