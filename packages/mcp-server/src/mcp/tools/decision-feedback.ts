import type { ArtifactStatus } from "@deeppairing/shared";
import type { DecisionRecord, RejectedApproach } from "../../store/store-interface.js";

/** The saved choice shared by the MCP delivery path and passive reads. */
export function decisionFeedback(decision: DecisionRecord) {
  const selectedOptionId = decision.response?.optionId;
  const option = decision.options.find((candidate) => candidate.id === selectedOptionId);
  return {
    decisionId: decision.decisionId,
    artifactId: decision.artifactId,
    context: decision.context,
    selectedOptionId,
    selectedTitle: option?.title,
    reasoning: decision.response?.reasoning,
  };
}

export type StandaloneDecisionRead = ReturnType<typeof decisionFeedback> & {
  sessionId: string;
  artifactStatus: ArtifactStatus;
  /** Current project stances sourced from this card, in their recorded form. */
  recordedRejections: Array<Pick<RejectedApproach, "description" | "reason">>;
};
