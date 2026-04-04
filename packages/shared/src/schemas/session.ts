import { z } from "zod";

export const SessionStatusSchema = z.enum([
  "idle",
  "gathering",
  "presenting",
  "executing",
  "completed",
  "error",
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  status: SessionStatusSchema,
  prompt: z.string(),
  cwd: z.string(),
  agentSessionId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionRequestSchema = z.object({
  prompt: z.string().min(1),
  cwd: z.string().min(1),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
});

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
