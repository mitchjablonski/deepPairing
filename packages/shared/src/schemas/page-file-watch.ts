import { z } from "zod";

/**
 * #680 slice 3 — what the daemon's file watch did with a file-backed `page`
 * artifact (one presented with `sourcePath`). Stored on the artifact record as
 * `fileWatch`; optional, so every older artifact loads unchanged.
 *
 * Two independent notices, each delivered to the agent once by check_feedback
 * (`delivered` flips true when it has been reported):
 *
 *  - `recorded` sits on a version the watch RECORDED from the file: which
 *    version it replaced, how many page comments still locate in the new HTML,
 *    and which could no longer be found (`orphaned`). The orphaned comments are
 *    not moved or hidden; they stay on their own version and keep showing in
 *    the companion, marked "not found in this version".
 *  - `refused` sits on the LIVE version when a save was NOT recorded: either
 *    the new text matched rejection memory (`cause: "gate"`, with the stored
 *    reason) or the file could not be read safely (`cause: "unreadable"`:
 *    moved outside the project through a symlink, too large, not a regular
 *    file). `digest` identifies the refused content so the same bytes are not
 *    refused (and re-announced) on every later write event.
 *
 * The orphan `kind` mirrors HtmlAnchorKindSchema loosely (a plain string):
 * comment.ts imports this module's importer (artifact.ts), so importing it
 * here would be a cycle.
 */
export const PAGE_FILE_WATCH_LIMITS = {
  orphans: 50,
  quote: 280,
  locator: 512,
  message: 2000,
} as const;

export const PageFileWatchOrphanSchema = z.object({
  commentId: z.string(),
  kind: z.string().max(32),
  quote: z.string().max(PAGE_FILE_WATCH_LIMITS.quote),
  locator: z.string().max(PAGE_FILE_WATCH_LIMITS.locator),
  /** The page version the comment's anchor was made on. */
  version: z.number().int().positive().optional(),
});
export type PageFileWatchOrphan = z.infer<typeof PageFileWatchOrphanSchema>;

export const PageFileWatchRecordedSchema = z.object({
  at: z.string(),
  sourcePath: z.string(),
  /** The version this one replaced (now `superseded`). */
  fromArtifactId: z.string(),
  fromVersion: z.number().int().positive(),
  /** Page comments whose quoted text is still in the new HTML. */
  carriedCount: z.number().int().nonnegative(),
  /** Page comments whose quoted text is gone from the new HTML. */
  orphaned: z.array(PageFileWatchOrphanSchema).max(PAGE_FILE_WATCH_LIMITS.orphans),
  /** More orphans than the stored list holds. */
  orphanedOverflow: z.number().int().nonnegative().optional(),
  delivered: z.boolean().optional(),
});
export type PageFileWatchRecorded = z.infer<typeof PageFileWatchRecordedSchema>;

export const PageFileWatchRefusedSchema = z.object({
  at: z.string(),
  sourcePath: z.string(),
  cause: z.enum(["gate", "unreadable"]),
  /** For `gate`: the stored rejection reason, as the gate words it. For
   *  `unreadable`: why the file could not be read. */
  message: z.string().max(PAGE_FILE_WATCH_LIMITS.message),
  /** For `gate`: the matched concept, when the stance names one. */
  concept: z.string().max(200).optional(),
  digest: z.string(),
  delivered: z.boolean().optional(),
});
export type PageFileWatchRefused = z.infer<typeof PageFileWatchRefusedSchema>;

export const PageFileWatchSchema = z.object({
  recorded: PageFileWatchRecordedSchema.optional(),
  refused: PageFileWatchRefusedSchema.optional(),
});
export type PageFileWatch = z.infer<typeof PageFileWatchSchema>;

/** Read an artifact's stored `fileWatch` leniently: a malformed record reads
 *  as absent (it is stored as `unknown` so one bad record never fails a load). */
export function readFileWatch(fw: unknown): PageFileWatch {
  const parsed = PageFileWatchSchema.safeParse(fw);
  return parsed.success ? parsed.data : {};
}

/** Undelivered notices on one artifact, for check_feedback. */
export function undeliveredFileWatch(fw: unknown): { recorded?: PageFileWatchRecorded; refused?: PageFileWatchRefused } {
  const parsed = PageFileWatchSchema.safeParse(fw);
  if (!parsed.success) return {};
  const out: { recorded?: PageFileWatchRecorded; refused?: PageFileWatchRefused } = {};
  if (parsed.data.recorded && !parsed.data.recorded.delivered) out.recorded = parsed.data.recorded;
  if (parsed.data.refused && !parsed.data.refused.delivered) out.refused = parsed.data.refused;
  return out;
}
