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

/** Matched by `localName`, lowercased, over every element in every namespace
 *  (HTML, SVG, MathML), so an SVG `<script>` or an odd-case tag can't slip past
 *  a namespace- or case-sensitive selector. */
const DROP_TAGS = new Set([
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
]);

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

/** The page's own `<html>`/`<body>` presentation attributes that survive onto
 *  OUR wrapper elements, so class-scoped stylesheets and right-to-left
 *  direction render the same before Run as after. Names are a fixed allowlist;
 *  values are escaped by the wrapper. */
const SAFE_ROOT_ATTRS = ["class", "dir", "lang", "style"] as const;

/** A `style` value with no way to load or run anything. */
export function isSafeInlineStyle(value: string): boolean {
  return !/url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding|\\/i.test(value);
}

function safeRootAttrs(el: Element | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!el) return out;
  for (const name of SAFE_ROOT_ATTRS) {
    const v = el.getAttribute(name);
    if (v == null || v === "") continue;
    if (name === "dir" && !/^(ltr|rtl|auto)$/i.test(v.trim())) continue;
    if (name === "style" && !isSafeInlineStyle(v)) continue;
    out[name] = v;
  }
  return out;
}

export interface SanitizedPage {
  /** The cleaned head + body markup. */
  html: string;
  /** Safe attributes from the page's `<html>` element. */
  htmlAttrs: Record<string, string>;
  /** Safe attributes from the page's `<body>` element. */
  bodyAttrs: Record<string, string>;
}

/** Parse, strip, serialise. Never executes the input. */
export function sanitizePageHtml(html: string): SanitizedPage {
  if (typeof DOMParser === "undefined") return { html: "", htmlAttrs: {}, bodyAttrs: {} };
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Every element, any namespace (getElementsByTagNameNS("*", "*")), head
  // included. A second pass over script elements by namespace-wildcard lookup
  // is the belt-and-braces check for the one tag that matters most.
  for (const el of Array.from(doc.getElementsByTagNameNS("*", "*"))) {
    if (DROP_TAGS.has(el.localName.toLowerCase())) el.remove();
  }
  for (const el of Array.from(doc.getElementsByTagNameNS("*", "script"))) el.remove();
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
  return {
    html: doc.head.innerHTML + doc.body.innerHTML,
    htmlAttrs: safeRootAttrs(doc.documentElement),
    bodyAttrs: safeRootAttrs(doc.body),
  };
}
