/**
 * #680 — the visible text of an agent-authored HTML page, for the rejection
 * gate. present_page runs the same preflight the other present_* tools run;
 * this turns the page into the plain-text proposal strings that preflight reads.
 *
 * Deliberately simple and dependency-free: it is NOT an HTML parser and never
 * renders anything. It only needs to recover the words a reviewer would read.
 *
 *  - The BODIES of <script>, <style>, <template> and <title> are dropped
 *    (code and metadata, not page text), as are comments. <head> is NOT
 *    dropped: `</head>` is optional and a browser leaves head at the first
 *    body element, so dropping it wholesale would hide visible text. Nor is
 *    <noscript>: the companion first renders pages with scripting disabled, so
 *    its content is what the reviewer sees.
 *  - A dropped element with no closing tag skips only its opening tag, never
 *    the rest of the page (failing toward gating more text, not less).
 *  - <textarea> is RCDATA: its content is text, never markup or a comment.
 *  - Comments follow HTML's rules, including the abrupt empty forms `<!-->`
 *    and `<!--->` and the `--!>` closer.
 *  - Block-level tags become line breaks; every other tag becomes nothing, so
 *    `Rail<b></b>way` reads "Railway".
 *  - A handful of common entities are decoded.
 *  - The result is split into one string per block, so a rejected concept has
 *    to appear WITHIN one block to match by concept tokens. Feeding the whole
 *    page as one string would let "redis" in one paragraph and "cache" in
 *    another assemble a false match for a stance about "redis cache".
 *
 * Every scan is a single forward pass with indexOf (no backtracking regex over
 * the whole document), so a 2 MB page with thousands of unterminated tags
 * stays linear.
 */

/** Elements whose content is dropped (when closed). */
const DROP_ELEMENTS = ["script", "style", "template", "title"] as const;
/** RCDATA elements whose content is literal text (no tags, no comments). */
const TEXT_ELEMENTS = ["textarea"] as const;

/** Tags that start a new visual block (their text becomes its own string). */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "div", "dl", "dt",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul", "body", "html", "label", "button", "option", "legend", "fieldset",
  "head", "noscript", "textarea",
]);

/** Upper bound on blocks handed to the matcher (cost guard for huge pages). */
export const PAGE_TEXT_MAX_BLOCKS = 2000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  rsquo: "'", lsquo: "'", rdquo: "\"", ldquo: "\"", middot: "·", times: "×", rarr: "→", larr: "←",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return " ";
      try { return String.fromCodePoint(code); } catch { return " "; }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** True when `lower[at..]` opens the element `tag` (`<tag` + a delimiter). */
function opensElement(lower: string, at: number, tag: string): boolean {
  if (!lower.startsWith(tag, at + 1)) return false;
  const next = lower.charCodeAt(at + 1 + tag.length);
  // End of input, whitespace, `>` or `/` ends the tag name.
  return Number.isNaN(next) || next === 62 /* > */ || next === 47 /* / */ || next <= 32;
}

/**
 * Plain-text blocks of an HTML page, in document order. Empty and
 * whitespace-only blocks are dropped; whitespace inside a block is collapsed.
 */
export function extractPageTextBlocks(html: string): string[] {
  // ASCII-only lowercasing keeps `lower` index-aligned with `html` (a full
  // toLowerCase can change length, e.g. "İ" → "i̇"); tag names are ASCII.
  const lower = html.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  // Once a closing `</tag` is known to be absent after some point, it is absent
  // after every later point too: remember that, so many unclosed elements of
  // one kind stay linear instead of rescanning the rest of the page each time.
  const neverClosed = new Set<string>();
  const findClose = (tag: string, from: number): number => {
    if (neverClosed.has(tag)) return -1;
    const at = lower.indexOf(`</${tag}`, from);
    if (at === -1) neverClosed.add(tag);
    return at;
  };
  // Same memo for the comment closers (`-->` / `--!>`).
  const missingMarkers = new Set<string>();
  const findMarker = (marker: string, from: number): number => {
    if (missingMarkers.has(marker)) return -1;
    const at = html.indexOf(marker, from);
    if (at === -1) missingMarkers.add(marker);
    return at;
  };
  let text = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    if (lower.startsWith("<!--", lt)) {
      // Abrupt empty comments are complete: `<!-->` and `<!--->`.
      if (lower.startsWith("<!-->", lt)) { i = lt + 5; continue; }
      if (lower.startsWith("<!--->", lt)) { i = lt + 6; continue; }
      const a = findMarker("-->", lt + 4);
      const b = findMarker("--!>", lt + 4);
      const end = a === -1 ? (b === -1 ? -1 : b + 4) : b === -1 || a < b ? a + 3 : b + 4;
      // An unterminated comment hides the rest of the page in a browser too.
      i = end === -1 ? n : end;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      // No closing `>` anywhere after this point: what's left is text.
      text += html.slice(lt);
      break;
    }
    const drop = DROP_ELEMENTS.find((tag) => opensElement(lower, lt, tag));
    const literal = drop ? undefined : TEXT_ELEMENTS.find((tag) => opensElement(lower, lt, tag));
    const raw = drop ?? literal;
    if (raw) {
      const close = findClose(raw, gt + 1);
      if (close === -1) {
        // Unclosed: skip only the opening tag and keep reading the page.
        text += "\n";
        i = gt + 1;
        continue;
      }
      if (literal) text += "\n" + html.slice(gt + 1, close);
      const closeEnd = html.indexOf(">", close);
      text += "\n";
      i = closeEnd === -1 ? n : closeEnd + 1;
      continue;
    }
    const m = /^<\/?\s*([a-z][a-z0-9-]*)/.exec(lower.slice(lt, Math.min(gt + 1, lt + 40)));
    // Block tags break the text into a new block; inline tags vanish, so
    // `Rail<b></b>way` stays one word.
    if (m && BLOCK_TAGS.has(m[1]!)) text += "\n";
    i = gt + 1;
  }
  const blocks: string[] = [];
  for (const line of decodeEntities(text).split("\n")) {
    const t = line.replace(/\s+/g, " ").trim();
    if (t) blocks.push(t);
    if (blocks.length >= PAGE_TEXT_MAX_BLOCKS) break;
  }
  return blocks;
}
