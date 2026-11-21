import type { HtmlAnchor } from "@deeppairing/shared";

/**
 * #680 slice 2 — display helpers for page anchors. Type-only imports, so the
 * entry chunk (CommentThread) can use them without pulling in Zod.
 */

/** Same spot? Used to group comments on one anchor into one thread. */
export function sameHtmlAnchor(a: HtmlAnchor | undefined, b: HtmlAnchor | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.locator === b.locator &&
    a.quote === b.quote &&
    (a.prefix ?? "") === (b.prefix ?? "") &&
    (a.suffix ?? "") === (b.suffix ?? "")
  );
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
