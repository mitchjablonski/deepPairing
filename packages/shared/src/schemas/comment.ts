import { z } from "zod";

/** A reference to specific lines in a file — used in comments to link to code */
export const CodeReferenceSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  snippet: z.string().optional().describe("The selected code text"),
});

export type CodeReference = z.infer<typeof CodeReferenceSchema>;

export const CommentTargetSchema = z.object({
  artifactId: z.string(),
  lineNumber: z.number().int().optional(),
  lineStart: z.number().int().optional(),
  lineEnd: z.number().int().optional(),
  filePath: z.string().optional(),
  findingIndex: z.number().int().optional(),
  evidenceIndex: z.number().int().optional(),
  stepIndex: z.number().int().optional(),
  alternativeIndex: z.number().int().optional().describe("Index into a reasoning artifact's alternativeDetails[]"),
  optionId: z.string().optional().describe("The option id this comment targets (for decision artifacts)"),
  sectionId: z.string().optional(),
  suggestion: z.string().optional().describe("Suggested code replacement for this line"),
});

export type CommentTarget = z.infer<typeof CommentTargetSchema>;

export const CommentAuthorSchema = z.enum(["human", "agent"]);

export const CommentIntentSchema = z.enum(["comment", "question", "suggestion"]);
export type CommentIntent = z.infer<typeof CommentIntentSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  target: CommentTargetSchema,
  parentCommentId: z.string().nullable(),
  author: CommentAuthorSchema,
  content: z.string().min(1),
  codeReferences: z.array(CodeReferenceSchema).optional().describe("Code snippets referenced in this comment"),
  /**
   * Default "comment". "question" means the human wants an explanation and
   * the agent should respond with deepPairing_answer_question.
   */
  intent: CommentIntentSchema.optional(),
  /** Set when an agent-authored reply has answered this question. */
  answeredByCommentId: z.string().nullable().optional(),
  acknowledged: z.boolean(),
  createdAt: z.string().datetime(),
});

export type Comment = z.infer<typeof CommentSchema>;

export const CreateCommentRequestSchema = z.object({
  target: CommentTargetSchema,
  content: z.string().min(1),
  parentCommentId: z.string().nullable().optional(),
  codeReferences: z.array(CodeReferenceSchema).optional(),
  intent: CommentIntentSchema.optional(),
});

export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;
