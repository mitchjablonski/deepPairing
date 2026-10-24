import { collectUnansweredQuestions, type Artifact, type ArtifactStatus, type Comment } from "@deeppairing/shared";

export interface RetirementInput {
  artifactId: string;
  expectedVersion: number;
  expectedStatus: ArtifactStatus;
  door: "withdraw" | "revise";
  mode: "retract" | "obsolete";
  reason: string;
}

export type RetirementOutcome =
  | { kind: "committed" | "already_retired"; artifact: Artifact; marker?: Comment; disarmed: boolean; warning?: string }
  | { kind: "blocked_feedback"; unansweredQuestions: number; openSuggestions: number; undrainedComments: number }
  | { kind: "not_found" | "stale" | "ineligible" | "feedback_unknown" | "persist_uncertain"; message: string };

/** Questions use the canonical thread projection; delivery is not resolution. */
export function retirementFeedback(comments: Comment[], artifactId: string) {
  const questions = collectUnansweredQuestions(comments).filter((q) => q.artifactId === artifactId || q.question.target?.artifactId === artifactId);
  const counted = new Set(questions.map((q) => q.question.id));
  const target = comments.filter((c) => c.target?.artifactId === artifactId);
  const suggestions = target.filter((c) => c.author === "human" && (c.suggestion?.state === "pending" || c.suggestion?.state === "countered") && !counted.has(c.id));
  for (const c of suggestions) counted.add(c.id);
  return {
    kind: "blocked_feedback" as const,
    unansweredQuestions: questions.length,
    openSuggestions: suggestions.length,
    undrainedComments: target.filter((c) => c.author === "human" && !c.acknowledged && !counted.has(c.id)).length,
  };
}

export function retirementFailure(outcome: Exclude<RetirementOutcome, { artifact: Artifact }>): string {
  if (outcome.kind !== "blocked_feedback") return outcome.message;
  const counts = [outcome.unansweredQuestions ? `${outcome.unansweredQuestions} unanswered question(s)` : "", outcome.openSuggestions ? `${outcome.openSuggestions} open suggestion(s)` : "", outcome.undrainedComments ? `${outcome.undrainedComments} unread comment(s)` : ""].filter(Boolean);
  return `REFUSED — ${counts.join(" and ")}. Call check_feedback and address the feedback first; retirement must never dodge review.`;
}
