import type { Comment, PageFileWatchOrphan } from "@deeppairing/shared";
import { PAGE_FILE_WATCH_LIMITS } from "@deeppairing/shared";
import { extractPageTextBlocks, PAGE_TEXT_MAX_BLOCKS } from "./page-text.js";

/**
 * #680 slice 3 — server-side re-anchoring of page comments against a NEW
 * version of the page's HTML, for the file watch's auto-recorded versions.
 *
 * Where re-anchoring runs, and why it is split:
 *
 *  - The COMPANION stays authoritative for pins. Its annotator re-finds each
 *    anchor in the live DOM (locator first, then the quote with prefix/suffix,
 *    with kind/header/node/href identity checks and tie → "not found") and the
 *    list marks the misses "Not found in this version". That needs a real DOM,
 *    which the daemon does not have (no HTML parser dependency; page-text.ts is
 *    deliberately not one), and it already runs on every version, including
 *    ones made with revise_artifact.
 *  - The SERVER answers the narrower question the agent needs in
 *    check_feedback: which comments certainly lost their spot. Every anchor
 *    the annotator re-finds must contain its quote (the annotator requires the
 *    element's text to include the quote's first 60 characters, a text anchor
 *    the whole quote; a cell also needs its header text; a link its href). So
 *    when that evidence is gone from the new HTML entirely, the companion
 *    cannot find the anchor either: the comment is ORPHANED.
 *
 * The check is deliberately conservative (it errs toward "still here"): text
 * is compared on letters and digits only, against both the page's visible text
 * and the raw HTML (attributes such as alt/aria-label, and entities the text
 * extractor does not decode). An anchor with no quote and no other identity is
 * never called orphaned on the server; only the companion can judge it. The
 * companion may still mark a "carried" anchor not found (for example, when the
 * quote now appears twice and the context no longer decides between them).
 */

/** Letters and digits only, so whitespace, punctuation and entity spelling
 *  differences never decide anything. */
function core(s: string): string {
  return s.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "");
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface PageHaystack {
  /** Visible text, letters and digits only. */
  text: string;
  /** Raw HTML, letters and digits only. */
  raw: string;
  /** The raw HTML, for exact attribute checks (href). */
  html: string;
  /** The text extractor hit its block cap: text past it was not read, so a
   *  miss proves nothing. */
  truncated: boolean;
}

export function pageHaystack(html: string): PageHaystack {
  const blocks = extractPageTextBlocks(html);
  return { text: core(blocks.join(" ")), raw: core(html), html, truncated: blocks.length >= PAGE_TEXT_MAX_BLOCKS };
}

function present(hay: PageHaystack, s: string): boolean | null {
  const c = core(s);
  if (!c) return null; // no evidence either way
  return hay.text.includes(c) || hay.raw.includes(c);
}

export type AnchorVerdict = "carried" | "orphaned" | "unknown";

/** Is this anchor's evidence still in the page? */
export function relocateHtmlAnchor(anchor: NonNullable<Comment["target"]["htmlAnchor"]>, hay: PageHaystack): AnchorVerdict {
  const checks: Array<boolean | null> = [];
  const quote = norm(anchor.quote ?? "");
  // The annotator's own rule: a text anchor needs the whole quote, every other
  // kind the first 60 normalized characters inside the element's text.
  checks.push(present(hay, anchor.kind === "text" ? quote : quote.slice(0, 60)));
  if (anchor.kind === "cell" && anchor.table) {
    if (anchor.table.row) checks.push(present(hay, anchor.table.row));
    if (anchor.table.col) checks.push(present(hay, anchor.table.col));
  }
  if (anchor.kind === "link" && anchor.href) checks.push(hay.html.includes(anchor.href));
  if (anchor.kind === "diagram-node" && anchor.nodeId) {
    // A saved Mermaid node id is identity enough for the annotator (a revision
    // may relabel the node), so the id alone carries it.
    if (hay.html.includes(anchor.nodeId)) return "carried";
  }
  const known = checks.filter((c): c is boolean => c !== null);
  if (known.length === 0) return "unknown";
  if (known.every(Boolean)) return "carried";
  // A miss in visible text past the extractor's cap is not proof.
  if (hay.truncated) return "unknown";
  return "orphaned";
}

export interface RelocateResult {
  carried: string[];
  orphaned: PageFileWatchOrphan[];
  /** Orphans past the stored list's cap. */
  orphanedOverflow: number;
  unknown: string[];
}

/**
 * Re-anchor every root page comment in `comments` (replies follow their
 * root) against `html`. Only HUMAN comments with an `htmlAnchor` count: those
 * are the pins the companion draws.
 */
export function relocatePageComments(html: string, comments: readonly Comment[]): RelocateResult {
  const hay = pageHaystack(html);
  const out: RelocateResult = { carried: [], orphaned: [], orphanedOverflow: 0, unknown: [] };
  const roots = comments
    .filter((c) => c.author === "human" && !c.parentCommentId && c.target.htmlAnchor)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of roots) {
    const a = c.target.htmlAnchor!;
    const v = relocateHtmlAnchor(a, hay);
    if (v === "carried") out.carried.push(c.id);
    else if (v === "unknown") out.unknown.push(c.id);
    else if (out.orphaned.length >= PAGE_FILE_WATCH_LIMITS.orphans) out.orphanedOverflow++;
    else {
      out.orphaned.push({
        commentId: c.id,
        kind: a.kind,
        quote: a.quote.slice(0, PAGE_FILE_WATCH_LIMITS.quote),
        locator: a.locator.slice(0, PAGE_FILE_WATCH_LIMITS.locator),
        ...(a.version != null ? { version: a.version } : {}),
      });
    }
  }
  return out;
}
