import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { Artifact, ArtifactType, ArtifactStatus, Comment } from "@deeppairing/shared";
import type { ArtifactRepository, CommentRepository } from "../repositories/types.js";
import { emitAgentEvent, AGENT_EVENTS } from "./agent-types.js";

export class ArtifactStore {
  private artifactRepo: ArtifactRepository;
  private commentRepo: CommentRepository;
  private emitter: EventEmitter | null = null;
  private sessionId: string | null = null;

  constructor(artifactRepo: ArtifactRepository, commentRepo: CommentRepository) {
    this.artifactRepo = artifactRepo;
    this.commentRepo = commentRepo;
  }

  /** Bind to a session for event emission */
  bind(sessionId: string, emitter: EventEmitter): void {
    this.sessionId = sessionId;
    this.emitter = emitter;
  }

  async createArtifact(params: {
    type: ArtifactType;
    title: string;
    content: Record<string, unknown>;
    agentReasoning?: string;
  }): Promise<Artifact> {
    const id = `art_${nanoid(10)}`;
    const now = new Date().toISOString();

    const record = await this.artifactRepo.create({
      id,
      sessionId: this.sessionId!,
      type: params.type,
      version: 1,
      parentId: null,
      title: params.title,
      status: "draft",
      content: params.content,
      agentReasoning: params.agentReasoning ?? null,
    });

    const artifact: Artifact = {
      id: record.id,
      sessionId: record.sessionId,
      type: record.type as ArtifactType,
      version: record.version,
      parentId: record.parentId,
      title: record.title,
      status: record.status as ArtifactStatus,
      content: record.content,
      agentReasoning: record.agentReasoning,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };

    this.emit({ type: "artifact_created", artifact });
    return artifact;
  }

  async updateStatus(
    artifactId: string,
    status: ArtifactStatus,
    feedback?: string,
  ): Promise<void> {
    await this.artifactRepo.updateStatus(artifactId, status);

    this.emit({
      type: "artifact_updated",
      artifactId,
      status,
    });

    // If revised, the feedback becomes a comment
    if (feedback && status === "revised") {
      await this.addComment({
        artifactId,
        content: feedback,
        author: "human",
      });
    }
  }

  async createVersion(
    parentId: string,
    content: Record<string, unknown>,
    agentReasoning?: string,
  ): Promise<Artifact> {
    const parent = await this.artifactRepo.getById(parentId);
    if (!parent) throw new Error(`Artifact ${parentId} not found`);

    // Supersede the parent
    await this.artifactRepo.updateStatus(parentId, "superseded");

    const id = `art_${nanoid(10)}`;
    const record = await this.artifactRepo.create({
      id,
      sessionId: parent.sessionId,
      type: parent.type,
      version: parent.version + 1,
      parentId,
      title: parent.title,
      status: "draft",
      content,
      agentReasoning: agentReasoning ?? null,
    });

    const artifact: Artifact = {
      id: record.id,
      sessionId: record.sessionId,
      type: record.type as ArtifactType,
      version: record.version,
      parentId: record.parentId,
      title: record.title,
      status: record.status as ArtifactStatus,
      content: record.content,
      agentReasoning: record.agentReasoning,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };

    this.emit({ type: "artifact_created", artifact });
    return artifact;
  }

  async addComment(params: {
    artifactId: string;
    content: string;
    author: "human" | "agent";
    lineNumber?: number;
    findingIndex?: number;
    stepIndex?: number;
    sectionId?: string;
    parentCommentId?: string;
  }): Promise<Comment> {
    const id = `cmt_${nanoid(10)}`;
    const now = new Date().toISOString();

    const record = await this.commentRepo.create({
      id,
      sessionId: this.sessionId!,
      artifactId: params.artifactId,
      lineNumber: params.lineNumber ?? null,
      findingIndex: params.findingIndex ?? null,
      stepIndex: params.stepIndex ?? null,
      sectionId: params.sectionId ?? null,
      parentCommentId: params.parentCommentId ?? null,
      author: params.author,
      content: params.content,
      acknowledged: params.author === "agent", // agent's own comments are pre-acknowledged
    });

    const comment: Comment = {
      id: record.id,
      sessionId: record.sessionId,
      target: {
        artifactId: record.artifactId,
        ...(record.lineNumber != null ? { lineNumber: record.lineNumber } : {}),
        ...(record.findingIndex != null ? { findingIndex: record.findingIndex } : {}),
        ...(record.stepIndex != null ? { stepIndex: record.stepIndex } : {}),
        ...(record.sectionId != null ? { sectionId: record.sectionId } : {}),
      },
      parentCommentId: record.parentCommentId,
      author: record.author as "human" | "agent",
      content: record.content,
      acknowledged: record.acknowledged,
      createdAt: record.createdAt,
    };

    this.emit({ type: "comment_added", comment });
    return comment;
  }

  async getUnacknowledgedComments(): Promise<Comment[]> {
    if (!this.sessionId) return [];
    const records = await this.commentRepo.getUnacknowledged(this.sessionId);
    return records.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      target: {
        artifactId: r.artifactId,
        ...(r.lineNumber != null ? { lineNumber: r.lineNumber } : {}),
        ...(r.findingIndex != null ? { findingIndex: r.findingIndex } : {}),
        ...(r.stepIndex != null ? { stepIndex: r.stepIndex } : {}),
        ...(r.sectionId != null ? { sectionId: r.sectionId } : {}),
      },
      parentCommentId: r.parentCommentId,
      author: r.author as "human" | "agent",
      content: r.content,
      acknowledged: r.acknowledged,
      createdAt: r.createdAt,
    }));
  }

  async acknowledgeComments(ids: string[]): Promise<void> {
    await this.commentRepo.acknowledge(ids);
  }

  async getArtifactsBySession(): Promise<Artifact[]> {
    if (!this.sessionId) return [];
    const records = await this.artifactRepo.getBySession(this.sessionId);
    return records.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      type: r.type as ArtifactType,
      version: r.version,
      parentId: r.parentId,
      title: r.title,
      status: r.status as ArtifactStatus,
      content: r.content,
      agentReasoning: r.agentReasoning,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async getCommentsForArtifact(artifactId: string): Promise<Comment[]> {
    const records = await this.commentRepo.getByArtifact(artifactId);
    return records.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      target: {
        artifactId: r.artifactId,
        ...(r.lineNumber != null ? { lineNumber: r.lineNumber } : {}),
        ...(r.findingIndex != null ? { findingIndex: r.findingIndex } : {}),
        ...(r.stepIndex != null ? { stepIndex: r.stepIndex } : {}),
        ...(r.sectionId != null ? { sectionId: r.sectionId } : {}),
      },
      parentCommentId: r.parentCommentId,
      author: r.author as "human" | "agent",
      content: r.content,
      acknowledged: r.acknowledged,
      createdAt: r.createdAt,
    }));
  }

  private emit(event: any): void {
    if (this.emitter) {
      this.emitter.emit(AGENT_EVENTS.event, event);
    }
  }
}
