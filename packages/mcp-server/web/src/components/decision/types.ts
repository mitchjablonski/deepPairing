import type { DecisionRequestEvent } from "@deeppairing/shared";

/** One option from the decision request — the wire type is the source of truth. */
export type DecisionOption = DecisionRequestEvent["options"][number];

/** If set (e.g. in replay mode for past decisions), DecisionCard starts in the resolved state. */
export interface InitialResolved {
  optionId: string;
  reasoning?: string;
  resolvedAt?: string;
  confidence?: "low" | "medium" | "high";
  predictedOutcome?: string;
}

export const badgeColors = {
  low: "bg-accent-green-dim text-accent-green",
  medium: "bg-accent-amber-dim text-accent-amber",
  high: "bg-accent-red-dim text-accent-red",
};
