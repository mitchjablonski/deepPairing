/**
 * #680 slice 2 — the ANNOTATOR: a self-contained script injected FIRST into a
 * `page` artifact's sandboxed frame, before any agent markup.
 *
 * It lets the human point at the page instead of describing it:
 *  - hover → a dashed outline on the element under the pointer;
 *  - click → an `element` anchor;
 *  - mouseup with a non-empty selection → a `text` anchor (quote + prefix/suffix);
 *  - a click inside a `td`/`th` → a `cell` anchor with its row and column header text;
 *  - a click on a Mermaid node (`g.node`, `flowchart-*` ids) → a `diagram-node` anchor;
 *  - a click on a link → `preventDefault` (a page link NEVER navigates, so the
 *    frame can't leave the no-network document) and a `link` anchor — except a
 *    same-document `#hash` link, which scrolls the frame to its target (#714);
 *  - a click on `summary`, `label` or a form control keeps its default action
 *    (details open, CSS-only tabs switch); Alt/Option-click points at it, and
 *    holding Cmd/Ctrl lets any click through without pointing (#714);
 *  - Cmd/Ctrl+I inside the frame → `{dp:"toggle-pointing"}` to the parent, so
 *    the companion's pointing shortcut works while the reviewer is in the page.
 *
 * Each anchor is posted to `parent` as `{dp:"anchor", anchor}`. The target
 * origin is "*" because the frame's own origin is opaque and it cannot know the
 * parent's; the parent authenticates the message by `event.source` (the frame's
 * contentWindow) and re-validates the anchor with the shared Zod schema.
 *
 * The parent sends anchors back down as `{dp:"pins", anchors}`; the annotator
 * re-finds each (locator first, then the quote with prefix/suffix) and draws a
 * numbered outline pin, then reports which were found (`{dp:"pins-status",
 * found}`) so the parent can say "not found in this version". Pins are built
 * ONLY with DOM APIs and `textContent` — nothing the parent sends is ever parsed
 * as HTML. #714 gap 7: the pins message also carries `states` (open |
 * addressed: the pin's colour) and `ids` (the comment id per pin). A pin's
 * BADGE is a small click target, only while pointing is on and the page's
 * scripts aren't running (so it never takes a click the page would handle):
 * a click posts `{dp:"pin-click", id}` and hovering posts `{dp:"pin-hover",
 * id, x, y}` / `{dp:"pin-hover", id:null}`. The parent renders the preview
 * text; the frame never receives comment text. `{dp:"focus", index}` scrolls to a pin; `{dp:"mode", annotate}`
 * switches between annotating clicks and letting them through to the page (after
 * Run). Messages are accepted only from `parent`.
 *
 * #714 gap 2 — `{dp:"changes", marks, show}` carries the blocks that changed
 * since the previous version, as `{kind, tag, text, occurrence}` locators the
 * companion computed from the parsed (never executed) HTML. Each is checked
 * field by field, re-found by tag + clipped text, and drawn as a change bar
 * (DOM APIs and textContent only) while `show` is true; `{dp:"changes-status",
 * found}` reports which were found and `{dp:"focus-change", index}` scrolls to
 * one.
 *
 * #714 gaps 4+5 — on ready and after relevant changes (debounced) the
 * annotator reports `{dp:"outline", headings, pins, changes}` (h1–h3 as
 * {level, text, locator}, capped at 200 and 120 chars, plus the section index
 * each pin and change mark sits in) and `{dp:"asks", asks}` (elements marked
 * data-dp-decision / data-dp-question as {kind, text, locator, id?}, capped at
 * 50 and 200 chars), each only when it changed. While the frame scrolls it
 * reports the current section, throttled, as `{dp:"outline-active", index}`.
 * `{dp:"focus-heading"|"focus-ask", index, locator}` scrolls to one. These are
 * display-only hints: after Run agent script could post its own.
 *
 * Written as plain JS inside `String.raw` (so no `${` or backticks below) and
 * split into a CORE (pure helpers: locator building, quote extraction,
 * re-finding) and a MAIN (event wiring), so jsdom tests can evaluate the exact
 * shipped source and call the helpers directly. Must never contain a closing
 * script tag: it is inlined into the frame document.
 */

/** Function body; parameters `(document, window)`; returns the helper object. */
export const ANNOTATOR_CORE_SOURCE = String.raw`
"use strict";
var LIMITS = { locator: 512, quote: 280, affix: 32, header: 200, nodeId: 200, href: 512 };
var SKIP = "script,style,noscript,template,[data-dp-annotator]";
var STABLE_DATA = ["data-testid", "data-test", "data-id", "data-key", "data-name"];
var NODE_SEL = "g.node, g[id^='flowchart-'], g[id*='-flowchart-']";
var LINK_SEL = "a[href], area[href]";

function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
function isWs(ch) { return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f"; }
function isEl(n) { return !!n && n.nodeType === 1; }
function elementOf(n) { return !n ? null : n.nodeType === 1 ? n : n.parentElement; }

function cssEscape(v) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(v);
  var s = String(v), out = "";
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i), code = s.charCodeAt(i);
    if (code === 0) { out += String.fromCharCode(65533); continue; }
    if ((code >= 1 && code <= 31) || code === 127 ||
        (i === 0 && code >= 48 && code <= 57) ||
        (i === 1 && code >= 48 && code <= 57 && s.charCodeAt(0) === 45)) {
      out += "\\" + code.toString(16) + " "; continue;
    }
    if (i === 0 && s.length === 1 && code === 45) { out += "\\-"; continue; }
    if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) { out += ch; continue; }
    out += "\\" + ch;
  }
  return out;
}
function attrEscape(v) { return String(v).replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }
function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
function safeQuery(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
function nthOfType(el) {
  var i = 1, s = el.previousElementSibling;
  while (s) { if (s.localName === el.localName) i++; s = s.previousElementSibling; }
  return i;
}

/** A CSS path: #id when unique, else a unique stable data-* attribute, else
 *  tag:nth-of-type steps up to body. Capped by dropping leading steps. */
function buildLocator(el) {
  if (!isEl(el)) return "body";
  var segs = [], node = el;
  while (isEl(node)) {
    if (node === document.documentElement) { segs.unshift("html"); break; }
    if (node === document.body) { segs.unshift("body"); break; }
    if (node.id) {
      var idSel = "#" + cssEscape(node.id);
      if (unique(idSel)) { segs.unshift(idSel); break; }
    }
    var dataSel = null;
    for (var i = 0; i < STABLE_DATA.length; i++) {
      var v = node.getAttribute(STABLE_DATA[i]);
      if (v) {
        var ds = cssEscape(node.localName) + "[" + STABLE_DATA[i] + "=\"" + attrEscape(v) + "\"]";
        if (unique(ds)) { dataSel = ds; break; }
      }
    }
    if (dataSel) { segs.unshift(dataSel); break; }
    segs.unshift(cssEscape(node.localName) + ":nth-of-type(" + nthOfType(node) + ")");
    node = node.parentElement;
  }
  var out = segs.join(" > ");
  while (out.length > LIMITS.locator && segs.length > 1) { segs.shift(); out = segs.join(" > "); }
  return clip(out || "body", LIMITS.locator);
}

/** Whitespace-normalized visible text of a subtree (script/style/our own
 *  elements skipped), with the text nodes it came from so a normalized offset
 *  maps back to a DOM position. */
function textIndex(root) {
  var parts = [], text = "", lastSpace = true;
  if (!root) return { text: text, parts: parts };
  var walker = document.createTreeWalker(root, 4, null);
  var n;
  while ((n = walker.nextNode())) {
    var p = n.parentNode;
    if (p && p.closest && p.closest(SKIP)) continue;
    var raw = n.nodeValue || "";
    var part = { node: n, start: text.length, lead: lastSpace, end: 0 };
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (isWs(ch)) { if (!lastSpace) { text += " "; lastSpace = true; } }
      else { text += ch; lastSpace = false; }
    }
    part.end = text.length;
    parts.push(part);
  }
  return { text: text, parts: parts };
}
function normOffset(part, rawOff) {
  var raw = part.node.nodeValue || "", idx = part.start, ls = part.lead;
  for (var i = 0; i < rawOff && i < raw.length; i++) {
    if (isWs(raw.charAt(i))) { if (!ls) { idx++; ls = true; } } else { idx++; ls = false; }
  }
  return idx;
}
function rawStart(part, nIdx) {
  var raw = part.node.nodeValue || "", idx = part.start, ls = part.lead;
  for (var i = 0; i < raw.length; i++) {
    if (idx >= nIdx && !isWs(raw.charAt(i))) return i;
    if (isWs(raw.charAt(i))) { if (!ls) { idx++; ls = true; } } else { idx++; ls = false; }
  }
  return raw.length;
}
function rawEnd(part, nEnd) {
  var raw = part.node.nodeValue || "", idx = part.start, ls = part.lead;
  for (var i = 0; i < raw.length; i++) {
    if (isWs(raw.charAt(i))) { if (!ls) { idx++; ls = true; } } else { idx++; ls = false; }
    if (idx >= nEnd) return i + 1;
  }
  return raw.length;
}
function pointIndex(index, container, offset) {
  if (container && container.nodeType === 3) {
    for (var i = 0; i < index.parts.length; i++) {
      if (index.parts[i].node === container) return normOffset(index.parts[i], offset);
    }
  }
  var r = document.createRange();
  try { r.setStart(container, offset); } catch (e) { return index.text.length; }
  r.collapse(true);
  for (var j = 0; j < index.parts.length; j++) {
    try { if (r.comparePoint(index.parts[j].node, 0) >= 0) return index.parts[j].start; } catch (e2) { /* skip */ }
  }
  return index.text.length;
}
function rangeFor(index, s, e) {
  var startPart = null, endPart = null;
  for (var i = 0; i < index.parts.length; i++) {
    var pt = index.parts[i];
    if (!startPart && pt.end > s) startPart = pt;
    if (pt.start < e && pt.end >= e) { endPart = pt; break; }
  }
  if (!startPart || !endPart) return null;
  var r = document.createRange();
  try {
    r.setStart(startPart.node, rawStart(startPart, s));
    r.setEnd(endPart.node, rawEnd(endPart, e));
  } catch (err) { return null; }
  return r;
}

/** Every occurrence of the quote in normalized text, each scored on its
 *  saved context: +2 when the text before it ends with the prefix, +2 when the
 *  text after it starts with the suffix. */
function quoteHits(text, quote, prefix, suffix) {
  var q = norm(quote), out = [];
  if (!q) return out;
  var p = norm(prefix), sx = norm(suffix);
  var from = 0, guard = 0, i;
  while ((i = text.indexOf(q, from)) !== -1 && guard++ < 2000) {
    var score = 0;
    if (p && norm(text.slice(Math.max(0, i - p.length - 2), i)).slice(-p.length) === p) score += 2;
    if (sx && norm(text.slice(i + q.length, i + q.length + sx.length + 2)).slice(0, sx.length) === sx) score += 2;
    out.push({ at: i, score: score });
    from = i + 1;
  }
  return out;
}
/** The single best-supported occurrence, or -1 when absent OR tied: a tie
 *  means the page no longer says which one was meant. */
function findQuote(text, quote, prefix, suffix) {
  var hits = quoteHits(text, quote, prefix, suffix);
  var best = -1, bestScore = -1, tied = false;
  for (var i = 0; i < hits.length; i++) {
    if (hits[i].score > bestScore) { best = hits[i].at; bestScore = hits[i].score; tied = false; }
    else if (hits[i].score === bestScore) tied = true;
  }
  return tied ? -1 : best;
}

function elementText(el) {
  var t = norm(textIndex(el).text);
  if (!t && el && el.getAttribute) {
    t = norm(el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "");
  }
  return t;
}

function elementAnchor(el) {
  return { kind: "element", locator: buildLocator(el), quote: clip(elementText(el), LIMITS.quote) };
}
function linkAnchor(link) {
  var a = { kind: "link", locator: buildLocator(link), quote: clip(elementText(link), LIMITS.quote) };
  var href = link.getAttribute("href");
  if (href) a.href = clip(href, LIMITS.href);
  return a;
}
function mermaidNodeId(g) {
  var d = g.getAttribute && g.getAttribute("data-id");
  if (d) return clip(d, LIMITS.nodeId);
  var id = g.id || "";
  var m = /(?:^|-)flowchart-(.+)-\d+$/.exec(id);
  return clip(m ? m[1] : id, LIMITS.nodeId);
}
function nodeAnchor(g) {
  var a = { kind: "diagram-node", locator: buildLocator(g), quote: clip(elementText(g), LIMITS.quote) };
  var id = mermaidNodeId(g);
  if (id) a.nodeId = id;
  return a;
}
function isCell(n) { return isEl(n) && (n.localName === "td" || n.localName === "th"); }
function spanOf(c) { var n = parseInt(c.getAttribute("colspan") || "1", 10); return n > 0 ? n : 1; }
function cellsOf(row) {
  var out = [];
  for (var c = row.firstElementChild; c; c = c.nextElementSibling) if (isCell(c)) out.push(c);
  return out;
}
function rowsOf(table) {
  var all = table.querySelectorAll("tr"), out = [];
  for (var i = 0; i < all.length; i++) if (all[i].closest("table") === table) out.push(all[i]);
  return out;
}
function colIndex(cell) {
  var i = 0, s = cell.previousElementSibling;
  while (s) { if (isCell(s)) i += spanOf(s); s = s.previousElementSibling; }
  return i;
}
function cellAt(row, col) {
  var cells = cellsOf(row), i = 0;
  for (var k = 0; k < cells.length; k++) {
    var span = spanOf(cells[k]);
    if (col >= i && col < i + span) return cells[k];
    i += span;
  }
  return null;
}
function headerRow(table) {
  var rows = rowsOf(table), i;
  for (i = 0; i < rows.length; i++) {
    var p = rows[i].parentElement;
    if (p && p.localName === "thead") return rows[i];
  }
  for (i = 0; i < rows.length; i++) {
    var cells = cellsOf(rows[i]);
    if (!cells.length) continue;
    for (var j = 0; j < cells.length; j++) if (cells[j].localName !== "th") return null;
    return rows[i];
  }
  return null;
}
function cellAnchor(cell) {
  var a = { kind: "cell", locator: buildLocator(cell), quote: clip(elementText(cell), LIMITS.quote) };
  var row = cell.parentElement, table = cell.closest("table"), t = {};
  if (table && row && row.localName === "tr") {
    var hr = headerRow(table);
    if (hr && hr !== row) {
      var hc = cellAt(hr, colIndex(cell));
      var ht = hc ? elementText(hc) : "";
      if (ht) t.col = clip(ht, LIMITS.header);
    } else if (hr === row) {
      var own = elementText(cell);
      if (own) t.col = clip(own, LIMITS.header);
    }
    if (hr !== row) {
      var rh = null;
      for (var c = row.firstElementChild; c; c = c.nextElementSibling) { if (isEl(c) && c.localName === "th") { rh = c; break; } }
      if (!rh) rh = cellAt(row, 0);
      var rt = rh ? elementText(rh) : "";
      if (rt) t.row = clip(rt, LIMITS.header);
    }
  }
  if (t.row || t.col) a.table = t;
  return a;
}
function textAnchor(range) {
  var body = document.body || document.documentElement;
  var index = textIndex(body);
  var s = pointIndex(index, range.startContainer, range.startOffset);
  var e = pointIndex(index, range.endContainer, range.endOffset);
  var quote = e > s ? norm(index.text.slice(s, e)) : "";
  if (!quote) quote = norm(range.toString());
  if (!quote) return null;
  var common = elementOf(range.commonAncestorContainer) || body;
  var a = { kind: "text", locator: buildLocator(common), quote: clip(quote, LIMITS.quote) };
  var prefix = norm(index.text.slice(Math.max(0, s - LIMITS.affix), s));
  var suffix = norm(index.text.slice(e, e + LIMITS.affix));
  if (prefix) a.prefix = clip(prefix, LIMITS.affix);
  if (suffix) a.suffix = clip(suffix, LIMITS.affix);
  return a;
}
/** What a click on this target points at: link, then Mermaid node, then table
 *  cell, else the element itself. */
function anchorForTarget(t) {
  var el = elementOf(t);
  if (!el || !el.closest) return null;
  var link = el.closest(LINK_SEL);
  if (link) return linkAnchor(link);
  var node = el.closest(NODE_SEL);
  if (node) return nodeAnchor(node);
  var cell = el.closest("td, th");
  if (cell) return cellAnchor(cell);
  return elementAnchor(el);
}

function textMatches(el, quote) {
  var q = norm(quote);
  if (!q) return true;
  return elementText(el).indexOf(q.slice(0, 60)) !== -1;
}
/** The normalized page text just before / after an element, for checking a
 *  saved prefix/suffix against an element candidate. */
function contextOf(el, bodyIndex) {
  var r = document.createRange();
  try { r.selectNodeContents(el); } catch (e) { return { before: "", after: "" }; }
  var s = pointIndex(bodyIndex, r.startContainer, r.startOffset);
  var e = pointIndex(bodyIndex, r.endContainer, r.endOffset);
  return { before: bodyIndex.text.slice(Math.max(0, s - 40), s), after: bodyIndex.text.slice(e, e + 40) };
}
function closestOf(el, kind) {
  var want = kind === "cell" ? "td, th" : kind === "link" ? LINK_SEL : kind === "diagram-node" ? NODE_SEL : null;
  if (!want) return el;
  return el && el.closest ? el.closest(want) : null;
}
/** Does this element carry the anchor's identity? Required checks: the kind's
 *  element type, the quote, a cell's saved row/column headers, a node's id, a
 *  link's href. Returns a support score (>= 0) or -1 when it is not the spot. */
function support(a, el, bodyIndex, fromLocator) {
  var kind = String(a.kind || "");
  if (!isEl(el)) return -1;
  if (kind === "cell" && !isCell(el)) return -1;
  if (kind === "link" && !(el.matches && el.matches(LINK_SEL))) return -1;
  if (kind === "diagram-node" && !(el.matches && el.matches(NODE_SEL))) return -1;
  var idMatch = kind === "diagram-node" && typeof a.nodeId === "string" && a.nodeId && mermaidNodeId(el) === a.nodeId;
  // A saved Mermaid node id is identity enough: a revision may relabel the node.
  if (!idMatch && !textMatches(el, a.quote)) return -1;
  if (kind === "cell" && a.table && typeof a.table === "object") {
    var t = cellAnchor(el).table || {};
    if (typeof a.table.row === "string" && a.table.row && t.row !== a.table.row) return -1;
    if (typeof a.table.col === "string" && a.table.col && t.col !== a.table.col) return -1;
  }
  if (kind === "diagram-node" && typeof a.nodeId === "string" && a.nodeId && mermaidNodeId(el) !== a.nodeId) return -1;
  if (kind === "link" && typeof a.href === "string" && a.href && el.getAttribute("href") !== a.href) return -1;
  var score = fromLocator ? 1 : 0;
  var p = norm(a.prefix), sx = norm(a.suffix);
  if (p || sx) {
    var ctx = contextOf(el, bodyIndex);
    if (p && norm(ctx.before).slice(-p.length) === p) score += 2;
    if (sx && norm(ctx.after).slice(0, sx.length) === sx) score += 2;
  }
  return score;
}
/** Re-find an anchor in the current document. Every candidate (the saved
 *  locator's element, elements carrying the saved node id / href, and each
 *  place the quote occurs) must pass the identity checks first; the locator
 *  only adds support. The single best-supported candidate wins; a tie, or no
 *  candidate, is "not found" rather than a guess. Returns {el, range} or null. */
function findAnchor(a) {
  if (!a || typeof a !== "object") return null;
  var kind = String(a.kind || "");
  var quote = typeof a.quote === "string" ? a.quote : "";
  var prefix = typeof a.prefix === "string" ? a.prefix : "";
  var suffix = typeof a.suffix === "string" ? a.suffix : "";
  var body = document.body || document.documentElement;
  var bodyIndex = textIndex(body);
  var locEl = typeof a.locator === "string" && a.locator ? safeQuery(a.locator) : null;
  var i, j;
  if (kind === "text") {
    var hits = quoteHits(bodyIndex.text, quote, prefix, suffix);
    var qlen = norm(quote).length, scored = [];
    for (i = 0; i < hits.length; i++) {
      var r = rangeFor(bodyIndex, hits[i].at, hits[i].at + qlen);
      if (!r) continue;
      var host = elementOf(r.commonAncestorContainer);
      var inLoc = !!(locEl && host && (locEl === host || locEl.contains(host)));
      scored.push({ el: host || body, range: r, score: hits[i].score + (inLoc ? 1 : 0) });
    }
    return pickBest(scored);
  }
  // Candidates are deduplicated on exact node identity only; every one is
  // validated on its own below. An equal-text wrapper and the real target are
  // separate candidates, so a wrapper that fails the kind/identity checks can
  // never stand in for (or suppress) the right element.
  var cands = [];
  function add(el, fromLocator) {
    if (!isEl(el)) return;
    for (var k = 0; k < cands.length; k++) {
      if (cands[k].el === el) { if (fromLocator) cands[k].fromLocator = true; return; }
    }
    cands.push({ el: el, fromLocator: !!fromLocator });
  }
  if (locEl) add(locEl, true);
  if (kind === "diagram-node" && typeof a.nodeId === "string" && a.nodeId) {
    var nodes = document.querySelectorAll(NODE_SEL);
    for (j = 0; j < nodes.length; j++) if (mermaidNodeId(nodes[j]) === a.nodeId) add(nodes[j], false);
  }
  if (kind === "link" && typeof a.href === "string" && a.href) {
    var links = document.querySelectorAll(LINK_SEL);
    for (j = 0; j < links.length; j++) if (links[j].getAttribute("href") === a.href) add(links[j], false);
  }
  if (norm(quote)) {
    var qh = quoteHits(bodyIndex.text, quote, "", "");
    var ql = norm(quote).length;
    for (i = 0; i < qh.length; i++) {
      var rr = rangeFor(bodyIndex, qh[i].at, qh[i].at + ql);
      var h = rr ? closestOf(elementOf(rr.commonAncestorContainer), kind) : null;
      if (h) add(h, false);
    }
  }
  var out = [];
  for (i = 0; i < cands.length; i++) {
    var sc = support(a, cands[i].el, bodyIndex, cands[i].fromLocator);
    if (sc >= 0) out.push({ el: cands[i].el, range: null, score: sc });
  }
  return pickBest(out);
}
function pickBest(list) {
  var best = null, tied = false;
  for (var i = 0; i < list.length; i++) {
    if (!best || list[i].score > best.score) { best = list[i]; tied = false; }
    else if (list[i].score === best.score) tied = true;
  }
  return best && !tied ? { el: best.el, range: best.range } : null;
}

/** #714 gap 2 — a version-change locator {tag, text, occurrence}, computed by
 *  the companion from the parsed (never executed) page. clippedText MUST read
 *  text exactly as the companion's pageVersionDiff.clippedText does (a parity
 *  test runs both on shared fixtures): whitespace collapsed, br is a space,
 *  each table cell after the first in its row starts with " | " (even after
 *  empty cells), an input adds its rendered label/value, and empty text falls
 *  back to alt/aria-label/title/value, then a descendant image's alt. Our own
 *  layer is skipped by its element name, never by an attribute an author
 *  could also write. Must equal pageVersionDiff's TEXT_SKIP_SELECTOR. */
var CHANGE_SKIP = "script,style,noscript,template,iframe,frame,frameset,object,embed,applet,portal,dp-annotator-layer";
function inChangeSkip(el) { return !!(el && el.closest && el.closest(CHANGE_SKIP)); }
function laterCell(e) {
  for (var s = e.previousElementSibling; s; s = s.previousElementSibling) {
    var st = String(s.localName).toLowerCase();
    if (st === "td" || st === "th") return true;
  }
  return false;
}
var BUTTON_INPUTS = { submit: "Submit", reset: "Reset", button: "" };
var TEXT_INPUTS = { "": 1, text: 1, search: 1, email: 1, url: 1, tel: 1, number: 1 };
/** What an input shows as text: a button's value attribute (or its default
 *  label), a text-like field's value ATTRIBUTE (never live typing). */
function inputText(e) {
  var type = String(e.getAttribute("type") || "").trim().toLowerCase();
  var v = e.getAttribute("value");
  if (Object.prototype.hasOwnProperty.call(BUTTON_INPUTS, type)) return v !== null ? v : BUTTON_INPUTS[type];
  if (Object.prototype.hasOwnProperty.call(TEXT_INPUTS, type)) return v !== null ? v : "";
  return "";
}
function clippedText(el, max) {
  var walker = document.createTreeWalker(el, 5, null), text = "", lastSpace = true, n;
  function space() { if (!lastSpace) { text += " "; lastSpace = true; } }
  function chars(raw) {
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (isWs(ch)) space();
      else { text += ch; lastSpace = false; }
      if (text.length > max) return true;
    }
    return false;
  }
  while ((n = walker.nextNode())) {
    if (n.nodeType === 1) {
      if (inChangeSkip(n)) continue;
      var tag = String(n.localName).toLowerCase();
      if (tag === "br") space();
      else if (tag === "td" || tag === "th") { if (laterCell(n)) { space(); text += "| "; lastSpace = true; } }
      else if (tag === "input" && chars(inputText(n))) break;
      continue;
    }
    if (inChangeSkip(n.parentElement)) continue;
    if (chars(n.nodeValue || "")) break;
  }
  var t = norm(text);
  if (!t && el.getAttribute) t = norm(el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "");
  if (!t && el.getElementsByTagName) {
    var imgs = el.getElementsByTagName("img");
    for (var k = 0; k < imgs.length && !t; k++) if (!inChangeSkip(imgs[k])) t = norm(imgs[k].getAttribute("alt") || "");
  }
  return clip(t, max);
}
/** Re-find each locator: the occurrence-th element of its tag whose clipped
 *  text equals its text, else the first such element (the page changed after
 *  Run), else null. Each tag's text index is built once and kept in cache
 *  (the caller drops it when the page itself changes). */
function findChanges(list, cache) {
  var byTag = cache && typeof cache === "object" ? cache : {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!c) { out.push(null); continue; }
    var idx = Object.prototype.hasOwnProperty.call(byTag, c.tag) ? byTag[c.tag] : null;
    if (!idx) {
      idx = [];
      var els = document.getElementsByTagName(c.tag);
      for (var j = 0; j < els.length; j++) {
        if (inChangeSkip(els[j])) continue;
        idx.push({ el: els[j], text: clippedText(els[j], LIMITS.quote) });
      }
      byTag[c.tag] = idx;
    }
    var seen = 0, first = null, hit = null;
    for (var k = 0; k < idx.length; k++) {
      if (idx[k].text !== c.text || !idx[k].el.isConnected) continue;
      if (!first) first = idx[k].el;
      if (seen === c.occurrence) { hit = idx[k].el; break; }
      seen++;
    }
    out.push(hit || first);
  }
  return out;
}

/** #714 gaps 4+5 — the page's shape and its asks, collected for the parent
 *  as display-only hints (after Run agent script shares the frame and could
 *  post its own). Every list and string is capped. */
var OUTLINE = { max: 200, text: 120, asks: 50, askText: 200, id: 200 };
var HEADING_SEL = "h1, h2, h3";
var ASK_SEL = "[data-dp-decision], [data-dp-question]";
/** The first max characters of elementText(el), without reading the rest of
 *  a big subtree: the same walk and whitespace rule as textIndex, stopped
 *  early. Equal to clip(elementText(el), max), so an element anchor built
 *  from it re-finds like one from a click. */
function textPrefix(el, max) {
  var walker = document.createTreeWalker(el, 4, null), text = "", lastSpace = true, n;
  outer: while ((n = walker.nextNode())) {
    var p = n.parentNode;
    if (p && p.closest && p.closest(SKIP)) continue;
    var raw = n.nodeValue || "";
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (isWs(ch)) { if (!lastSpace) { text += " "; lastSpace = true; } }
      else { text += ch; lastSpace = false; }
      if (text.length > max) break outer;
    }
  }
  var t = norm(text);
  if (!t && el.getAttribute) {
    t = norm(el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "");
  }
  return clip(t, max);
}
/** h1–h3 in document order, as {el, level, text, locator}; untitled headings
 *  and unrendered subtrees skipped, capped at OUTLINE.max. */
function collectHeadings() {
  var els = document.querySelectorAll(HEADING_SEL), out = [];
  for (var i = 0; i < els.length && out.length < OUTLINE.max; i++) {
    var el = els[i];
    if (inChangeSkip(el) || el.closest(SKIP)) continue;
    var text = textPrefix(el, OUTLINE.text);
    if (!text) continue;
    out.push({ el: el, level: Number(String(el.localName).charAt(1)), text: text, locator: buildLocator(el) });
  }
  return out;
}
/** Elements marked data-dp-decision / data-dp-question, as {el, kind, text,
 *  locator, id?}; decision wins when both are set. Capped at OUTLINE.asks. */
function collectAsks() {
  var els = document.querySelectorAll(ASK_SEL), out = [];
  for (var i = 0; i < els.length && out.length < OUTLINE.asks; i++) {
    var el = els[i];
    if (inChangeSkip(el) || el.closest(SKIP)) continue;
    var a = { el: el, kind: el.hasAttribute("data-dp-decision") ? "decision" : "question",
      text: textPrefix(el, OUTLINE.askText), locator: buildLocator(el) };
    var id = el.id;
    if (typeof id === "string" && id && id.length <= OUTLINE.id) a.id = id;
    out.push(a);
  }
  return out;
}
/** Which heading's section an element sits in: the last heading at or before
 *  it in document order (binary search), or the first heading INSIDE it (a
 *  comment on a whole <section> belongs to that section's heading). -1 =
 *  before the first heading. */
function sectionOf(el, heads) {
  if (!isEl(el) || !heads.length) return -1;
  var lo = 0, hi = heads.length - 1, idx = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1, h = heads[mid];
    if (h === el || (h.compareDocumentPosition(el) & 4)) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  var next = heads[idx + 1];
  if (next && el !== next && el.contains(next)) return idx + 1;
  return idx;
}

return {
  LIMITS: LIMITS,
  LINK_SEL: LINK_SEL,
  norm: norm,
  clip: clip,
  cssEscape: cssEscape,
  buildLocator: buildLocator,
  textIndex: textIndex,
  findQuote: findQuote,
  findAnchor: findAnchor,
  textAnchor: textAnchor,
  anchorForTarget: anchorForTarget,
  elementAnchor: elementAnchor,
  linkAnchor: linkAnchor,
  nodeAnchor: nodeAnchor,
  cellAnchor: cellAnchor,
  mermaidNodeId: mermaidNodeId,
  CHANGE_SKIP: CHANGE_SKIP,
  clippedText: clippedText,
  findChanges: findChanges,
  OUTLINE: OUTLINE,
  HEADING_SEL: HEADING_SEL,
  ASK_SEL: ASK_SEL,
  safeQuery: safeQuery,
  textPrefix: textPrefix,
  collectHeadings: collectHeadings,
  collectAsks: collectAsks,
  sectionOf: sectionOf
};
`;

/** Function body; parameters `(document, window, parent, core)`; installs the
 *  listeners and returns an uninstall function. */
export const ANNOTATOR_MAIN_SOURCE = String.raw`
"use strict";
var annotate = true, scripts = false, suppressClick = false, hoverBox = null, layer = null;
var current = [], lastFound = null, pending = 0, pinEls = [];
// #714 gap 7 — per pin: its colour state and the comment id a click on its
// badge reports back (validated here; nothing else from the parent is used).
var pinStates = [], pinIds = [], hoverPin = null;
var PIN_COLORS = { open: "#f59e0b", addressed: "#9ca3af" };
/** Badge element → comment id, by reference: an authored element named like
 *  our badge can never pose as a pin (ownership is never read from markup). */
var badgeIds = typeof WeakMap === "function" ? new WeakMap() : null;
/** #714 gap 5 — the parent's tag for the pin list it sent, echoed on every
 *  report computed from that list (pins-status, asks), so the parent never
 *  attributes a report to a list that changed while it was in flight. */
var pinsKey = null;
function withKey(msg) { if (pinsKey !== null) msg.key = pinsKey; return msg; }
// #714 gap 2 — version-change marks (validated locators) and their toggle.
var changes = [], showChanges = false, lastChangesFound = null;
/** Our own nodes, by reference: an authored element can carry the marker
 *  attribute too, so ownership is never inferred from markup (#715 review). */
var ownNodes = typeof WeakSet === "function" ? new WeakSet() : null;
function own(el) {
  if (!ownNodes) return false;
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) if (ownNodes.has(n)) return true;
  return false;
}
function post(msg) { try { parent.postMessage(msg, "*"); } catch (e) { /* parent gone */ } }
function important(el, styles) {
  for (var k in styles) if (Object.prototype.hasOwnProperty.call(styles, k)) el.style.setProperty(k, styles[k], "important");
}
function mk(tag) {
  var el = document.createElement(tag);
  el.setAttribute("data-dp-annotator", "");
  if (ownNodes) ownNodes.add(el);
  return el;
}
function ensureLayer() {
  if (layer && layer.isConnected) return layer;
  layer = mk("dp-annotator-layer");
  important(layer, { position: "absolute", left: "0", top: "0", width: "0", height: "0", margin: "0", padding: "0",
    border: "0", "pointer-events": "none", "z-index": "2147483647", display: "block", overflow: "visible" });
  (document.documentElement || document.body).appendChild(layer);
  return layer;
}
function rectOf(hit) {
  var r = null;
  if (hit.range && typeof hit.range.getBoundingClientRect === "function") {
    try { r = hit.range.getBoundingClientRect(); } catch (e) { r = null; }
  }
  if ((!r || (!r.width && !r.height)) && hit.el && hit.el.getBoundingClientRect) r = hit.el.getBoundingClientRect();
  return r;
}
function place(box, r) {
  var sx = window.scrollX || window.pageXOffset || 0, sy = window.scrollY || window.pageYOffset || 0;
  important(box, { left: (r.left + sx - 2) + "px", top: (r.top + sy - 2) + "px",
    width: (r.width + 4) + "px", height: (r.height + 4) + "px" });
}
function targetEl(e) {
  var t = e.target;
  if (t && t.nodeType !== 1) t = t.parentElement;
  return t && t.nodeType === 1 ? t : null;
}
function hideHover() { if (hoverBox) important(hoverBox, { display: "none" }); }
/** #714 — what the page's own controls should keep doing while pointing: a
 *  same-document "#hash" link with a target (scrolls) and native controls (a
 *  summary opens its details, a label/radio/checkbox switches radio/checkbox
 *  tabs, form fields take input). Buttons only once the page's scripts run:
 *  before Run a button has no default action (no scripts, no allow-forms), so
 *  a click on it points as before. A label passes only for a click on its own
 *  text or inline content, never on block content inside it (a label-wrapped
 *  card stays commentable). Alt/Option-click still points at any of these. */
var PASS_SEL = "summary, input, select, textarea, option, optgroup";
var BUTTON_SEL = "button, input[type=button], input[type=submit], input[type=reset], input[type=image]";
var BLOCK_TAGS = /^(address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|img|li|main|nav|ol|p|pre|section|svg|table|ul|video|canvas)$/;
var XLINK = "http://www.w3.org/1999/xlink";
/** The link a click is inside: HTML a/area[href], or an SVG <a> with
 *  xlink:href (core.LINK_SEL misses those, and they navigate too). */
function closestLink(t) {
  if (!t || !t.closest) return null;
  var link = t.closest(core.LINK_SEL);
  if (link) return link;
  for (var n = t; n && n.nodeType === 1; n = n.parentElement) {
    if (n.localName === "a" && n.getAttributeNS && n.getAttributeNS(XLINK, "href") !== null) return n;
  }
  return null;
}
function hrefOf(link) {
  var h = link.getAttribute ? link.getAttribute("href") : null;
  if (h === null && link.getAttributeNS) h = link.getAttributeNS(XLINK, "href");
  return h;
}
function sameDocHash(link) {
  var h = link ? hrefOf(link) : null;
  if (typeof h !== "string") return null;
  h = h.trim();
  return h.charAt(0) === "#" ? h : null;
}
/** Where a "#hash" leads: an element, "top" (for "#" / "#top" with no such
 *  id), or null — no target (a "#!/route" hashbang, a stale id), in which case
 *  the click points at the link rather than doing nothing. */
function hashTarget(h) {
  var raw = h.slice(1), id = raw;
  try { id = decodeURIComponent(raw); } catch (e) { id = raw; }
  var el = id ? (document.getElementById(id) || document.getElementById(raw)) : null;
  if (!el && id) {
    var named = document.getElementsByName(id);
    for (var i = 0; i < named.length; i++) if (named[i].localName === "a") { el = named[i]; break; }
  }
  if (el) return el;
  return !id || id.toLowerCase() === "top" ? "top" : null;
}
/** Block-level by computed display (anything but inline* / contents), with
 *  the tag list as the fallback when computed style is unavailable. */
function isBlock(n) {
  var d = "";
  try { d = window.getComputedStyle ? String(window.getComputedStyle(n).display || "") : ""; } catch (e) { d = ""; }
  if (!d) return BLOCK_TAGS.test(n.localName);
  return d.indexOf("inline") !== 0 && d !== "contents";
}
function passLabel(t) {
  var label = t.closest("label");
  if (!label) return null;
  for (var n = t; n && n !== label; n = n.parentElement) if (isBlock(n)) return null;
  return label;
}
/** The details-toggling summary a button sits in, if any. */
function summaryOf(el) {
  var sum = el.closest("summary");
  var d = sum && sum.parentElement;
  if (!d || d.localName !== "details") return null;
  for (var c = d.firstElementChild; c; c = c.nextElementSibling) if (c.localName === "summary") return c === sum ? sum : null;
  return null;
}
function passTarget(t) {
  if (!t || !t.closest) return null;
  var link = closestLink(t);
  if (link) { var h = sameDocHash(link); return h !== null && hashTarget(h) ? link : null; }
  var btn = t.closest(BUTTON_SEL);
  // Before Run a button has no action of its own; inside a summary the click
  // toggles the details instead (see onClick).
  if (btn) return scripts ? btn : summaryOf(btn);
  return t.closest(PASS_SEL) || passLabel(t);
}
/** Scroll the frame to a "#hash" target ourselves. The browser can't be left
 *  to do it: a srcdoc document resolves even "#x" against the COMPANION's URL,
 *  so the default action would navigate the frame away from the page. Opens
 *  any closed details around the target, as a fragment navigation does. */
function goTo(target) {
  if (target === "top") { try { window.scrollTo(0, 0); } catch (e2) { /* ignore */ } return; }
  for (var d = target.parentElement; d; d = d.parentElement) {
    if (d.localName === "details" && !d.open) d.open = true;
  }
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
}
function editable(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  var n = t.localName;
  return n === "input" || n === "textarea" || n === "select";
}
var lastHover = null;
function paintHover(t, alt, interact) {
  lastHover = t;
  if (!annotate || interact || !t || own(t) || t === document.documentElement || t === document.body) { hideHover(); return; }
  if (!hoverBox || !hoverBox.isConnected) {
    hoverBox = mk("dp-annotator-hover");
    important(hoverBox, { position: "absolute", "box-sizing": "border-box", "pointer-events": "none", margin: "0", padding: "0" });
    ensureLayer().appendChild(hoverBox);
  }
  // A control that keeps its own click gets a quiet grey outline; holding
  // Alt/Option (which points at it instead) turns it into the usual blue one.
  var pass = alt ? null : passTarget(t);
  if (pass) important(hoverBox, { outline: "1px dotted #94a3b8", background: "transparent" });
  else important(hoverBox, { outline: "2px dashed #3b82f6", background: "rgba(59,130,246,0.06)" });
  important(hoverBox, { display: "block" });
  place(hoverBox, (pass || t).getBoundingClientRect());
}
function onMove(e) {
  setModHeld(!!(e.ctrlKey || e.metaKey));
  var t = targetEl(e);
  var pid = badgesLive() && badgeOk && badgeOk.get(t) === true ? pinIdOf(t) : null;
  setHoverPin(pid, pid !== null ? t : null);
  paintHover(t, !!e.altKey, !!(e.ctrlKey || e.metaKey));
}
/** The pointer left the frame: drop any pin preview. */
function onOut(e) { if (!e.relatedTarget && hoverPin !== null) setHoverPin(null, null); }
function onKey(e) {
  if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "i" || e.key === "I")) {
    // The companion's pointing shortcut, forwarded: while the reviewer is in
    // the frame, the companion never sees the keystroke. Never while typing
    // in the page, never on autorepeat, and only before Run (after Run agent
    // script shares this frame, so the parent ignores it then anyway).
    if (e.repeat || scripts || editable(targetEl(e))) return;
    e.preventDefault();
    post({ dp: "toggle-pointing" });
    return;
  }
  if (e.key === "Control" || e.key === "Meta") setModHeld(!!(e.ctrlKey || e.metaKey) && e.type === "keydown");
  if ((e.key === "Alt" || e.key === "Control" || e.key === "Meta") && lastHover && lastHover.isConnected) {
    paintHover(lastHover, !!e.altKey, !!(e.ctrlKey || e.metaKey));
  }
}
function samePins(a, b) {
  if (!a || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** Re-resolve every anchor against the CURRENT document and redraw. Nothing
 *  about a target (element or rectangle) is cached between draws, so a pin
 *  follows its content after the page changes. */
/** #714 gap 7 — a pin's badge is a click target only while a click there
 *  would have POINTED anyway (pointing on, page scripts not running): it never
 *  takes a click the page itself would have handled. The layer and the pin's
 *  outline stay pointer-events:none. */
var modHeld = false;
function badgesLive() { return annotate && !scripts && !modHeld; }
/** Per badge: may it ever take clicks? False when what lies under it is a
 *  control that keeps its own click (passTarget: summary, label text, form
 *  fields, #hash links, buttons after Run), so a badge never sits as a lid on
 *  a native page action. Set at draw time, by reference. */
var badgeOk = typeof WeakMap === "function" ? new WeakMap() : null;
/** The page element under a frame-viewport point, skipping our own nodes. */
function pageElAt(x, y) {
  if (typeof document.elementsFromPoint !== "function") return null;
  var list = [];
  try { list = document.elementsFromPoint(x, y) || []; } catch (e) { list = []; }
  for (var i = 0; i < list.length; i++) if (!own(list[i]) && list[i] !== layer) return list[i];
  return null;
}
function nativeUnder(el) {
  if (!el || el.nodeType !== 1) return false;
  return !!passTarget(el) || editable(el);
}
/** Would this badge cover a native control? Hit-tests the page under the
 *  badge's centre and corners. A badge off screen is never live until a redraw finds it on
 *  screen (scrolling redraws). */
function badgeCoversNative(badge) {
  // No hit-testing (old engines, test DOMs): we can't know what lies under
  // the offset badge, so it stays inert (conservative).
  if (typeof document.elementsFromPoint !== "function") return true;
  var r = badge.getBoundingClientRect();
  var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  if (!r.width || r.right < 0 || r.bottom < 0 || (vw && r.left > vw) || (vh && r.top > vh)) return true;
  var pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]];
  for (var i = 0; i < pts.length; i++) if (nativeUnder(pageElAt(pts[i][0], pts[i][1]))) return true;
  return false;
}
function setModHeld(v) {
  if (v === modHeld) return;
  modHeld = v;
  syncBadges();
}
function pinIdOf(t) {
  if (!badgeIds || !t || t.nodeType !== 1) return null;
  var id = badgeIds.get(t);
  return typeof id === "string" ? id : null;
}
function syncBadges() {
  var live = badgesLive();
  var bs = layer ? layer.querySelectorAll("dp-annotator-badge") : [];
  for (var i = 0; i < bs.length; i++) {
    if (pinIdOf(bs[i]) === null) continue;
    var on = live && !!badgeOk && badgeOk.get(bs[i]) === true;
    important(bs[i], { "pointer-events": on ? "auto" : "none", cursor: on ? "pointer" : "default" });
  }
  if (!live) setHoverPin(null, null);
}
/** Tell the parent which pin the pointer is over (it renders the preview
 *  from its own data; the frame never holds comment text). */
function setHoverPin(id, el) {
  if (id === hoverPin) return;
  hoverPin = id;
  if (id === null || !el) { post({ dp: "pin-hover", id: null }); return; }
  var r = el.getBoundingClientRect();
  post({ dp: "pin-hover", id: id, x: r.left, y: r.bottom });
}
function drawPins() {
  var l = ensureLayer();
  var olds = l.querySelectorAll("dp-annotator-pin");
  for (var i = 0; i < olds.length; i++) olds[i].remove();
  var hoverStill = false;
  var found = [];
  pinEls = [];
  for (var j = 0; j < current.length; j++) {
    var hit = null;
    try { hit = core.findAnchor(current[j]); } catch (e) { hit = null; }
    found.push(!!hit);
    pinEls.push(hit && hit.el ? hit.el : null);
    if (!hit) continue;
    var r = rectOf(hit);
    if (!r) continue;
    var state = pinStates[j] === "addressed" ? "addressed" : "open";
    var color = PIN_COLORS[state];
    var pin = mk("dp-annotator-pin");
    pin.setAttribute("data-dp-pin", String(j));
    pin.setAttribute("data-dp-pin-state", state);
    important(pin, { position: "absolute", display: "block", "box-sizing": "border-box", outline: pinOutline(state),
      background: "transparent", "pointer-events": "none", margin: "0", padding: "0" });
    place(pin, r);
    var badge = mk("dp-annotator-badge");
    badge.textContent = String(j + 1);
    var id = pinIds[j];
    if (id && badgeIds) badgeIds.set(badge, id);
    // Fully OUTSIDE the anchored element's top-left corner (the pin box is
    // the element +2px; the 18px badge ends 2px before it), so it never sits
    // on the element's own interactive area.
    important(badge, { position: "absolute", left: "-20px", top: "-20px", display: "block", "box-sizing": "border-box",
      "min-width": "18px", height: "18px", padding: "0 4px", "border-radius": "9px", background: color,
      color: "#111", font: "600 11px/18px system-ui, sans-serif", "text-align": "center",
      "pointer-events": "none", cursor: "default" });
    pin.appendChild(badge);
    l.appendChild(pin);
    var ok = !!id && !!badgeIds && !!badgeOk && !badgeCoversNative(badge);
    if (badgeOk) badgeOk.set(badge, ok);
    var live = ok && badgesLive();
    if (live) important(badge, { "pointer-events": "auto", cursor: "pointer" });
    if (id && id === hoverPin && live) hoverStill = true;
  }
  // A preview whose pin is gone (or no longer clickable) is withdrawn.
  if (hoverPin !== null && !hoverStill) setHoverPin(null, null);
  return found;
}
function pinOutline(state) { return state === "addressed" ? "1px dashed " + PIN_COLORS.addressed : "2px solid " + PIN_COLORS.open; }
var CHANGE_COLORS = { added: "#16a34a", changed: "#8b5cf6", moved: "#2563eb", hinted: "#0891b2" };
var CHANGE_GLYPHS = { added: "+", changed: "~", moved: "\u2195", hinted: "*" };
var CHANGE_KINDS = { added: 1, changed: 1, moved: 1, hinted: 1 };
var TAG_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** A locator from the parent, checked field by field (the parent built it
 *  from a Zod-validated message, but the frame trusts nothing): null if bad. */
function validChange(c) {
  if (!c || typeof c !== "object") return null;
  if (typeof c.kind !== "string" || !Object.prototype.hasOwnProperty.call(CHANGE_KINDS, c.kind)) return null;
  if (typeof c.tag !== "string" || !TAG_RE.test(c.tag)) return null;
  if (typeof c.text !== "string" || !c.text || c.text.length > core.LIMITS.quote) return null;
  var o = c.occurrence;
  if (typeof o !== "number" || o < 0 || o > 1000000 || Math.floor(o) !== o) return null;
  return { kind: c.kind, tag: c.tag, text: c.text, occurrence: o };
}
/** Change bars, drawn under the pins (inserted first in the layer), with DOM
 *  APIs and textContent only. Re-resolved on every draw, like the pins. */
var changeEls = null, changeIndex = {}, changeBoxes = null;
/** Drop the resolved change targets and the per-tag text index: the page's
 *  own DOM changed (never our layer), or new marks arrived. */
function invalidateChanges() { changeEls = null; changeIndex = {}; changeBoxes = null; }
function changesFound() {
  var found = [];
  for (var j = 0; j < changes.length; j++) found.push(!!(changes[j] && changeEls && changeEls[j]));
  return found;
}
/** Change bars, drawn under the pins (inserted first in the layer) with mk()
 *  (so they are ours by reference) and textContent only. A scroll or resize
 *  only re-places them; the targets are re-found only after the page's own
 *  DOM changes (invalidateChanges). */
function drawChanges() {
  var l = ensureLayer(), b;
  if (showChanges && changeEls && changeBoxes) {
    var stale = false;
    for (b = 0; b < changeBoxes.length; b++) {
      if (!changeBoxes[b].box.isConnected || !changeBoxes[b].el.isConnected) { stale = true; break; }
    }
    if (!stale) {
      for (b = 0; b < changeBoxes.length; b++) place(changeBoxes[b].box, changeBoxes[b].el.getBoundingClientRect());
      return changesFound();
    }
    invalidateChanges();
  }
  var olds = l.querySelectorAll("dp-annotator-change");
  for (var i = 0; i < olds.length; i++) olds[i].remove();
  changeBoxes = null;
  if (!showChanges || !changes.length) return [];
  if (!changeEls) {
    try { changeEls = core.findChanges(changes, changeIndex); } catch (e) { changeEls = []; }
  }
  changeBoxes = [];
  for (var j = 0; j < changes.length; j++) {
    var el = changes[j] ? changeEls[j] || null : null;
    if (!el || !el.getBoundingClientRect) continue;
    var color = CHANGE_COLORS[changes[j].kind];
    var box = mk("dp-annotator-change");
    box.setAttribute("data-dp-change", String(j));
    box.setAttribute("data-dp-change-kind", changes[j].kind);
    important(box, { position: "absolute", display: "block", "box-sizing": "border-box", "border-left": "4px solid " + color,
      outline: "1px dashed " + color, background: "transparent", "pointer-events": "none", margin: "0", padding: "0" });
    place(box, el.getBoundingClientRect());
    var tag = mk("dp-annotator-change-tag");
    tag.textContent = CHANGE_GLYPHS[changes[j].kind];
    important(tag, { position: "absolute", left: "-14px", top: "-2px", display: "block", width: "10px", height: "14px",
      color: color, font: "700 12px/14px system-ui, sans-serif", "text-align": "center" });
    box.appendChild(tag);
    l.insertBefore(box, l.firstChild);
    changeBoxes.push({ box: box, el: el });
  }
  return changesFound();
}
function focusChange(index) {
  if (!showChanges || typeof index !== "number" || index < 0 || index >= changes.length) return;
  var i = Math.floor(index);
  if (!changes[i]) return;
  reconcile(false);
  var el = changeEls ? changeEls[i] : null;
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
  var box = layer ? layer.querySelector("dp-annotator-change[data-dp-change=\"" + i + "\"]") : null;
  if (box) {
    var color = CHANGE_COLORS[changes[i].kind];
    important(box, { outline: "3px solid " + color });
    setTimeout(function () { important(box, { outline: "1px dashed " + color }); }, 1600);
  }
}
/** Redraw and tell the parent when which anchors are found has changed. */
function reconcile(force, forceChanges) {
  pending = 0;
  var cf = drawChanges();
  var found = drawPins();
  if (force || !samePins(lastFound, found)) {
    lastFound = found;
    post(withKey({ dp: "pins-status", found: found }));
  }
  if (forceChanges || !samePins(lastChangesFound, cf)) {
    lastChangesFound = cf;
    post({ dp: "changes-status", found: cf });
  }
}
function schedule() {
  if ((!current.length && !(showChanges && changes.length)) || pending) return;
  pending = setTimeout(function () { reconcile(false); }, 120);
}
/** #714 gap 8 — put an element near the BOTTOM of THIS frame's viewport
 *  (~24px above its bottom edge), next to the composer docked under the
 *  frame. window.scrollTo moves only the frame's own document, never the
 *  companion. An element taller than the viewport keeps its top in view. */
function scrollNearBottom(el) {
  if (!el || !el.getBoundingClientRect) return;
  var r = el.getBoundingClientRect();
  var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
  var sx = window.scrollX || window.pageXOffset || 0, sy = window.scrollY || window.pageYOffset || 0;
  var y = r.bottom + sy - (vh - 24);
  if (r.height > vh - 48) y = r.top + sy - 24;
  try { window.scrollTo(sx, Math.max(0, y)); } catch (e) { /* ignore */ }
}
/** {dp:"focus", index[, block]} scrolls to a pin; {dp:"focus", anchor,
 *  block} (a spot that has no pin yet: the composer just opened on it)
 *  re-finds the anchor and scrolls to it. block "end" = near the bottom edge. */
function focusPin(index, anchorArg, block) {
  var i = typeof index === "number" && index >= 0 && index < current.length ? Math.floor(index) : -1;
  var a = i >= 0 ? current[i] : anchorArg && typeof anchorArg === "object" ? anchorArg : null;
  if (!a) return;
  // Re-resolve now: the page may have changed since the pins were drawn.
  var hit = null;
  try { hit = core.findAnchor(a); } catch (e) { hit = null; }
  if (hit && hit.el) {
    if (block === "end") scrollNearBottom(hit.el);
    else if (hit.el.scrollIntoView) hit.el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  if (i < 0) { schedule(); return; }
  reconcile(false);
  var pin = layer ? layer.querySelector("dp-annotator-pin[data-dp-pin=\"" + i + "\"]") : null;
  if (pin) {
    var st = pinStates[i] === "addressed" ? "addressed" : "open";
    important(pin, { outline: "3px solid #ef4444" });
    setTimeout(function () { important(pin, { outline: pinOutline(st) }); }, 1600);
  }
}

/** #714 gaps 4+5 — the outline (h1–h3, with the section each pin and each
 *  change mark sits in) and the asks, reported to the parent when they
 *  change. Display-only hints: the parent validates every field and never
 *  creates anything from them. outlineEls / askEls line up with the last
 *  report, so a parent index points at the element it saw. The asks report
 *  also carries pinAsks: per pin, the innermost ask containing it. */
var outlineEls = [], askEls = [], lastOutlineJson = "", lastAsksJson = "", activeIdx = -2;
var outlinePending = 0, activePending = 0;
function reportOutline() {
  outlinePending = 0;
  var hs = [], j;
  try { hs = core.collectHeadings(); } catch (e) { hs = []; }
  var els = [], heads = [];
  for (j = 0; j < hs.length; j++) { els.push(hs[j].el); heads.push({ level: hs[j].level, text: hs[j].text, locator: hs[j].locator }); }
  outlineEls = els;
  var pins = [];
  for (j = 0; j < current.length; j++) pins.push(pinEls[j] && pinEls[j].isConnected ? core.sectionOf(pinEls[j], els) : -1);
  var ch = [];
  if (changes.length) {
    if (!changeEls) { try { changeEls = core.findChanges(changes, changeIndex); } catch (e2) { changeEls = []; } }
    for (j = 0; j < changes.length; j++) ch.push(changes[j] && changeEls[j] ? core.sectionOf(changeEls[j], els) : -1);
  }
  var msg = { dp: "outline", headings: heads, pins: pins, changes: ch };
  var json = JSON.stringify(msg);
  if (json !== lastOutlineJson) { lastOutlineJson = json; activeIdx = -2; post(msg); }
  var as = [];
  try { as = core.collectAsks(); } catch (e3) { as = []; }
  var aels = [], asks = [];
  for (j = 0; j < as.length; j++) {
    aels.push(as[j].el);
    var item = { kind: as[j].kind, text: as[j].text, locator: as[j].locator };
    if (as[j].id) item.id = as[j].id;
    asks.push(item);
  }
  askEls = aels;
  // Per pin: the innermost ask its element sits in (-1 = none), so a comment
  // on a child with its own id still counts as on the ask.
  var pinAsks = [];
  for (j = 0; j < current.length; j++) {
    var pe = pinEls[j], hitAsk = -1;
    if (pe && pe.isConnected) {
      for (var k = 0; k < aels.length; k++) if (aels[k] === pe || aels[k].contains(pe)) hitAsk = k;
    }
    pinAsks.push(hitAsk);
  }
  var amsg = withKey({ dp: "asks", asks: asks, pinAsks: pinAsks });
  var ajson = JSON.stringify(amsg);
  if (ajson !== lastAsksJson) { lastAsksJson = ajson; post(amsg); }
  reportActive();
}
function scheduleOutline() {
  if (outlinePending) return;
  outlinePending = setTimeout(reportOutline, 200);
}
/** Reading progress: the last heading scrolled past a line a quarter of the
 *  way down the frame (headings with no box, e.g. in a closed details, are
 *  skipped); at the very bottom, the last heading on screen. -1 = above the
 *  first heading. */
function computeActive() {
  var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
  var line = Math.max(48, vh * 0.25), idx = -1, lastOnScreen = -1;
  for (var i = 0; i < outlineEls.length; i++) {
    var el = outlineEls[i];
    if (!el.isConnected) continue;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.top <= line) idx = i;
    if (r.top < vh) lastOnScreen = i;
  }
  var de = document.documentElement, sy = window.scrollY || window.pageYOffset || 0;
  if (de && vh && sy > 0 && sy + vh >= de.scrollHeight - 2 && lastOnScreen > idx) idx = lastOnScreen;
  return idx;
}
function reportActive() {
  activePending = 0;
  var idx = -1;
  try { idx = computeActive(); } catch (e) { idx = -1; }
  if (idx !== activeIdx) { activeIdx = idx; post({ dp: "outline-active", index: idx }); }
}
function scheduleActive() {
  if (activePending) return;
  activePending = setTimeout(reportActive, 150);
}
/** The element a parent index names: the reported element when it still
 *  matches the locator the parent saw, else the locator's element if it is
 *  the right kind (the page changed since the report), else null. */
function reported(list, index, locator, sel) {
  var i = typeof index === "number" && isFinite(index) ? Math.floor(index) : -1;
  var el = i >= 0 && i < list.length ? list[i] : null;
  var loc = typeof locator === "string" && locator.length > 0 && locator.length <= core.LIMITS.locator ? locator : null;
  if (el && el.isConnected && (!loc || core.buildLocator(el) === loc)) return el;
  var q = loc ? core.safeQuery(loc) : null;
  return q && q.matches && q.matches(sel) && !own(q) ? q : null;
}
function flash(el) {
  if (!el || !el.getBoundingClientRect) return;
  var box = mk("dp-annotator-flash");
  important(box, { position: "absolute", display: "block", "box-sizing": "border-box", outline: "3px solid #6366f1",
    background: "rgba(99,102,241,0.08)", "pointer-events": "none", margin: "0", padding: "0" });
  place(box, el.getBoundingClientRect());
  ensureLayer().appendChild(box);
  setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 1600);
}
function openDetailsAround(el) {
  for (var d = el.parentElement; d; d = d.parentElement) if (d.localName === "details" && !d.open) d.open = true;
}
function focusHeading(index, locator) {
  var el = reported(outlineEls, index, locator, core.HEADING_SEL);
  if (!el) return;
  goTo(el);
  flash(el);
  scheduleActive();
}
function focusAsk(index, locator) {
  var el = reported(askEls, index, locator, core.ASK_SEL);
  if (!el) return;
  openDetailsAround(el);
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
  flash(el);
}
/** A mutation that only touches our own layer/pins/hover box is ignored, so
 *  drawing pins never re-triggers a redraw. */
function ownOnly(list) {
  for (var i = 0; i < list.length; i++) if (!own(list[i]) && list[i] !== layer) return false;
  return true;
}
function relevant(records) {
  for (var i = 0; i < records.length; i++) {
    var m = records[i], t = m.target;
    var tEl = t && t.nodeType === 1 ? t : t && t.parentElement;
    if (tEl && (own(tEl) || tEl === layer)) continue;
    if (m.type === "childList" && ownOnly(m.addedNodes) && ownOnly(m.removedNodes)) continue;
    return true;
  }
  return false;
}
var mo = null, ro = null;
function observe() {
  try {
    if (typeof window.MutationObserver === "function") {
      mo = new window.MutationObserver(function (records) { if (relevant(records)) { invalidateChanges(); schedule(); scheduleOutline(); } });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }
  } catch (e) { mo = null; }
  try {
    if (typeof window.ResizeObserver === "function") {
      ro = new window.ResizeObserver(function () { schedule(); });
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
  } catch (e2) { ro = null; }
}
function onMessage(e) {
  if (e.source !== parent) return;
  var d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.dp === "pins") {
    current = Array.isArray(d.anchors) ? d.anchors.slice(0, 500) : [];
    var sts = Array.isArray(d.states) ? d.states : [], ids = Array.isArray(d.ids) ? d.ids : [];
    pinStates = []; pinIds = [];
    for (var pi = 0; pi < current.length; pi++) {
      pinStates.push(sts[pi] === "addressed" ? "addressed" : "open");
      var pid = ids[pi];
      pinIds.push(typeof pid === "string" && pid.length > 0 && pid.length <= 128 ? pid : null);
    }
    pinsKey = typeof d.key === "string" && /^[0-9a-z:]{1,64}$/.test(d.key) ? d.key : null;
    reconcile(true);
    scheduleOutline();
  } else if (d.dp === "focus") {
    focusPin(d.index, d.anchor, d.block);
  } else if (d.dp === "changes") {
    var list = Array.isArray(d.marks) ? d.marks.slice(0, 300) : [];
    changes = [];
    for (var ci = 0; ci < list.length; ci++) changes.push(validChange(list[ci]));
    // A slot that failed validation stays null (never found), so indexes line up.
    showChanges = d.show === true;
    invalidateChanges();
    reconcile(false, true);
    scheduleOutline();
  } else if (d.dp === "focus-change") {
    focusChange(d.index);
  } else if (d.dp === "focus-heading") {
    focusHeading(d.index, d.locator);
  } else if (d.dp === "focus-ask") {
    focusAsk(d.index, d.locator);
  } else if (d.dp === "mode") {
    annotate = d.annotate !== false;
    scripts = d.scripts === true;
    if (!annotate) hideHover();
    syncBadges();
  }
}
function onMouseDown() { suppressClick = false; }
function onMouseUp(e) {
  if (!annotate || e.ctrlKey || e.metaKey) return;
  var t = targetEl(e);
  if (t && own(t)) return;
  var sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  var a = null;
  try { a = core.textAnchor(sel.getRangeAt(0)); } catch (err) { a = null; }
  if (a) { suppressClick = true; post({ dp: "anchor", anchor: a }); }
}
/** #714 — pointing never breaks the page's own navigation:
 *  - a link NEVER navigates the frame (it is something to point at, not a way
 *    out of the no-network document); a same-document "#hash" link scrolls to
 *    its target instead, and any other link becomes a link anchor;
 *  - summary, label and form controls keep their default action;
 *  - Alt/Option-click points at any of those instead;
 *  - holding Cmd/Ctrl lets one click through to the page (no anchor).
 *  With pointing off, every click belongs to the page (links still never
 *  navigate; hash links still scroll). */
function onClick(e) {
  var t = targetEl(e);
  if (!t) return;
  // #714 gap 7 — a click on a pin's badge (one of OUR nodes, matched by
  // reference) tells the parent which comment it is. Display-only: the parent
  // scrolls to and highlights that comment; nothing is posted or changed.
  var pinId = pinIdOf(t);
  // Cmd/Ctrl held means "let this click through": a badge never turns it
  // into a pin click (badges also go inert while the key is down).
  if (pinId !== null && (e.ctrlKey || e.metaKey)) return;
  if (pinId !== null) {
    e.preventDefault();
    e.stopPropagation();
    if (suppressClick) { suppressClick = false; return; }
    if (badgesLive() && badgeOk && badgeOk.get(t) === true) post({ dp: "pin-click", id: pinId });
    return;
  }
  var link = closestLink(t);
  // The navigation guard runs before anything else, our own nodes included:
  // no link is ever allowed to navigate the frame.
  if (link) e.preventDefault();
  if (own(t)) return;
  var pointing = annotate && !e.ctrlKey && !e.metaKey;
  var forceAnchor = pointing && !!e.altKey;
  if (link) {
    // Interact mode still lets the page's own click handlers see the event;
    // only the navigation is cancelled (above).
    var hash = sameDocHash(link);
    var target = hash !== null && !forceAnchor ? hashTarget(hash) : null;
    if (target) {
      if (pointing && suppressClick) { suppressClick = false; return; }
      goTo(target);
      return;
    }
    if (!pointing) return;
    e.stopPropagation();
    if (suppressClick) { suppressClick = false; return; }
    // An SVG xlink link isn't one core can re-find as a link; point at it as
    // an element instead.
    var la = null;
    try { la = link.matches && link.matches(core.LINK_SEL) ? core.linkAnchor(link) : core.elementAnchor(link); } catch (err0) { la = null; }
    if (la) post({ dp: "anchor", anchor: la });
    return;
  }
  if (!pointing) return;
  var pass = forceAnchor ? null : passTarget(t);
  if (pass && !scripts && pass.localName === "summary" && t.closest(BUTTON_SEL)) {
    // A button inside a summary, before Run: the button has no action, so the
    // click toggles the details itself (deterministic across engines).
    e.preventDefault();
    if (suppressClick) { suppressClick = false; return; }
    pass.parentElement.open = !pass.parentElement.open;
    return;
  }
  if (pass) {
    // A click that ended a text selection (already posted as a text anchor)
    // stays swallowed, so selecting a label's words doesn't also flip it.
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (suppressClick) { suppressClick = false; return; }
  var a = null;
  try { a = core.anchorForTarget(t); } catch (err) { a = null; }
  if (a) post({ dp: "anchor", anchor: a });
}
function onAuxClick(e) {
  if (closestLink(targetEl(e))) e.preventDefault();
}
function onResize() { schedule(); scheduleActive(); }
/** Capture phase so an inner scroll container (a wide table, a diagram) is
 *  seen too; schedule() coalesces bursts into one bounded redraw. */
function onScroll(e) {
  var t = e && e.target;
  if (t && t.nodeType === 1 && own(t)) return;
  schedule();
  scheduleActive();
}
function onReady() {
  if (document.body && ro) { try { ro.observe(document.body); } catch (e) { /* ignore */ } }
  post({ dp: "ready" });
  reportOutline();
}
window.addEventListener("click", onClick, true);
window.addEventListener("auxclick", onAuxClick, true);
window.addEventListener("mousedown", onMouseDown, true);
window.addEventListener("mouseup", onMouseUp, true);
window.addEventListener("mousemove", onMove, true);
window.addEventListener("mouseout", onOut, true);
window.addEventListener("keydown", onKey, true);
window.addEventListener("keyup", onKey, true);
window.addEventListener("message", onMessage);
window.addEventListener("resize", onResize);
window.addEventListener("scroll", onScroll, true);
observe();
if (document.readyState === "complete") onReady(); else window.addEventListener("load", onReady);
return function uninstall() {
  window.removeEventListener("click", onClick, true);
  window.removeEventListener("auxclick", onAuxClick, true);
  window.removeEventListener("mousedown", onMouseDown, true);
  window.removeEventListener("mouseup", onMouseUp, true);
  window.removeEventListener("mousemove", onMove, true);
  window.removeEventListener("mouseout", onOut, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKey, true);
  window.removeEventListener("message", onMessage);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("load", onReady);
  if (mo) mo.disconnect();
  if (ro) ro.disconnect();
  if (pending) clearTimeout(pending);
  if (outlinePending) clearTimeout(outlinePending);
  if (activePending) clearTimeout(activePending);
  if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
};
`;

/** The script inlined first into the frame document. */
export const ANNOTATOR_SCRIPT =
  "(function(){try{var core=(function(document,window){" +
  ANNOTATOR_CORE_SOURCE +
  "\n})(document,window);(function(document,window,parent,core){" +
  ANNOTATOR_MAIN_SOURCE +
  "\n})(document,window,window.parent,core);}catch(e){}})();";
