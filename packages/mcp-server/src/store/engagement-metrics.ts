import type { Artifact, Comment } from "@deeppairing/shared";
import type { DecisionRecord } from "./store-interface.js";

export interface EngagementMetrics {
  avgReviewLatencyMs: number;
  commentDensity: number;
  approvalRate: number;
  reviewsByType: Record<string, { avgLatencyMs: number; count: number }>;
  decisionsWithPredictions: number;
  highStakesDecisions: number;
}

/**
 * Pure computation over a FileStore's in-memory session state — extracted
 * so the metrics math is testable/readable without the class plumbing.
 * FileStore.getEngagementMetrics delegates here.
 */
export function computeEngagementMetrics(state: {
  artifacts: Artifact[];
  comments: Comment[];
  decisions: Iterable<DecisionRecord>;
  reviewLatencies: Array<{ type: string; latencyMs: number }>;
}): EngagementMetrics {
  // FN4 — approvalRate = approved / (artifacts the human actually decided on).
  // Exclude draft (undecided) and the agent-driven terminal states
  // (superseded/retracted/obsolete) — they aren't human approve/reject calls,
  // so counting them in the denominator depressed the rate artificially.
  // Keep this status-set in sync with the reason-based recordArtifactReviewed
  // gate above (agent_*/demo_script there ↔ the agent terminal states here).
  const reviewed = state.artifacts.filter(
    (a) => a.status !== "draft" && a.status !== "superseded" && a.status !== "retracted" && a.status !== "obsolete",
  );
  const approved = state.artifacts.filter((a) => a.status === "approved");
  const approvalRate = reviewed.length > 0 ? approved.length / reviewed.length : 1;

  const humanComments = state.comments.filter((c) => c.author === "human" && c.target.artifactId !== "__session__");
  const commentDensity = state.artifacts.length > 0 ? humanComments.length / state.artifacts.length : 0;

  const avgReviewLatencyMs = state.reviewLatencies.length > 0
    ? state.reviewLatencies.reduce((sum, r) => sum + r.latencyMs, 0) / state.reviewLatencies.length
    : 0;

  // Per-type breakdown
  const reviewsByType: Record<string, { totalMs: number; count: number }> = {};
  for (const r of state.reviewLatencies) {
    const entry = reviewsByType[r.type] ?? { totalMs: 0, count: 0 };
    entry.totalMs += r.latencyMs;
    entry.count += 1;
    reviewsByType[r.type] = entry;
  }
  const typeSummary: Record<string, { avgLatencyMs: number; count: number }> = {};
  for (const [type, data] of Object.entries(reviewsByType)) {
    typeSummary[type] = { avgLatencyMs: Math.round(data.totalMs / data.count), count: data.count };
  }

  // K2: craft-development signals — how often the user captures predictions
  // and how often the agent flags decisions as high-stakes.
  let decisionsWithPredictions = 0;
  let highStakesDecisions = 0;
  for (const d of state.decisions) {
    const r = d.response as any;
    if (r && (r.confidence || r.predictedOutcome)) decisionsWithPredictions++;
    if ((d as any).stakes === "high") highStakesDecisions++;
  }

  return {
    avgReviewLatencyMs: Math.round(avgReviewLatencyMs),
    commentDensity,
    approvalRate,
    reviewsByType: typeSummary,
    decisionsWithPredictions,
    highStakesDecisions,
  };
}
