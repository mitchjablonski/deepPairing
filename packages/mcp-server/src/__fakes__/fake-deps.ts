import type { Artifact, Comment, DecisionResponse } from "@deeppairing/shared";
import type { ArtifactStoreInterface, DecisionManagerInterface, PlanReviewResult } from "../types.js";

let artifactCounter = 0;
let commentCounter = 0;

/**
 * Fake artifact store for MCP tool testing.
 * Note: MCP tools use the session-bound wrapper (bindStoreToSession)
 * which strips sessionId. But this fake also implements the full
 * interface for direct testing.
 */
export class FakeMcpArtifactStore implements ArtifactStoreInterface {
  artifacts: Artifact[] = [];
  comments: Comment[] = [];

  async createArtifact(
    sessionId: string,
    params: {
      type: Artifact["type"];
      title: string;
      content: Record<string, unknown>;
      agentReasoning?: string;
    },
  ): Promise<Artifact> {
    const now = new Date().toISOString();
    const artifact: Artifact = {
      id: `art_fake_${++artifactCounter}`,
      sessionId,
      type: params.type,
      version: 1,
      parentId: null,
      title: params.title,
      status: "draft",
      content: params.content,
      agentReasoning: params.agentReasoning ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  async addComment(
    sessionId: string,
    params: {
      artifactId: string;
      content: string;
      author: "human" | "agent";
    },
  ): Promise<Comment> {
    const comment: Comment = {
      id: `cmt_fake_${++commentCounter}`,
      sessionId,
      target: { artifactId: params.artifactId },
      parentCommentId: null,
      author: params.author,
      content: params.content,
      acknowledged: params.author === "agent",
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    return comment;
  }

  async getUnacknowledgedComments(sessionId: string): Promise<Comment[]> {
    return this.comments.filter((c) => !c.acknowledged && c.sessionId === sessionId);
  }

  async acknowledgeComments(ids: string[]): Promise<void> {
    for (const c of this.comments) {
      if (ids.includes(c.id)) c.acknowledged = true;
    }
  }

  async getArtifactsBySession(sessionId: string): Promise<Artifact[]> {
    return this.artifacts.filter((a) => a.sessionId === sessionId);
  }
}

export class FakeMcpDecisionManager implements DecisionManagerInterface {
  private pendingResolvers = new Map<string, (response: DecisionResponse) => void>();
  autoResolveWith: DecisionResponse | null = null;

  async createPendingDecision(
    decisionId: string,
    optionIds: string[],
  ): Promise<DecisionResponse> {
    if (this.autoResolveWith) {
      return this.autoResolveWith;
    }

    return new Promise<DecisionResponse>((resolve) => {
      this.pendingResolvers.set(decisionId, resolve);
    });
  }

  resolve(decisionId: string, response: DecisionResponse): void {
    const resolver = this.pendingResolvers.get(decisionId);
    if (resolver) {
      resolver(response);
      this.pendingResolvers.delete(decisionId);
    }
  }
}

export function createFakePlanReview(
  autoResult?: PlanReviewResult,
): {
  callback: (artifactId: string) => Promise<PlanReviewResult>;
  resolve: (result: PlanReviewResult) => void;
  reviewedArtifactIds: string[];
} {
  let pendingResolve: ((result: PlanReviewResult) => void) | null = null;
  const reviewedArtifactIds: string[] = [];

  return {
    callback: async (artifactId: string) => {
      reviewedArtifactIds.push(artifactId);
      if (autoResult) return autoResult;
      return new Promise<PlanReviewResult>((resolve) => {
        pendingResolve = resolve;
      });
    },
    resolve: (result: PlanReviewResult) => {
      if (pendingResolve) {
        pendingResolve(result);
        pendingResolve = null;
      }
    },
    reviewedArtifactIds,
  };
}
