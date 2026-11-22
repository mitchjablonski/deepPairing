import{a as e}from"./chunk-BEqpzyXh.js";import{t}from"./react-BD_ANHAE.js";import{t as n}from"./jsx-runtime-DOlcsXOY.js";import{n as r,o as i,s as a}from"./api-HWtMma59.js";import{S as o,h as s}from"./artifact-CWMmPSm_.js";import{D as c,N as l,R as u,W as d,b as f,v as p,y as m}from"./dist-D2hlTl70.js";import{f as h,t as g}from"./useOfflineReason-D0fie1-s.js";import{C as _,T as v,_ as y,g as b,j as x,m as S,v as C}from"./index-DTFIyIH7.js";import{t as w}from"./PrototypeFrame-B4Qg5VKA.js";import{t as T}from"./ConceptBadge-CxFwKflJ.js";import{r as E}from"./NeverSuggestControl-Bzo1I3de.js";import{t as D}from"./ArtifactStatusActions-1dXSrAlY.js";var O=e(t(),1),k=String.raw`
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

return {
  LIMITS: LIMITS,
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
  mermaidNodeId: mermaidNodeId
};
`,A=String.raw`
"use strict";
var annotate = true, suppressClick = false, hoverBox = null, layer = null;
var current = [], lastFound = null, pending = 0;
function own(el) { return !!(el && el.closest && el.closest("[data-dp-annotator]")); }
function post(msg) { try { parent.postMessage(msg, "*"); } catch (e) { /* parent gone */ } }
function important(el, styles) {
  for (var k in styles) if (Object.prototype.hasOwnProperty.call(styles, k)) el.style.setProperty(k, styles[k], "important");
}
function mk(tag) { var el = document.createElement(tag); el.setAttribute("data-dp-annotator", ""); return el; }
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
function onMove(e) {
  var t = targetEl(e);
  if (!annotate || !t || own(t) || t === document.documentElement || t === document.body) { hideHover(); return; }
  if (!hoverBox || !hoverBox.isConnected) {
    hoverBox = mk("dp-annotator-hover");
    important(hoverBox, { position: "absolute", "box-sizing": "border-box", outline: "2px dashed #3b82f6",
      background: "rgba(59,130,246,0.06)", "pointer-events": "none", margin: "0", padding: "0" });
    ensureLayer().appendChild(hoverBox);
  }
  important(hoverBox, { display: "block" });
  place(hoverBox, t.getBoundingClientRect());
}
function samePins(a, b) {
  if (!a || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** Re-resolve every anchor against the CURRENT document and redraw. Nothing
 *  about a target (element or rectangle) is cached between draws, so a pin
 *  follows its content after the page changes. */
function drawPins() {
  var l = ensureLayer();
  var olds = l.querySelectorAll("dp-annotator-pin");
  for (var i = 0; i < olds.length; i++) olds[i].remove();
  var found = [];
  for (var j = 0; j < current.length; j++) {
    var hit = null;
    try { hit = core.findAnchor(current[j]); } catch (e) { hit = null; }
    found.push(!!hit);
    if (!hit) continue;
    var r = rectOf(hit);
    if (!r) continue;
    var pin = mk("dp-annotator-pin");
    pin.setAttribute("data-dp-pin", String(j));
    important(pin, { position: "absolute", display: "block", "box-sizing": "border-box", outline: "2px solid #f59e0b",
      background: "transparent", "pointer-events": "none", margin: "0", padding: "0" });
    place(pin, r);
    var badge = mk("dp-annotator-badge");
    badge.textContent = String(j + 1);
    important(badge, { position: "absolute", left: "-10px", top: "-10px", display: "block", "box-sizing": "border-box",
      "min-width": "18px", height: "18px", padding: "0 4px", "border-radius": "9px", background: "#f59e0b",
      color: "#111", font: "600 11px/18px system-ui, sans-serif", "text-align": "center" });
    pin.appendChild(badge);
    l.appendChild(pin);
  }
  return found;
}
/** Redraw and tell the parent when which anchors are found has changed. */
function reconcile(force) {
  pending = 0;
  var found = drawPins();
  if (force || !samePins(lastFound, found)) {
    lastFound = found;
    post({ dp: "pins-status", found: found });
  }
}
function schedule() {
  if (!current.length || pending) return;
  pending = setTimeout(function () { reconcile(false); }, 120);
}
function focusPin(index) {
  if (typeof index !== "number" || index < 0 || index >= current.length) return;
  var i = Math.floor(index);
  // Re-resolve now: the page may have changed since the pins were drawn.
  var hit = null;
  try { hit = core.findAnchor(current[i]); } catch (e) { hit = null; }
  if (hit && hit.el && hit.el.scrollIntoView) hit.el.scrollIntoView({ block: "center", behavior: "smooth" });
  reconcile(false);
  var pin = layer ? layer.querySelector("dp-annotator-pin[data-dp-pin=\"" + i + "\"]") : null;
  if (pin) {
    important(pin, { outline: "3px solid #ef4444" });
    setTimeout(function () { important(pin, { outline: "2px solid #f59e0b" }); }, 1600);
  }
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
      mo = new window.MutationObserver(function (records) { if (relevant(records)) schedule(); });
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
    reconcile(true);
  } else if (d.dp === "focus") {
    focusPin(d.index);
  } else if (d.dp === "mode") {
    annotate = d.annotate !== false;
    if (!annotate) hideHover();
  }
}
function onMouseDown() { suppressClick = false; }
function onMouseUp(e) {
  if (!annotate) return;
  var t = targetEl(e);
  if (t && own(t)) return;
  var sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  var a = null;
  try { a = core.textAnchor(sel.getRangeAt(0)); } catch (err) { a = null; }
  if (a) { suppressClick = true; post({ dp: "anchor", anchor: a }); }
}
function onClick(e) {
  var t = targetEl(e);
  if (!t || own(t)) return;
  var link = t.closest ? t.closest("a[href], area[href]") : null;
  if (link) {
    // Never navigate: a link on the page is something to point at, not a way
    // out of the no-network document. Interact mode still lets the page's own
    // click handlers see the event; only the navigation is cancelled.
    e.preventDefault();
    if (!annotate) return;
    e.stopPropagation();
    if (suppressClick) { suppressClick = false; return; }
    post({ dp: "anchor", anchor: core.linkAnchor(link) });
    return;
  }
  if (!annotate) return;
  e.preventDefault();
  e.stopPropagation();
  if (suppressClick) { suppressClick = false; return; }
  var a = null;
  try { a = core.anchorForTarget(t); } catch (err) { a = null; }
  if (a) post({ dp: "anchor", anchor: a });
}
function onAuxClick(e) {
  var t = targetEl(e);
  if (t && t.closest && t.closest("a[href], area[href]")) e.preventDefault();
}
function onResize() { schedule(); }
/** Capture phase so an inner scroll container (a wide table, a diagram) is
 *  seen too; schedule() coalesces bursts into one bounded redraw. */
function onScroll(e) {
  var t = e && e.target;
  if (t && t.nodeType === 1 && own(t)) return;
  schedule();
}
function onReady() {
  if (document.body && ro) { try { ro.observe(document.body); } catch (e) { /* ignore */ } }
  post({ dp: "ready" });
}
window.addEventListener("click", onClick, true);
window.addEventListener("auxclick", onAuxClick, true);
window.addEventListener("mousedown", onMouseDown, true);
window.addEventListener("mouseup", onMouseUp, true);
window.addEventListener("mousemove", onMove, true);
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
  window.removeEventListener("message", onMessage);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("load", onReady);
  if (mo) mo.disconnect();
  if (ro) ro.disconnect();
  if (pending) clearTimeout(pending);
  if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
};
`,j=`(function(){try{var core=(function(document,window){`+k+`
})(document,window);(function(document,window,parent,core){`+A+`
})(document,window,window.parent,core);}catch(e){}})();`,M=new Set([`script`,`noscript`,`template`,`iframe`,`frame`,`frameset`,`object`,`embed`,`applet`,`portal`,`base`]);function N(e){let t=e.replace(/[\x00-\x20\x7f-\x9f]/g,``).toLowerCase();return t.startsWith(`javascript:`)||t.startsWith(`vbscript:`)||t.startsWith(`data:text/html`)||t.startsWith(`data:application/xhtml`)}function P(e){for(let t of Array.from(e.attributes)){let n=t.name.toLowerCase();if(n.startsWith(`on`)){e.removeAttribute(t.name);continue}(n===`srcdoc`||N(t.value))&&e.removeAttribute(t.name)}}var F=[`class`,`dir`,`lang`,`style`];function I(e){return!/url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding|\\/i.test(e)}function L(e){let t={};if(!e)return t;for(let n of F){let r=e.getAttribute(n);r==null||r===``||n===`dir`&&!/^(ltr|rtl|auto)$/i.test(r.trim())||n===`style`&&!I(r)||(t[n]=r)}return t}function R(e){let t=[],n=e.documentElement?[e.documentElement]:[];for(;n.length;){let e=n.pop();t.push(e);let r=e.childNodes;for(let e=r.length-1;e>=0;e--){let t=r[e];t.nodeType===1&&n.push(t)}}return t}function z(e){if(typeof DOMParser>`u`)return{html:``,htmlAttrs:{},bodyAttrs:{}};let t=new DOMParser().parseFromString(e,`text/html`);for(let e of R(t))M.has(e.localName.toLowerCase())&&e.remove();for(let e of Array.from(t.querySelectorAll(`script`)))e.remove();for(let e of Array.from(t.getElementsByTagNameNS(`*`,`script`)))e.remove();for(let e of Array.from(t.querySelectorAll(`meta`)))(e.getAttribute(`http-equiv`)??``).trim().toLowerCase()===`refresh`&&e.remove();for(let e of R(t)){let t=e.localName.toLowerCase();t!==`set`&&!t.startsWith(`animate`)||(Array.from(e.attributes).find(e=>e.name.toLowerCase()===`attributename`)?.value??``).toLowerCase().includes(`href`)&&e.remove()}for(let e of R(t))P(e);return{html:t.head.innerHTML+t.body.innerHTML,htmlAttrs:L(t.documentElement),bodyAttrs:L(t.body)}}function B(e,t){if(!t||e.source!==t)return null;let n=e.data;return!n||typeof n!=`object`||Array.isArray(n)?null:n}function ee(e,t){let n=B(e,t);if(!n||n.dp!==`anchor`)return null;let r=u.safeParse(n.anchor);return r.success?r.data:null}var V=500;function te(e,t){let n=B(e,t);if(!n||n.dp!==`pins-status`)return null;let r=n.found;return!Array.isArray(r)||r.length>V||!r.every(e=>typeof e==`boolean`)?null:r}function ne(e,t){let n=B(e,t);return!!n&&n.dp===`ready`}var H=n();function re({artifactId:e,anchor:t,ruledOut:n,onRecorded:o}){let c=g(),l=m(t.quote),u=l.ok?l.key:null,d=l.ok?null:p[l.reason],[f,_]=(0,O.useState)(!1),[v,y]=(0,O.useState)(``);h(`page-rule-out:${e}:${t.locator}`,v);let[b,x]=(0,O.useState)(!1),[S,C]=(0,O.useState)(null),[w,T]=(0,O.useState)(null),E=o?n??null:w??n??null,D=(0,O.useRef)(null),k=(0,O.useRef)(!1);(0,O.useEffect)(()=>{!f&&k.current&&(k.current=!1,D.current?.focus())},[f]);let A=()=>{k.current=!0,_(!1),y(``),C(null)},j=v.trim(),M=async()=>{if(!(c||b||!j||!u)){x(!0),C(null);try{let n=s.getState().owningSession(e),c=await i(`${r()}/api/artifacts/${encodeURIComponent(e)}/rule-out`,{method:`POST`,headers:a(n),body:JSON.stringify({htmlAnchor:t,reason:j})}),l=null;try{l=await c.json()}catch{}l?.comment?.id&&s.getState().addComment(l.comment),T(l?.description??u),o?.(l?.description??u),_(!1),y(``)}catch(e){C(e instanceof Error?e.message:`Couldn't save that. Try again.`)}finally{x(!1)}}};if(E)return(0,H.jsxs)(`p`,{className:`text-2xs text-accent-red`,role:`status`,"data-testid":`page-rule-out-recorded`,children:[`✓ Ruled out “`,E,`”. Claude won't present a page that still contains this text in this project. You can retire it in the Ledger.`]});if(!f)return(0,H.jsxs)(`span`,{className:`inline-flex flex-wrap items-center justify-end gap-1.5`,children:[d&&(0,H.jsx)(`span`,{className:`text-2xs text-text-muted`,"data-testid":`page-rule-out-unavailable`,children:d}),(0,H.jsx)(`button`,{ref:D,type:`button`,onClick:()=>_(!0),disabled:!u,title:d??`Remember this text as rejected, so Claude won't present a page that still contains it in this project`,className:`px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-accent-red hover:bg-accent-red-dim/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`,children:`Rule this out`})]});let N=`page-rule-out-reason-${e}`;return(0,H.jsxs)(`div`,{role:`group`,"aria-label":`Rule this out`,className:`w-full p-2 bg-surface-secondary border border-accent-red/30 rounded-lg`,"data-testid":`page-rule-out-panel`,children:[(0,H.jsxs)(`label`,{htmlFor:N,className:`block text-2xs text-text-muted mb-1.5`,children:[`Rule out “`,(0,H.jsx)(`span`,{className:`text-text-primary`,children:u}),`”? Claude won't present a page that still contains this text in this project. It only applies to pages, and this page's status doesn't change (you can retire the stance later in the Ledger). Why are you ruling it out? (required)`]}),(0,H.jsx)(`textarea`,{id:N,rows:2,autoFocus:!0,value:v,onChange:e=>y(e.target.value),onKeyDown:e=>{e.key===`Enter`&&(e.metaKey||e.ctrlKey)&&(e.preventDefault(),M()),e.key===`Escape`&&(e.preventDefault(),A())},placeholder:`Your reason (Claude sees it when the gate refuses this text)…`,className:`w-full px-2 py-1.5 bg-surface-primary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none`}),S&&(0,H.jsx)(`p`,{className:`mt-1 text-2xs text-accent-red`,role:`alert`,children:S}),(0,H.jsxs)(`div`,{className:`flex gap-1.5 mt-1.5 justify-end`,children:[(0,H.jsx)(`button`,{type:`button`,onClick:A,className:`px-2 py-1 text-2xs text-text-muted hover:text-text-secondary cursor-pointer`,children:`Cancel`}),(0,H.jsx)(`button`,{type:`button`,title:c??(j?void 0:`Say why first`),onClick:()=>void M(),disabled:b||!!c||!j,className:`px-2 py-1 text-2xs text-text-inverse bg-accent-red hover:bg-accent-red/80 rounded press-scale cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`,children:`Rule it out`})]})]})}var ie={script:j,sanitize:z};function ae(e){return e.filter(e=>y(`page`,e)).slice().sort((e,t)=>e.createdAt.localeCompare(t.createdAt))}function U({anchor:e}){let t=e.quote.trim();return(0,H.jsxs)(`div`,{className:`space-y-0.5 text-2xs text-text-muted`,"data-testid":`page-anchor-context`,children:[(0,H.jsxs)(`div`,{className:`flex flex-wrap items-center gap-1.5`,children:[(0,H.jsx)(`span`,{className:`px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary`,children:b(e.kind)}),t?(0,H.jsxs)(`span`,{className:`text-text-primary italic break-words`,children:[`“`,t,`”`]}):(0,H.jsx)(`code`,{className:`font-mono break-all`,children:e.locator})]}),e.table&&(e.table.row||e.table.col)&&(0,H.jsxs)(`div`,{children:[e.table.row&&(0,H.jsxs)(H.Fragment,{children:[`Row `,(0,H.jsx)(`span`,{className:`text-text-secondary`,children:e.table.row})]}),e.table.row&&e.table.col&&` · `,e.table.col&&(0,H.jsxs)(H.Fragment,{children:[`Column `,(0,H.jsx)(`span`,{className:`text-text-secondary`,children:e.table.col})]})]}),e.nodeId&&(0,H.jsxs)(`div`,{children:[`Node `,(0,H.jsx)(`code`,{className:`font-mono`,children:e.nodeId})]}),e.href&&(0,H.jsxs)(`div`,{className:`break-all`,children:[`Link to `,(0,H.jsx)(`code`,{className:`font-mono`,children:e.href})]}),t&&(0,H.jsxs)(`div`,{className:`break-all`,children:[`at `,(0,H.jsx)(`code`,{className:`font-mono`,children:e.locator})]})]})}function W({artifact:e}){let t=c(e.content),n=(0,O.useRef)(null),r=o(e=>e.active),i=x(e.status,r),a=i===`closed`||i===`frozen`,u=l(e.fileWatch),p=(0,O.useMemo)(()=>new Set((l(e.fileWatch).recorded?.orphaned??[]).map(e=>e.commentId)),[e.fileWatch]),m=v(e.id),{rows:h,remember:g}=E(s(t=>t.owningSession(e.id))),y=(0,O.useMemo)(()=>new Set(h.map(e=>e.description)),[h]),b=(0,O.useMemo)(()=>ae(m),[m]),k=(0,O.useMemo)(()=>b.map(e=>e.target.htmlAnchor),[b]),[A,j]=(0,O.useState)(null),[M,N]=(0,O.useState)(0),[P,F]=(0,O.useState)(!1),I=(0,O.useRef)(null),[L,R]=(0,O.useState)(0),z=(0,O.useRef)(null),B=(0,O.useRef)(e.id);B.current=e.id;let V=(0,O.useCallback)(e=>!e||e!==n.current||!e.isConnected||document.activeElement!==e||e.closest(`[inert]`)?!1:s.getState().selectedArtifactId===B.current,[]),W=(0,O.useRef)(V);W.current=V;let[G,K]=(0,O.useState)(null),[q,oe]=(0,O.useState)(!1),[J,se]=(0,O.useState)(!0),Y=(0,O.useCallback)(e=>{n.current?.contentWindow?.postMessage(e,`*`)},[]),X=(0,O.useCallback)(()=>Y({dp:`pins`,anchors:k}),[Y,k]),Z=(0,O.useCallback)(()=>Y({dp:`mode`,annotate:!q||J}),[Y,q,J]),Q=(0,O.useRef)({sendPins:X,sendMode:Z});Q.current={sendPins:X,sendMode:Z};let $=(0,O.useRef)(!0);$.current=!q||J,(0,O.useEffect)(()=>{function t(t){let r=n.current,i=r?.contentWindow,o=ee(t,i);if(o){if(a||!$.current||!W.current(r))return;I.current=r,j({...o,version:e.version}),F(!1),N(e=>e+1),R(e=>e+1);return}if(ne(t,i)){Q.current.sendMode(),Q.current.sendPins();return}let s=te(t,i);s&&K(s)}return window.addEventListener(`message`,t),()=>window.removeEventListener(`message`,t)},[e.version,a]),(0,O.useEffect)(()=>{X()},[X]),(0,O.useEffect)(()=>{Z()},[Z]),(0,O.useEffect)(()=>{K(null)},[q]),(0,O.useEffect)(()=>{!L||!V(I.current)||z.current?.querySelector(`textarea`)?.focus?.()},[L,V]);let ce=(0,O.useCallback)(e=>oe(e),[]),le=t=>{let n=k[t];n&&(Y({dp:`focus`,index:t}),a||(I.current=null,j({...n,version:e.version}),F(!0),N(e=>e+1)))},ue=A?m.filter(e=>{if(C(e.target.htmlAnchor,A))return!0;let t=b.find(t=>t.id===e.parentCommentId);return!!t&&C(t.target.htmlAnchor,A)}):[];return(0,H.jsxs)(`div`,{className:`space-y-3`,"data-testid":`page-artifact`,children:[t.summary&&(0,H.jsx)(`div`,{className:`px-4 py-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg`,children:(0,H.jsx)(_,{text:t.summary,className:`prose-field text-sm text-text-primary space-y-2`})}),(t.sourcePath||t.concept)&&(0,H.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,children:[t.concept&&(0,H.jsx)(T,{name:t.concept.name,explanation:t.concept.oneLineExplanation}),t.sourcePath&&(0,H.jsxs)(`span`,{children:[`From `,(0,H.jsx)(`code`,{className:`font-mono text-text-secondary`,children:t.sourcePath})]})]}),u.recorded&&(0,H.jsxs)(`div`,{className:`text-2xs text-text-muted`,"data-testid":`page-file-recorded`,children:[`Recorded automatically from `,(0,H.jsx)(`code`,{className:`font-mono text-text-secondary`,children:u.recorded.sourcePath}),` after a save, replacing v`,u.recorded.fromVersion,`.`,u.recorded.orphaned.length+(u.recorded.orphanedOverflow??0)>0&&(0,H.jsxs)(H.Fragment,{children:[` `,u.recorded.orphaned.length+(u.recorded.orphanedOverflow??0),` earlier comment(s) point at text that is no longer on the page.`]})]}),u.refused&&!a&&(0,H.jsxs)(`div`,{className:`px-3 py-2 rounded-lg border border-accent-amber/40 bg-accent-amber/10 text-xs text-text-primary`,role:`status`,"data-testid":`page-file-refused`,children:[`A later save to`,` `,(0,H.jsx)(`code`,{className:`font-mono`,children:u.refused.sourcePath}),u.refused.cause===`gate`?(0,H.jsxs)(H.Fragment,{children:[` was not recorded: `,u.refused.message,`. You are still looking at v`,e.version,`.`]}):(0,H.jsxs)(H.Fragment,{children:[` could not be recorded: `,u.refused.message,`. You are still looking at v`,e.version,`.`]})]}),!a&&(0,H.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,children:[(0,H.jsx)(`span`,{children:`Click anything on the page, or select text, to comment on that spot.`}),q&&(0,H.jsx)(`button`,{type:`button`,onClick:()=>se(e=>!e),"aria-pressed":J,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,title:J?`Clicks point at the page. Switch to let clicks reach the page's own controls.`:`Clicks reach the page's own controls. Switch back to point at things.`,children:J?`Pointing: on`:`Pointing: off`})]}),(0,H.jsx)(w,{html:t.html,maxBytes:d,staticFirst:!0,noun:`page`,frameClassName:`w-full h-[70vh] min-h-[420px] rounded border border-border-default bg-white`,annotation:ie,iframeRef:n,onRunningChange:ce}),A&&!a&&(0,H.jsxs)(`div`,{className:`p-3 rounded-lg border border-accent-blue/30 bg-surface-elevated space-y-2`,ref:z,"data-testid":`page-anchor-composer`,children:[(0,H.jsxs)(`div`,{className:`flex items-start gap-2`,children:[(0,H.jsx)(`div`,{className:`flex-1 min-w-0`,children:(0,H.jsx)(U,{anchor:A})}),(0,H.jsx)(`button`,{type:`button`,onClick:()=>j(null),className:`text-2xs text-text-muted hover:text-text-secondary`,children:`Close`})]}),(0,H.jsx)(S,{artifactId:e.id,comments:ue,target:{htmlAnchor:A},roomy:!0,focusOnOpen:P,placeholder:`Comment on this spot… (⌘⏎ to send)`,textareaLabel:`Comment on the selected spot`,secondarySubmitLabel:`Ask`,secondarySubmitTitle:`Post as a question about this spot — the agent owes you an answer`},M),(0,H.jsx)(`div`,{className:`flex justify-end`,"data-testid":`page-rule-out`,children:(0,H.jsx)(re,{artifactId:e.id,anchor:A,ruledOut:(()=>{let e=f(A.quote);return e&&y.has(e)?e:void 0})(),onRecorded:t=>g({description:t,sourceArtifactId:e.id})},M)})]}),b.length>0&&(0,H.jsxs)(`div`,{className:`space-y-1.5`,"data-testid":`page-annotations`,children:[(0,H.jsx)(`h3`,{className:`text-2xs font-semibold text-text-muted uppercase tracking-wide`,children:`On the page`}),(0,H.jsx)(`ol`,{className:`space-y-1.5`,children:b.map((e,t)=>{let n=e.target.htmlAnchor,r=G?G[t]===!1:p.has(e.id);return(0,H.jsx)(`li`,{children:(0,H.jsxs)(`button`,{type:`button`,onClick:()=>le(t),className:`w-full text-left flex gap-2 p-2 rounded border border-border-default hover:bg-surface-elevated`,"data-testid":`page-annotation`,children:[(0,H.jsx)(`span`,{className:`shrink-0 w-5 h-5 rounded-full bg-accent-amber text-[11px] font-semibold text-black flex items-center justify-center`,children:t+1}),(0,H.jsxs)(`span`,{className:`flex-1 min-w-0 space-y-1`,children:[(0,H.jsx)(U,{anchor:n}),e.ruleOut&&y.has(e.ruleOut.description)&&(0,H.jsxs)(`span`,{className:`block text-2xs text-accent-red`,"data-testid":`page-annotation-ruled-out`,children:[`Ruled out: Claude won't present a page that still contains “`,e.ruleOut.description,`”`]}),e.ruleOut&&!y.has(e.ruleOut.description)&&(0,H.jsx)(`span`,{className:`block text-2xs text-text-muted`,"data-testid":`page-annotation-ruled-out-retired`,children:`Was ruled out; that stance has since been retired`}),r&&(0,H.jsx)(`span`,{className:`block text-2xs text-accent-amber`,"data-testid":`page-anchor-missing`,children:`Not found in this version`}),(0,H.jsx)(`span`,{className:`block text-xs text-text-primary line-clamp-3`,children:e.content})]})]})},e.id)})})]}),(0,H.jsx)(D,{artifact:e})]})}export{W as PageArtifact};