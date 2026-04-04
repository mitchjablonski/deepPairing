import type { Artifact, Comment, DecisionResponse } from "@deeppairing/shared";

/**
 * Dependencies injected into the MCP server.
 * These are interfaces so we can use fakes for testing.
 */
export interface McpDependencies {
  sessionId: string;
  artifactStore: ArtifactStoreInterface;
  decisionManager: DecisionManagerInterface;
}

export interface ArtifactStoreInterface {
  createArtifact(
    sessionId: string,
    params: {
      type: Artifact["type"];
      title: string;
      content: Record<string, unknown>;
      agentReasoning?: string;
    },
  ): Promise<Artifact>;

  addComment(
    sessionId: string,
    params: {
      artifactId: string;
      content: string;
      author: "human" | "agent";
    },
  ): Promise<Comment>;

  getUnacknowledgedComments(sessionId: string): Promise<Comment[]>;
  acknowledgeComments(ids: string[]): Promise<void>;
  getArtifactsBySession(sessionId: string): Promise<Artifact[]>;
}

export interface DecisionManagerInterface {
  createPendingDecision(
    decisionId: string,
    optionIds: string[],
  ): Promise<DecisionResponse>;
}

export interface PlanReviewResult {
  verdict: "approved" | "revised" | "rejected";
  feedback?: string;
}

export type PlanReviewCallback = (
  artifactId: string,
) => Promise<PlanReviewResult>;
