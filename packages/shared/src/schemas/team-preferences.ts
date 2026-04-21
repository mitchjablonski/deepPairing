import { z } from "zod";

/**
 * Team preferences — a COMMITTABLE file at `.deeppairing/team.json` that
 * encodes conventions the team has explicitly agreed on. Surfaced to the
 * agent alongside (but never merged with):
 *   - the user's PERSONAL philosophy ledger at `~/.deeppairing/philosophy/v1.json`
 *   - filesystem-sensed project guardrails (migrations, CI, infra)
 *
 * The three layers stay separate on purpose:
 *   - Guardrails → structural, non-negotiable ("don't rewrite CI without escalation")
 *   - Team prefs → team-agreed conventions ("use argon2id for password hashing")
 *   - Personal philosophy → the individual user's cross-project taste
 *
 * Managed via file editing (or a future "promote to team" UI). The companion
 * web app renders team prefs read-only so the agent can't silently edit them.
 */

export const TeamPreferenceKindSchema = z.enum(["require", "prefer", "avoid"]);
export type TeamPreferenceKind = z.infer<typeof TeamPreferenceKindSchema>;

export const TeamPreferenceScopeSchema = z.object({
  /** Glob-ish path patterns the preference applies to. Empty/absent = repo-wide. */
  paths: z.array(z.string()).optional(),
});
export type TeamPreferenceScope = z.infer<typeof TeamPreferenceScopeSchema>;

export const TeamPreferenceSchema = z.object({
  /** Stable identifier so edits + conflict resolution are traceable in git blame. */
  id: z.string().min(1),
  kind: TeamPreferenceKindSchema,
  /**
   * The underlying concept (e.g. "argon2id for password hashing",
   * "repository pattern", "avoid global state"). Match logic is concept-first
   * so surface-level renames don't bypass the rule.
   */
  concept: z.string().min(1),
  /** Why the team agreed on this. Shown to the agent so it can reason about edge cases. */
  rationale: z.string().min(1),
  /** Optional narrowing — if omitted, applies repo-wide. */
  scope: TeamPreferenceScopeSchema.optional(),
  /** Attribution for social context only; NOT used for access control. */
  addedBy: z.string().optional(),
  addedAt: z.string().datetime().optional(),
});
export type TeamPreference = z.infer<typeof TeamPreferenceSchema>;

export const TeamPreferencesFileSchema = z.object({
  /** Bump when the schema shape changes — consumers ignore unknown major versions. */
  version: z.literal(1),
  preferences: z.array(TeamPreferenceSchema),
});
export type TeamPreferencesFile = z.infer<typeof TeamPreferencesFileSchema>;

/**
 * Parse raw team.json content. Returns null instead of throwing so the loader
 * can log + skip a malformed file without crashing the agent session.
 */
export function parseTeamPreferencesFile(raw: unknown): TeamPreferencesFile | null {
  const result = TeamPreferencesFileSchema.safeParse(raw);
  return result.success ? result.data : null;
}
