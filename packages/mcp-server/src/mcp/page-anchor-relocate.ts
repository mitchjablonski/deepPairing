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

/**
 * Review P2-3 — HTML character references, decoded before any comparison (the
 * annotator's quotes and hrefs come from the DOM, i.e. already decoded). No
 * entity library is a dependency here, so: every numeric reference, the full
 * Latin-1 named set, and the common typographic names. A named reference
 * outside this table is reported as `unknownEntity`, which makes a miss
 * inconclusive ("unknown") rather than an orphan.
 */
const LATIN1_NAMES = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para " +
  "middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute " +
  "Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute " +
  "THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde " +
  "ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
).split(" ");
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201a", ldquo: "\u201c",
  rdquo: "\u201d", bdquo: "\u201e", bull: "\u2022", prime: "\u2032", Prime: "\u2033", trade: "\u2122", euro: "\u20ac",
  larr: "\u2190", uarr: "\u2191", rarr: "\u2192", darr: "\u2193", harr: "\u2194", lArr: "\u21d0", rArr: "\u21d2", hArr: "\u21d4",
  minus: "\u2212", le: "\u2264", ge: "\u2265", ne: "\u2260", asymp: "\u2248", infin: "\u221e", ensp: "\u2002", emsp: "\u2003",
  thinsp: "\u2009", zwnj: "\u200c", zwj: "\u200d", OElig: "\u0152", oelig: "\u0153", Scaron: "\u0160", scaron: "\u0161",
  Yuml: "\u0178", fnof: "\u0192", circ: "\u02c6", tilde: "\u02dc", dagger: "\u2020", Dagger: "\u2021", permil: "\u2030",
  lsaquo: "\u2039", rsaquo: "\u203a", check: "\u2713", hearts: "\u2665", star: "\u2606",
};
LATIN1_NAMES.forEach((n, i) => { NAMED[n] = String.fromCharCode(160 + i); });

export function decodeHtmlEntities(s: string): { text: string; unknownEntity: boolean } {
  let unknownEntity = false;
  const text = s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "\ufffd";
      try { return String.fromCodePoint(code); } catch { return "\ufffd"; }
    }
    const hit = NAMED[body] ?? NAMED[body.toLowerCase()];
    if (hit !== undefined) return hit;
    // `&foo` without `;` is usually just text ("AT&T"); only a terminated
    // unknown name is an entity we failed to decode.
    if (m.endsWith(";")) unknownEntity = true;
    return m;
  });
  return { text, unknownEntity };
}

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
  /** Raw HTML, entities decoded, letters and digits only. */
  raw: string;
  /** The raw HTML with entities decoded, for exact attribute checks (href). */
  html: string;
  /** A named reference this decoder doesn't know: a miss proves nothing. */
  unknownEntity: boolean;
  /** The text extractor hit its block cap: text past it was not read, so a
   *  miss proves nothing. */
  truncated: boolean;
}

export function pageHaystack(html: string): PageHaystack {
  const blocks = extractPageTextBlocks(html);
  const decoded = decodeHtmlEntities(html);
  // page-text decodes only a handful of names; decode what it left behind.
  const text = decodeHtmlEntities(blocks.join(" "));
  return {
    text: core(text.text),
    raw: core(decoded.text),
    html: decoded.text,
    unknownEntity: decoded.unknownEntity || text.unknownEntity,
    truncated: blocks.length >= PAGE_TEXT_MAX_BLOCKS,
  };
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
  // A miss in visible text past the extractor's cap, or in a page holding an
  // entity we couldn't decode, is not proof.
  if (hay.truncated || hay.unknownEntity) return "unknown";
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
