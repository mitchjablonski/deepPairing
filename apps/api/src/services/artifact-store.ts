import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { Artifact, ArtifactType, ArtifactStatus, Comment } from "@deeppairing/shared";
import type { ArtifactRepository, CommentRepository } from "../repositories/types.js";
import { AGENT_EVENTS } from "./agent-types.js";

/**
 * Session-aware artifact store. Supports multiple concurrent sessions.
 * Each session registers its emitter via registerSession(). Events are
 * emitted to the correct session's emitter based on the artifact's sessionId.
 */
export class ArtifactStore {
  private artifactRepo: ArtifactRepository;
  private commentRepo: CommentRepository;
  private emitters = new Map<string, EventEmitter>();

  constructor(artifactRepo: ArtifactRepository, commentRepo: CommentRepository) {
    this.artifactRepo = artifactRepo;
    this.commentRepo = commentRepo;
  }

  /** Register a session's emitter for event dispatch */
  registerSession(sessionId: string, emitter: EventEmitter): void {
    this.emitters.set(sessionId, emitter);
  }

  /** Unregister a session (cleanup) */
  unregisterSession(sessionId: string): void {
    this.emitters.delete(sessionId);
  }

  /** @deprecated Use registerSession instead */
  bind(sessionId: string, emitter: EventEmitter): void {
    this.registerSession(sessionId, emitter);
  }

  async createArtifact(
    sessionId: string,
    params: {
      type: ArtifactType;
      title: string;
      content: Record<string, unknown>;
      agentReasoning?: string;
    },
  ): Promise<Artifact> {
    const id = `art_${nanoid(10)}`;

    const record = await this.artifactRepo.create({
      id,
      sessionId,
      type: params.type,
      version: 1,
      parentId: null,
      title: params.title,
      status: "draft",
      content: params.content,
      agentReasoning: params.agentReasoning ?? null,
    });

    const artifact = this.toArtifact(record);
    this.emitTo(sessionId, { type: "artifact_created", artifact });
    return artifact;
  }

  async updateStatus(
    artifactId: string,
    status: ArtifactStatus,
    feedback?: string,
  ): Promise<void> {
    const artifact = await this.artifactRepo.getById(artifactId);
    await this.artifactRepo.updateStatus(artifactId, status);

    if (artifact) {
      this.emitTo(artifact.sessionId, {
        type: "artifact_updated",
        artifactId,
        status,
      });
    }

    if (feedback && status === "revised" && artifact) {
      await this.addComment(artifact.sessionId, {
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

    const artifact = this.toArtifact(record);
    this.emitTo(parent.sessionId, { type: "artifact_created", artifact });
    return artifact;
  }

  async addComment(
    sessionId: string,
    params: {
      artifactId: string;
      content: string;
      author: "human" | "agent";
      lineNumber?: number;
      findingIndex?: number;
      stepIndex?: number;
      sectionId?: string;
      parentCommentId?: string;
    },
  ): Promise<Comment> {
    const id = `cmt_${nanoid(10)}`;

    const record = await this.commentRepo.create({
      id,
      sessionId,
      artifactId: params.artifactId,
      lineNumber: params.lineNumber ?? null,
      findingIndex: params.findingIndex ?? null,
      stepIndex: params.stepIndex ?? null,
      sectionId: params.sectionId ?? null,
      parentCommentId: params.parentCommentId ?? null,
      author: params.author,
      content: params.content,
      acknowledged: params.author === "agent",
    });

    const comment = this.toComment(record);
    this.emitTo(sessionId, { type: "comment_added", comment });
    return comment;
  }

  async getUnacknowledgedComments(sessionId: string): Promise<Comment[]> {
    const records = await this.commentRepo.getUnacknowledged(sessionId);
    return records.map((r) => this.toComment(r));
  }

  async acknowledgeComments(ids: string[]): Promise<void> {
    await this.commentRepo.acknowledge(ids);
  }

  async getArtifactsBySession(sessionId: string): Promise<Artifact[]> {
    const records = await this.artifactRepo.getBySession(sessionId);
    return records.map((r) => this.toArtifact(r));
  }

  async getCommentsForArtifact(artifactId: string): Promise<Comment[]> {
    const records = await this.commentRepo.getByArtifact(artifactId);
    return records.map((r) => this.toComment(r));
  }

  private toArtifact(record: any): Artifact {
    return {
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
  }

  private toComment(r: any): Comment {
    return {
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
    };
  }

  private emitTo(sessionId: string, event: any): void {
    const emitter = this.emitters.get(sessionId);
    if (emitter) {
      emitter.emit(AGENT_EVENTS.event, event);
    }
  }
}
