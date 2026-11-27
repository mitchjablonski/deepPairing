import type { Comment, HtmlAnchor } from "@deeppairing/shared";

/**
 * #680 slice 2 — display helpers for page anchors. Type-only imports, so the
 * entry chunk (CommentThread) can use them without pulling in Zod.
 */

/** Same spot? Used to group comments on one anchor into one thread. A text
 *  anchor's prefix/suffix say WHICH occurrence of the quote it is, so they
 *  count; on element-grain anchors they are only context (#714 gap 10 added
 *  them), so a click on an element already commented on before then still
 *  joins that thread. `section` is context for every kind. */
export function sameHtmlAnchor(a: HtmlAnchor | undefined, b: HtmlAnchor | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.locator !== b.locator || a.quote !== b.quote) return false;
  if (a.kind !== "text") return true;
  return (a.prefix ?? "") === (b.prefix ?? "") && (a.suffix ?? "") === (b.suffix ?? "");
}

const KIND_LABEL: Record<HtmlAnchor["kind"], string> = {
  element: "Element",
  text: "Text",
  cell: "Table cell",
  "diagram-node": "Diagram node",
  link: "Link",
};

export function htmlAnchorKindLabel(kind: HtmlAnchor["kind"]): string {
  return KIND_LABEL[kind] ?? kind;
}

const KINDS = new Set(["element", "text", "cell", "diagram-node", "link"]);
const optStr = (v: unknown) => v === undefined || typeof v === "string";

/** Shape check for a STORED anchor (no Zod here: entry chunk). Historical or
 *  hand-written records that fail it are not rendered as page anchors. */
export function isWellFormedHtmlAnchor(a: unknown): a is HtmlAnchor {
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const x = a as Record<string, unknown>;
  if (typeof x.kind !== "string" || !KINDS.has(x.kind)) return false;
  if (typeof x.locator !== "string" || !x.locator || typeof x.quote !== "string") return false;
  if (!optStr(x.prefix) || !optStr(x.suffix) || !optStr(x.nodeId) || !optStr(x.href)) return false;
  if (x.table !== undefined) {
    if (!x.table || typeof x.table !== "object") return false;
    const t = x.table as Record<string, unknown>;
    if (!optStr(t.row) || !optStr(t.col)) return false;
  }
  return true;
}

/**
 * The comments the page renderer lists (numbered, with pins) instead of the
 * general Comments thread: root comments with a well-formed anchor, on a page.
 * The ONE predicate both surfaces use, so a comment is never hidden from the
 * general history unless the page list actually shows it (a stray anchor on a
 * non-page artifact, a malformed one, or a reply all stay in general history).
 */
export function isPageListedComment(artifactType: string, c: Comment): boolean {
  return artifactType === "page" && c.parentCommentId == null && isWellFormedHtmlAnchor(c.target.htmlAnchor);
}
