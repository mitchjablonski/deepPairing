import type { Artifact, Comment, DecisionResponse } from "@deeppairing/shared";

/**
 * Dependencies injected into the MCP server.
 * These are interfaces so we can use fakes for testing.
 */
export interface McpDependencies {
  artifactStore: ArtifactStoreInterface;
  decisionManager: DecisionManagerInterface;
}

export interface ArtifactStoreInterface {
  createArtifact(params: {
    type: Artifact["type"];
    title: string;
    content: Record<string, unknown>;
    agentReasoning?: string;
  }): Promise<Artifact>;

  addComment(params: {
    artifactId: string;
    content: string;
    author: "human" | "agent";
  }): Promise<Comment>;

  getUnacknowledgedComments(): Promise<Comment[]>;
  acknowledgeComments(ids: string[]): Promise<void>;
  getArtifactsBySession(): Promise<Artifact[]>;
}

export interface DecisionManagerInterface {
  createPendingDecision(
    decisionId: string,
    optionIds: string[],
  ): Promise<DecisionResponse>;
}

/**
 * Callback for plan review — blocks until human responds.
 * Resolves with { verdict: "approved" | "revised" | "rejected", feedback?: string }
 */
export interface PlanReviewResult {
  verdict: "approved" | "revised" | "rejected";
  feedback?: string;
}

export type PlanReviewCallback = (
  artifactId: string,
) => Promise<PlanReviewResult>;
