import { z } from "zod";
import { SecretWarningSchema } from "./artifact.js";

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
  // D8 (M6) — stable requirement identity. stepIndex-anchored requirement
  // comments silently reattach to the wrong requirement when a revision
  // reorders them; REQ-ids are stable across reorders.
  requirementId: z.string().optional().describe("The spec requirement id (e.g. REQ-1) this comment targets"),
  // D8 (H1) — open questions are now answerable; index into openQuestions[].
  questionIndex: z.number().int().optional().describe("Index into the artifact's openQuestions[]"),
  visualId: z.string().optional().describe("The plan/spec visual (diagram, file_map, prototype) this comment targets"),
  suggestion: z.string().optional().describe("Suggested code replacement for this line"),
  // #140 — a region selected on a rendered Mermaid diagram. TEXTUAL, not a
  // screenshot: the agent gets the hit-tested node ids + labels (which it can
  // locate in the Mermaid source it authored) plus the normalized rect. Every
  // sub-field optional; an old comment with no `region` loads unchanged. The
  // rect is normalized to the SVG's own rendered box (0..1) so it survives
  // responsive scaling. `labels` disambiguates when a node id is later removed
  // by a diagram revision (the comment must NOT vanish — see check-feedback).
  region: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      elementIds: z.array(z.string()).optional().describe('Hit-tested g.node ids, e.g. ["flowchart-AuthGate-1"]'),
      labels: z.array(z.string()).optional().describe('Hit-tested node labels, e.g. ["AuthGate"]'),
    })
    .optional()
    .describe("A rectangle selected on a rendered Mermaid diagram (visualId), anchored textually to the nodes it covers"),
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
   * the agent should respond with answer_question.
   */
  intent: CommentIntentSchema.optional(),
  /** Set when an agent-authored reply has answered this question. */
  answeredByCommentId: z.string().nullable().optional(),
  /**
   * Set when the human marks their OWN unanswered question resolved (e.g. they
   * figured it out themselves, or it's no longer relevant). Lets the "waiting
   * on human" signal stop counting a question the agent never answered. Purely
   * human-driven; does not touch the agent's `acknowledged` queue.
   */
  humanResolvedAt: z.string().datetime().nullable().optional(),
  /**
   * #160 — secret-scanner matches found in this comment's body at create
   * time. A comment with a secret is HUMAN-authored (the risk is a key
   * pasted into a comment that then flows into agent context and disk), so
   * the daemon's comment-create path scans and persists the labels-only
   * result here — pattern prefix + label (+ line), NEVER the matched value.
   * Optional for backward compatibility (project rule: all new fields
   * optional); old comments without it load unchanged.
   */
  secretWarnings: z.array(SecretWarningSchema).optional(),
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
