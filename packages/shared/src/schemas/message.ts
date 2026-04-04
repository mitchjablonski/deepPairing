import { z } from "zod";
import { ArtifactSchema, ArtifactStatusSchema } from "./artifact.js";
import { CommentSchema } from "./comment.js";

export const TextEventSchema = z.object({
  type: z.literal("text"),
  content: z.string(),
});

export const ToolCallEventSchema = z.object({
  type: z.literal("tool_call"),
  toolCallId: z.string(),
  tool: z.string(),
  input: z.record(z.unknown()),
  summary: z.string().optional(),
});

export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string(),
  tool: z.string(),
  output: z.string(),
  duration: z.number().optional(),
});

export const ThinkingEventSchema = z.object({
  type: z.literal("thinking"),
  content: z.string(),
});

export const StatusEventSchema = z.object({
  type: z.literal("status"),
  phase: z.enum(["gathering", "presenting", "executing", "idle"]),
});

export const ResultEventSchema = z.object({
  type: z.literal("result"),
  content: z.string(),
  stopReason: z.string(),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const DecisionRequestEventSchema = z.object({
  type: z.literal("decision_request"),
  decisionId: z.string(),
  context: z.string(),
  options: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
      effort: z.enum(["low", "medium", "high"]),
      risk: z.enum(["low", "medium", "high"]),
      recommendation: z.boolean(),
    }),
  ),
});

export const ReasoningEventSchema = z.object({
  type: z.literal("reasoning"),
  action: z.string(),
  reasoning: z.string(),
  alternativesConsidered: z.array(z.string()).optional(),
  confidence: z.enum(["low", "medium", "high"]),
});

export const FindingsEventSchema = z.object({
  type: z.literal("findings"),
  summary: z.string(),
  findings: z.array(
    z.object({
      category: z.string(),
      detail: z.string(),
      evidence: z.string(),
      significance: z.enum(["low", "medium", "high"]),
    }),
  ),
  openQuestions: z.array(z.string()).optional(),
});

export const CodeChangeEventSchema = z.object({
  type: z.literal("code_change"),
  filePath: z.string(),
  changeType: z.enum(["create", "modify", "delete"]),
  diff: z.string(),
  reasoning: ReasoningEventSchema.optional(),
  toolCallId: z.string(),
});

export const ArtifactCreatedEventSchema = z.object({
  type: z.literal("artifact_created"),
  artifact: ArtifactSchema,
});

export const ArtifactUpdatedEventSchema = z.object({
  type: z.literal("artifact_updated"),
  artifactId: z.string(),
  status: ArtifactStatusSchema,
  version: z.number().optional(),
});

export const CommentAddedEventSchema = z.object({
  type: z.literal("comment_added"),
  comment: CommentSchema,
});

export const PlanReviewRequestEventSchema = z.object({
  type: z.literal("plan_review_request"),
  artifactId: z.string(),
  title: z.string(),
  steps: z.array(
    z.object({
      description: z.string(),
      files: z.array(z.string()),
      reasoning: z.string(),
    }),
  ),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  TextEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ThinkingEventSchema,
  StatusEventSchema,
  ResultEventSchema,
  ErrorEventSchema,
  DecisionRequestEventSchema,
  ReasoningEventSchema,
  FindingsEventSchema,
  CodeChangeEventSchema,
  ArtifactCreatedEventSchema,
  ArtifactUpdatedEventSchema,
  CommentAddedEventSchema,
  PlanReviewRequestEventSchema,
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type TextEvent = z.infer<typeof TextEventSchema>;
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;
export type DecisionRequestEvent = z.infer<typeof DecisionRequestEventSchema>;
export type ReasoningEvent = z.infer<typeof ReasoningEventSchema>;
export type FindingsEvent = z.infer<typeof FindingsEventSchema>;
export type CodeChangeEvent = z.infer<typeof CodeChangeEventSchema>;
export type ArtifactCreatedEvent = z.infer<typeof ArtifactCreatedEventSchema>;
export type ArtifactUpdatedEvent = z.infer<typeof ArtifactUpdatedEventSchema>;
export type CommentAddedEvent = z.infer<typeof CommentAddedEventSchema>;
export type PlanReviewRequestEvent = z.infer<typeof PlanReviewRequestEventSchema>;
