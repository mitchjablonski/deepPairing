import { z } from "zod";

export const EvidenceSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  snippet: z.string().describe("The actual code at this location"),
  context: z.string().optional().describe("Surrounding code for understanding"),
  language: z.string().optional().describe("Language for syntax highlighting"),
  explanation: z.string().describe("Why this code is relevant"),
  relatedPaths: z.array(z.string()).optional().describe("Other codebase locations affected"),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

/** Accepts either a legacy string reference or a rich Evidence object */
export const EvidenceInputSchema = z.union([z.string(), EvidenceSchema]);

export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;
