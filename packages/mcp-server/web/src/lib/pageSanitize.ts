/**
 * #680 slice 2 — the BEFORE-RUN sanitiser for a `page` artifact.
 *
 * Before the human clicks Run, the page frame runs with `allow-scripts` so our
 * annotator can work, but the agent's own code must stay inert. So the parent
 * parses the agent HTML with `DOMParser` (which never executes anything),
 * removes every way markup can run script or leave the document, and
 * serialises what is left:
 *  - `<script>` (HTML and SVG), and `<noscript>`/`<template>` (their content
 *    parses differently once scripting is on — a classic mutation-XSS vector);
 *  - `<iframe>`, `<frame>`, `<frameset>`, `<object>`, `<embed>`, `<applet>`,
 *    `<portal>`, `<base>`, and `<meta http-equiv="refresh">`;
 *  - every `on*` attribute;
 *  - `javascript:`, `vbscript:`, `data:text/html` and `data:application/xhtml+xml`
 *    URLs in href / src / action / formaction / xlink:href (and the few other
 *    URL-bearing attributes);
 *  - SVG `<animate>`/`<set>` that would rewrite an href.
 *
 * This is NOT the only layer: the before-Run frame also carries a CSP whose
 * `script-src` is a per-render nonce held only by the annotator's script tag,
 * so anything that survives this pass still cannot execute. And the frame is
 * always an opaque-origin sandbox (never `allow-same-origin`) with no network.
 */

const DROP_SELECTOR = [
  "script",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "base",
].join(",");

/** True for a URL that would run script or load an HTML document. Control
 *  characters and whitespace are ignored the way browsers ignore them. */
export function isDangerousUrl(value: string): boolean {
  const v = value.replace(/[\x00-\x20\x7f-\x9f]/g, "").toLowerCase();
  return (
    v.startsWith("javascript:") ||
    v.startsWith("vbscript:") ||
    v.startsWith("data:text/html") ||
    v.startsWith("data:application/xhtml")
  );
}

function scrubAttributes(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
      continue;
    }
    // A script URL is removed from ANY attribute (href, src, action,
    // formaction, xlink:href, …), not only the usual URL-bearing ones: SVG
    // animation values (`to`, `values`) can write one into an href.
    if (name === "srcdoc" || isDangerousUrl(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
}

/** Parse, strip, serialise. Never executes the input. */
export function sanitizePageHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of Array.from(doc.querySelectorAll(DROP_SELECTOR))) el.remove();
  for (const el of Array.from(doc.querySelectorAll("meta"))) {
    if ((el.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh") el.remove();
  }
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const tag = el.localName.toLowerCase();
    if (tag !== "set" && !tag.startsWith("animate")) continue;
    const target = Array.from(el.attributes).find((a) => a.name.toLowerCase() === "attributename")?.value ?? "";
    if (target.toLowerCase().includes("href")) el.remove();
  }
  for (const el of Array.from(doc.querySelectorAll("*"))) scrubAttributes(el);
  return doc.head.innerHTML + doc.body.innerHTML;
}
