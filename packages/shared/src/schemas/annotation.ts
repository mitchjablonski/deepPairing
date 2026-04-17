import { z } from "zod";

/**
 * A learner's note on a specific timeline event in a past session.
 * Lives next to the session on disk (.deeppairing/sessions/{id}/annotations.json)
 * and is stitched in by the replay UI as marginalia.
 *
 * Distinct from regular Comment: annotations are *outside* the agent's feed —
 * they're the human re-reading their own past work, not messages back to the
 * agent. Separation keeps the two intents from polluting each other.
 */
export const SessionAnnotationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  targetEventId: z.string().describe("A TimelineEvent.id the note attaches to"),
  note: z.string().min(1),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
});

export type SessionAnnotation = z.infer<typeof SessionAnnotationSchema>;

export const CreateAnnotationRequestSchema = z.object({
  targetEventId: z.string(),
  note: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

export type CreateAnnotationRequest = z.infer<typeof CreateAnnotationRequestSchema>;
