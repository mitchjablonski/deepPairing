import { z } from "zod";

export const CommentTargetSchema = z.object({
  artifactId: z.string(),
  lineNumber: z.number().int().optional(),
  findingIndex: z.number().int().optional(),
  evidenceIndex: z.number().int().optional(),
  stepIndex: z.number().int().optional(),
  sectionId: z.string().optional(),
});

export type CommentTarget = z.infer<typeof CommentTargetSchema>;

export const CommentAuthorSchema = z.enum(["human", "agent"]);

export const CommentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  target: CommentTargetSchema,
  parentCommentId: z.string().nullable(),
  author: CommentAuthorSchema,
  content: z.string().min(1),
  acknowledged: z.boolean(),
  createdAt: z.string().datetime(),
});

export type Comment = z.infer<typeof CommentSchema>;

export const CreateCommentRequestSchema = z.object({
  target: CommentTargetSchema,
  content: z.string().min(1),
  parentCommentId: z.string().nullable().optional(),
});

export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;
