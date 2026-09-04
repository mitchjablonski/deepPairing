import { z } from "zod";

const count = z.number().finite().nonnegative();
/** Wire contract for the companion's combined project/global ledger digest. */
export const LedgerDigestSchema = z.object({
  shapedThisProject: count,
  nearMissesThisProject: count,
  blockedThisProject: count,
  sessionsTouched: count,
  topCitedStances: z.array(z.object({
    concept: z.string(), source: z.enum(["session", "team"]), citationCount: count,
    globalCitationCount: count.optional(), sampleArtifactId: z.string().optional(), sampleSessionId: z.string().optional(),
  })),
  seededStances: z.array(z.object({
    concept: z.string(), stance: z.enum(["avoid", "prefer", "mixed"]), citedTimesElsewhere: count,
    sampleArtifactId: z.string().optional(), sampleSessionId: z.string().optional(),
  })).optional(),
  globalLedger: z.object({ concepts: count, projects: count, multiProjectConcepts: count }),
});
export type LedgerDigest = z.infer<typeof LedgerDigestSchema>;
