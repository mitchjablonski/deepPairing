import { z } from "zod";

/**
 * U2 (round-15 generalization) — WHERE a piece of evidence lives when it is NOT
 * a code file:line. deepPairing's flagship affordance is "comment on the exact
 * passage"; for code that anchor is `filePath` + `lineStart`/`lineEnd`, but a
 * PDF, a contract, a Slack message, or a design brief has no line grain, so
 * before this the passage silently degraded to a lossy bare string. A `locator`
 * anchors the SAME evidence object to a non-code passage so the renderer can
 * quote it and keep it per-passage commentable.
 *
 * Deliberately small and content-agnostic — `kind` names how the passage is
 * pointed at, `value` IS the anchor text:
 *   - "quote"     — a verbatim excerpt of the passage ("...the burst cap is
 *                   undefined...")
 *   - "heading"   — a structural path into the document ("§5 ¶3", "Terms > 5.2")
 *   - "charRange" — a character offset span; `value` is "start-end" (and
 *                   charStart/charEnd may carry the parsed numbers)
 *   - "url"       — a link/anchor to the source; `href` is the resolvable URL
 *
 * `value` is `.min(1)` on the same "empty is worse than absent" discipline the
 * rest of the schemas use — a locator that points at nothing is no locator, and
 * an empty one would render an anchor chip with no target. The extra fields are
 * all optional; the renderer reads whichever match `kind`.
 */
export const EvidenceLocatorSchema = z
  .object({
    kind: z.enum(["quote", "heading", "charRange", "url"])
      .describe("How this non-code passage is pointed at: a verbatim 'quote', a 'heading' path (e.g. '§5 ¶3'), a 'charRange' offset span, or a 'url' link/anchor"),
    value: z.string().min(1)
      .describe("The anchor itself: the quoted passage, the heading path, a 'start-end' char range, or the URL/anchor text"),
    /** kind=url: the resolvable link the anchor chip opens. */
    href: z.string().optional().describe("kind=url: the link the passage anchor opens"),
    /** kind=charRange: the parsed offsets (value carries the display 'start-end'). */
    charStart: z.number().int().nonnegative().optional(),
    charEnd: z.number().int().nonnegative().optional(),
  })
  .describe("Anchors this evidence to a non-code passage (doc/message/design) when there is no file:line — so it renders as a quoted, per-passage-commentable block instead of degrading to prose");

export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

export const EvidenceSchema = z.object({
  /**
   * U2 — OPTIONAL so a non-code passage (a pasted Slack message, a PDF with no
   * on-disk path) can anchor via `locator` instead. Code evidence STILL passes
   * filePath exactly as before; this only widens what is accepted, so every
   * existing finding validates + renders byte-identical (back-compat gate).
   */
  filePath: z.string().optional(),
  /**
   * U2 — OPTIONAL line grain. Kept a positive int WHEN PRESENT (the exact old
   * constraint), but a doc/message passage has no lines: it anchors via
   * `locator`. Absent line grain routes the renderer to the quoted-passage
   * block; present line grain renders the unchanged line-numbered code gutter.
   */
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  snippet: z.string().describe("The actual code — or, for a non-code passage, the excerpt — at this location"),
  context: z.string().optional().describe("Surrounding code for understanding"),
  language: z.string().optional().describe("Language for syntax highlighting"),
  explanation: z.string().describe("Why this code is relevant"),
  relatedPaths: z.array(z.string()).optional().describe("Other codebase locations affected"),
  /**
   * U2 — anchor to a non-code passage when there is no file:line. Absent for
   * every code finding (back-compat: absent === today's file:line render).
   */
  locator: EvidenceLocatorSchema.optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

/** Accepts either a legacy string reference or a rich Evidence object */
export const EvidenceInputSchema = z.union([z.string(), EvidenceSchema]);

export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;
