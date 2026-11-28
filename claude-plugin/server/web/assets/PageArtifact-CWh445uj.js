import{a as e}from"./chunk-Dy9vhvp_.js";import{t}from"./react-MiZfE901.js";import{t as n}from"./jsx-runtime-DRdVPR4T.js";import{n as r,o as i,s as a}from"./api-BRSI0TD2.js";import{S as o,h as s,s as c}from"./artifact-C8HXcGbg.js";import{a as l,d as u,n as d,o as f,r as p,s as m,t as h,u as g}from"./schemas-DIAwpD5w.js";import{A as _,C as v,D as y,E as b,F as x,I as S,L as C,M as ee,N as te,O as ne,P as w,S as T,T as re,W as ie,X as ae,b as oe,ct as se,j as ce,k as le,nt as ue,tt as de,v as fe,w as pe,x as me,y as E}from"./dist-Cv8Ie_oF.js";import{f as he,t as ge}from"./useOfflineReason-v_VMDVVP.js";import{i as _e,r as ve}from"./preferences-CF5l9JQc.js";import{E as ye,M as be,_ as xe,a as Se,h as Ce,v as D,w as we,y as Te}from"./index-B2sDfuLt.js";import{r as Ee,t as De}from"./mermaidRendererProtocol-Tplhn0By.js";import{t as Oe}from"./PrototypeFrame-DHjiJQrj.js";import{t as ke}from"./ConceptBadge-HAmLisn0.js";import{r as Ae}from"./NeverSuggestControl-DMmsh5QD.js";import{t as je}from"./ArtifactStatusActions-r8-7q2Kr.js";var O=e(t(),1),Me=String.raw`
"use strict";
var LIMITS = { locator: 512, quote: 280, affix: 32, header: 200, nodeId: 200, href: 512, sectionHeading: 120, sectionId: 200 };
var SECTION_HEADS = "h1, h2, h3, h4, h5, h6";
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

/** #714 gap 10 — the headings a section can be named by (h1–h6, document
 *  order), unrendered subtrees skipped, capped so a hostile page stays cheap. */
function sectionHeads() {
  var els = document.querySelectorAll(SECTION_HEADS), out = [];
  for (var i = 0; i < els.length && out.length < 2000; i++) {
    if (inChangeSkip(els[i]) || els[i].closest(SKIP)) continue;
    out.push(els[i]);
  }
  return out;
}
/** #714 gap 10 — which part of the page an element is in: heading = the
 *  nearest preceding h1–h6 (or the first heading inside a clicked container),
 *  id = the nearest ancestor-or-self id, except that a heading with its own id
 *  INSIDE that ancestor is the more specific name (a page-wide wrapper id says
 *  nothing). Falls back to the heading's id. An id over the cap is skipped,
 *  never clipped (a clipped id names nothing). null when neither is known. */
function sectionFor(el, heads) {
  if (!isEl(el)) return null;
  var hs = heads || sectionHeads();
  var hi = sectionOf(el, hs), h = hi >= 0 ? hs[hi] : null, out = {};
  if (h) { var ht = textPrefix(h, LIMITS.sectionHeading); if (ht) out.heading = ht; }
  var hid = h && typeof h.id === "string" && h.id && h.id.length <= LIMITS.sectionId ? h.id : "";
  var id = "";
  for (var n = el; isEl(n) && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (typeof n.id === "string" && n.id && n.id.length <= LIMITS.sectionId) {
      id = hid && n !== h && n.contains(h) ? hid : n.id;
      break;
    }
  }
  if (!id) id = hid;
  if (id) out.id = id;
  return out.heading || out.id ? out : null;
}
/** #714 gap 10 — an element-grain anchor's context: the page text just
 *  outside the element (up to LIMITS.affix each side, read exactly as
 *  support() re-checks it) and its section. Best effort: a failure leaves the
 *  anchor as it was. */
function withContext(a, el) {
  try {
    var body = document.body || document.documentElement;
    var ctx = contextOf(el, textIndex(body));
    var p = norm(norm(ctx.before).slice(-LIMITS.affix));
    var sx = norm(norm(ctx.after).slice(0, LIMITS.affix));
    if (p) a.prefix = clip(p, LIMITS.affix);
    if (sx) a.suffix = clip(sx, LIMITS.affix);
    var sec = sectionFor(el);
    if (sec) a.section = sec;
  } catch (e) { /* context is optional */ }
  return a;
}
function elementAnchor(el) {
  return withContext({ kind: "element", locator: buildLocator(el), quote: clip(elementText(el), LIMITS.quote) }, el);
}
function linkAnchor(link) {
  var a = { kind: "link", locator: buildLocator(link), quote: clip(elementText(link), LIMITS.quote) };
  var href = link.getAttribute("href");
  if (href) a.href = clip(href, LIMITS.href);
  return withContext(a, link);
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
  return withContext(a, g);
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
/** A cell's row/column header text ({row?, col?}), as a cell anchor's table. */
function cellTable(cell) {
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
  return t;
}
function cellAnchor(cell) {
  var a = { kind: "cell", locator: buildLocator(cell), quote: clip(elementText(cell), LIMITS.quote) };
  var t = cellTable(cell);
  if (t.row || t.col) a.table = t;
  return withContext(a, cell);
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
  try {
    var sec = sectionFor(elementOf(range.startContainer) || common);
    if (sec) a.section = sec;
  } catch (e2) { /* section is optional */ }
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
function support(a, el, bodyIndex, fromLocator, heads) {
  var kind = String(a.kind || "");
  if (!isEl(el)) return -1;
  if (kind === "cell" && !isCell(el)) return -1;
  if (kind === "link" && !(el.matches && el.matches(LINK_SEL))) return -1;
  if (kind === "diagram-node" && !(el.matches && el.matches(NODE_SEL))) return -1;
  var idMatch = kind === "diagram-node" && typeof a.nodeId === "string" && a.nodeId && mermaidNodeId(el) === a.nodeId;
  // A saved Mermaid node id is identity enough: a revision may relabel the node.
  if (!idMatch && !textMatches(el, a.quote)) return -1;
  if (kind === "cell" && a.table && typeof a.table === "object") {
    var t = cellTable(el);
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
  return score + sectionBonus(a, el, heads);
}
/** #714 gap 10 — +1 when the anchor saved a section id and the candidate is
 *  in a section with that id (a tie-break between equal text in different
 *  sections). Anchors saved without one score exactly as before. */
function sectionBonus(a, el, heads) {
  var want = a && a.section && typeof a.section === "object" ? a.section.id : null;
  if (typeof want !== "string" || !want) return 0;
  var sec = null;
  try { sec = sectionFor(el, heads); } catch (e) { sec = null; }
  return sec && sec.id === want ? 1 : 0;
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
  var heads = a.section && typeof a.section === "object" && typeof a.section.id === "string" && a.section.id ? sectionHeads() : null;
  if (kind === "text") {
    var hits = quoteHits(bodyIndex.text, quote, prefix, suffix);
    var qlen = norm(quote).length, scored = [];
    for (i = 0; i < hits.length; i++) {
      var r = rangeFor(bodyIndex, hits[i].at, hits[i].at + qlen);
      if (!r) continue;
      var host = elementOf(r.commonAncestorContainer);
      var inLoc = !!(locEl && host && (locEl === host || locEl.contains(host)));
      scored.push({ el: host || body, range: r, score: hits[i].score + (inLoc ? 1 : 0) + (heads ? sectionBonus(a, host || body, heads) : 0) });
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
    var sc = support(a, cands[i].el, bodyIndex, cands[i].fromLocator, heads);
    if (sc >= 0) {
      out.push({ el: cands[i].el, range: null, score: sc, fromLocator: cands[i].fromLocator,
        ctx: contextMatches(a, cands[i].el, bodyIndex), sec: heads ? sectionBonus(a, cands[i].el, heads) > 0 : false });
    }
  }
  return pickBest(out);
}
/** Does the element's surrounding text match the anchor's saved prefix or
 *  suffix (the same check support() scores)? */
function contextMatches(a, el, bodyIndex) {
  var p = norm(a.prefix), sx = norm(a.suffix);
  if (!p && !sx) return false;
  var ctx = contextOf(el, bodyIndex);
  return !!((p && norm(ctx.before).slice(-p.length) === p) || (sx && norm(ctx.after).slice(0, sx.length) === sx));
}
/** The single best-scored candidate. On a tie, the saved locator's element
 *  wins only if its surrounding text also matches the saved prefix/suffix
 *  (#714 gap 10: "found where it was, in the same context"); otherwise a tie
 *  is "not found", never a guess (an element that merely moved into the old
 *  locator's place must not take the pin). A locator element outside the
 *  saved section loses that tie-break when a tied candidate sits in the saved
 *  section (sections reordered: the old locator now points into the other
 *  one); the single in-section candidate whose context also matches wins,
 *  and several are still "not found". */
function pickBest(list) {
  var best = null, tied = false, i;
  for (i = 0; i < list.length; i++) {
    if (!best || list[i].score > best.score) { best = list[i]; tied = false; }
    else if (list[i].score === best.score) tied = true;
  }
  if (best && tied) {
    var loc = null, inSec = [];
    for (i = 0; i < list.length; i++) {
      if (list[i].score !== best.score) continue;
      if (list[i].fromLocator && list[i].ctx) loc = list[i];
      if (list[i].sec) inSec.push(list[i]);
    }
    if (loc && !loc.sec && inSec.length) {
      return inSec.length === 1 && inSec[0].ctx ? { el: inSec[0].el, range: inSec[0].range } : null;
    }
    if (loc) return { el: loc.el, range: loc.range };
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

/** #714 gap 9 — keyboard commenting: the blocks a reviewer can step through
 *  with the keyboard, in document order. Text blocks, table cells, links,
 *  images, controls, Mermaid nodes and the page's asks. Unrendered subtrees,
 *  hidden elements, closed details content and our own layer are skipped; a
 *  wrapper whose only block child says the same thing (li > p, td > p) is
 *  left to the child. An svg is a block only when it has no Mermaid nodes
 *  (the nodes are). Capped so a hostile page stays cheap. */
var BLOCK_SEL = "h1, h2, h3, h4, h5, h6, p, li, dt, dd, blockquote, pre, figure, img, svg, caption, th, td, a[href], area[href], button, summary, label, input, select, textarea, [data-dp-decision], [data-dp-question], " + NODE_SEL;
var BLOCKS_MAX = 2000;
function layoutLive() {
  var de = document.documentElement;
  if (!de || !de.getBoundingClientRect) return false;
  var r = de.getBoundingClientRect();
  return !!(r.width || r.height);
}
function blockVisible(el, live) {
  if (el.closest("[hidden], template")) return false;
  for (var d = el.parentElement; d; d = d.parentElement) {
    if (d.localName === "details" && !d.open) {
      // Only a details' own first summary shows while it is closed.
      var s = el.closest("summary");
      if (!s || s.parentElement !== d) return false;
    }
  }
  try {
    var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
  } catch (e) { /* keep it */ }
  // A real engine draws every visible element at least once; a test DOM has
  // no layout at all, so the box check runs only when there is one.
  if (live && el.getClientRects && el.getClientRects().length === 0) return false;
  return true;
}
function commentableBlocks() {
  var els = document.querySelectorAll(BLOCK_SEL), out = [], live = layoutLive();
  for (var i = 0; i < els.length && out.length < BLOCKS_MAX; i++) {
    var el = els[i];
    if (inChangeSkip(el) || el.closest(SKIP)) continue;
    if (el.localName === "svg" && el.querySelector(NODE_SEL)) continue;
    if (el.ownerSVGElement && !el.matches(NODE_SEL)) continue;
    if (!blockVisible(el, live)) continue;
    var only = el.children.length === 1 ? el.children[0] : null;
    if (only && only.matches && only.matches(BLOCK_SEL) && !el.matches("[data-dp-decision], [data-dp-question], a[href], button, summary, label") &&
        textPrefix(only, 200) === textPrefix(el, 200)) continue;
    out.push(el);
  }
  return out;
}
/** A block's kind, from a fixed list (what a screen reader is told). */
function blockKind(el) {
  if (!isEl(el)) return "block";
  if (el.hasAttribute("data-dp-decision")) return "decision";
  if (el.hasAttribute("data-dp-question")) return "question";
  if (el.matches(NODE_SEL)) return "diagram node";
  var t = String(el.localName).toLowerCase();
  if (/^h[1-6]$/.test(t)) return "heading";
  if (t === "p") return "paragraph";
  if (t === "li" || t === "dt" || t === "dd") return "list item";
  if (t === "blockquote") return "quote";
  if (t === "pre") return "code";
  if (t === "figure" || t === "img" || t === "svg") return "image";
  if (t === "caption") return "caption";
  if (t === "th" || t === "td") return "cell";
  if (t === "a" || t === "area") return "link";
  if (t === "button" || t === "summary" || t === "label" || t === "input" || t === "select" || t === "textarea") return "control";
  return "block";
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
  sectionFor: sectionFor,
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
  sectionOf: sectionOf,
  BLOCK_SEL: BLOCK_SEL,
  commentableBlocks: commentableBlocks,
  blockKind: blockKind
};
`,Ne=String.raw`
"use strict";
/** #727 — builtins captured at boot. This runs while the parser is blocked on
 *  our script, before any page script exists; after Run the page shares this
 *  realm and may patch String/RegExp/WeakSet/Element prototypes or the timer
 *  globals. The diagnostics path (and own()) uses only these captures, so a
 *  patch can't relabel a genuine event or skip redaction. Captured methods
 *  are called through a bound Function.prototype.call (captured here too).
 *  String.prototype.replace/split are never used there: with a RegExp or a
 *  string separator they dispatch through page-patchable Symbol.replace /
 *  Symbol.split; dReplace drives the captured RegExp exec (which reads only
 *  the regex's internal flags and own lastIndex) and slices instead. */
var dCall = Function.prototype.call;
function dBind(f) { return typeof f === "function" ? dCall.bind(f) : null; }
var dGOPD = Object.getOwnPropertyDescriptor;
function dGetterOf(ctor, name) {
  try { var d = ctor && ctor.prototype ? dGOPD(ctor.prototype, name) : null; return d && d.get ? dBind(d.get) : null; } catch (e) { return null; }
}
var dString = String;
var dExec = dBind(RegExp.prototype.exec);
var dSlice = dBind(String.prototype.slice);
var dLower = dBind(String.prototype.toLowerCase);
var dTrim = dBind(String.prototype.trim);
var dStrIndex = dBind(String.prototype.indexOf);
var dHasOwn = dBind(Object.prototype.hasOwnProperty);
var dWsHas = typeof WeakSet === "function" ? dBind(WeakSet.prototype.has) : null;
var dWsAdd = typeof WeakSet === "function" ? dBind(WeakSet.prototype.add) : null;
var dSetTimeout = setTimeout, dClearTimeout = clearTimeout;
var dNodeType = dGetterOf(window.Node, "nodeType"), dParentEl = dGetterOf(window.Node, "parentElement");
var dLocalName = dGetterOf(window.Element, "localName");
var dHasAttr = window.Element ? dBind(window.Element.prototype.hasAttribute) : null;
var dGetAttrNS = window.Element ? dBind(window.Element.prototype.getAttributeNS) : null;
var dEvTarget = dGetterOf(window.Event, "target");
var dErrMessage = dGetterOf(window.ErrorEvent, "message"), dErrError = dGetterOf(window.ErrorEvent, "error");
var dRejReason = dGetterOf(window.PromiseRejectionEvent, "reason");
var dCspEffective = dGetterOf(window.SecurityPolicyViolationEvent, "effectiveDirective");
var dCspViolated = dGetterOf(window.SecurityPolicyViolationEvent, "violatedDirective");
/** A field through its captured getter. Never a prototype lookup (page
 *  script can patch those after Run): where the platform has no such getter,
 *  the object isn't an instance (the getter throws), or the getter yields
 *  undefined, only an OWN data property is read, via the captured
 *  hasOwnProperty and descriptor value (a browser-made event has none; our
 *  capture listeners run before any page listener could add one). */
function dGet(getter, o, name) {
  if (getter) { try { var v = getter(o); if (v !== undefined) return v; } catch (e) { /* not an instance */ } }
  try {
    if (o == null || !dHasOwn(o, name)) return undefined;
    var d = dGOPD(o, name);
    return d && dHasOwn(d, "value") ? d.value : undefined;
  } catch (e) { return undefined; }
}
function dTimeout(fn, ms) { return dSetTimeout(fn, ms); }
function dCancel(id) { dClearTimeout(id); }
/** Every match of a GLOBAL regex replaced by f(match), by captured exec. */
function dReplace(re, str, f) {
  var out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = dExec(re, str)) !== null) {
    out += dSlice(str, last, m.index) + f(m);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex = re.lastIndex + 1;
  }
  return out + dSlice(str, last);
}
var D_SPACES = /\s+/g, D_DATA = /\b(?:data|blob):[^\s"'<>()]*/gi, D_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]*/gi,
  D_PROTO_REL = /(^|[\s("'=])\/\/[^\s"'<>()]+/g, D_CLASS = /^(?:Uncaught )?([A-Za-z]{1,40})\b/;
/** core.norm / core.clip, on captured builtins only. */
function dNorm(v) { return dTrim(dReplace(D_SPACES, dString(v == null ? "" : v), function () { return " "; })); }
function dClip(v, n) { var t = dString(v == null ? "" : v); return t.length > n ? dSlice(t, 0, n) : t; }
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
var ownNodes = dWsHas ? new WeakSet() : null;
function own(el) {
  if (!ownNodes) return false;
  for (var n = el; n && dGet(dNodeType, n, "nodeType") === 1; n = dGet(dParentEl, n, "parentElement")) if (dWsHas(ownNodes, n)) return true;
  return false;
}
function post(msg) { try { parent.postMessage(msg, "*"); } catch (e) { /* parent gone */ } }
/** #714 gap 12 — this document's instance id, put on ready and diagnostics:
 *  srcDoc updates can reuse the frame's WindowProxy, so the parent tells an
 *  old document's late messages from the new document's by this id, not by
 *  the message source. The companion mints it per srcdoc and injects it
 *  (DP_DOC, a parameter of our wrapper, so page script can't read it from a
 *  global) and accepts only the id it injected into the CURRENT srcdoc: an
 *  old document's queued ready can never claim the new one. Without an
 *  injected id (a harness), a random one. */
var docId = (function () {
  if (typeof DP_DOC === "string" && /^[0-9a-f]{16,64}$/.test(DP_DOC)) return DP_DOC;
  var hex = "", i;
  try {
    var c = window.crypto || (typeof crypto !== "undefined" ? crypto : null);
    var a = new Uint8Array(16);
    c.getRandomValues(a);
    for (i = 0; i < a.length; i++) hex += (a[i] < 16 ? "0" : "") + a[i].toString(16);
  } catch (e) {
    hex = "";
    for (i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
  }
  return hex;
})();
function important(el, styles) {
  for (var k in styles) if (Object.prototype.hasOwnProperty.call(styles, k)) el.style.setProperty(k, styles[k], "important");
}
function mk(tag) {
  var el = document.createElement(tag);
  el.setAttribute("data-dp-annotator", "");
  // #714 gap 13 — our outlines and badges are decoration on the page: a
  // screen reader gets the pins, the keyboard cursor and the queue from the
  // companion (labelled list + live region), never as stray numbers here.
  el.setAttribute("aria-hidden", "true");
  if (ownNodes) dWsAdd(ownNodes, el);
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
  // #714 gap 9 — a touch has no hover: the compatibility mouse events a tap
  // fires must not paint an outline (on iOS a hover-time DOM change can
  // swallow the tap's click).
  if (touchRecent()) { hideHover(); return; }
  var t = targetEl(e);
  var pid = badgesLive() && badgeOk && badgeOk.get(t) === true ? pinIdOf(t) : null;
  setHoverPin(pid, pid !== null ? t : null);
  paintHover(t, !!e.altKey, !!(e.ctrlKey || e.metaKey));
}
/** The pointer left the frame: drop any pin preview. */
function onOut(e) { if (!e.relatedTarget && hoverPin !== null) setHoverPin(null, null); }
function onKey(e) {
  // #725 — the keyup/keypress of a key we handled is ours too, so the page's
  // listeners never see half a keystroke.
  if (e.type === "keydown") forgetOtherKeys(e);
  if (e.type !== "keydown" && swallowedKey(e)) return;
  if (e.type === "keypress") return;
  if (e.type === "keydown" && onKbdKey(e)) return;
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
/** #714 gap 9 — KEYBOARD COMMENT MODE. The parent turns it on (its toggle,
 *  or the C key); while it is on and pointing is on, the arrow keys and
 *  Tab / Shift+Tab move a cursor between commentable blocks, Home / End jump
 *  to the first / last, Enter posts an anchor for the block under the cursor
 *  (exactly what a click on it posts: the parent opens the composer) and
 *  Escape leaves the mode. Tab past the last block (or Shift+Tab before the
 *  first) leaves the mode and lets focus move on, so the frame is never a
 *  keyboard trap. Handled keys are stopped here, in the capture phase,
 *  before the page's own listeners: page scripts never see the reviewer's
 *  navigation keys, and the comment itself is typed in the companion, never
 *  in this frame. (A synthetic key event from page script could at most do
 *  what that script can already do by posting to the parent directly: open
 *  the composer on a spot, which the human still has to submit.)
 *
 *  Each move reports {dp:"kbd-cursor", index, total, kind, text, pins} for
 *  the parent's live region: the block's kind (fixed list), up to 120
 *  characters of its text and the pins on it. Display-only. */
var kbd = false, kbdEl = null, kbdBox = null, kbdBlocks = null, dark = false;
var KBD_TEXT = 120, KBD_PINS = 20;
function blocks() {
  if (!kbdBlocks) { try { kbdBlocks = core.commentableBlocks(); } catch (e) { kbdBlocks = []; } }
  return kbdBlocks;
}
function kbdIndexIn(list) {
  if (!kbdEl) return -1;
  for (var i = 0; i < list.length; i++) if (list[i] === kbdEl) return i;
  return -1;
}
/** The first block on screen (else the first block): where the mode starts. */
function firstInView(list) {
  var vh = window.innerHeight || 0;
  for (var i = 0; i < list.length; i++) {
    var r = list[i].getBoundingClientRect();
    if ((r.width || r.height) && r.bottom > 0 && (!vh || r.top < vh)) return i;
  }
  return list.length ? 0 : -1;
}
function drawKbd() {
  if (!kbd || !kbdEl || !kbdEl.isConnected || !kbdEl.getBoundingClientRect) {
    if (kbdBox && kbdBox.parentNode) kbdBox.parentNode.removeChild(kbdBox);
    return;
  }
  if (!kbdBox || !kbdBox.isConnected) {
    kbdBox = mk("dp-annotator-kbd");
    ensureLayer().appendChild(kbdBox);
  }
  // A ring with a contrasting halo, so it reads on light and dark content.
  important(kbdBox, { position: "absolute", display: "block", "box-sizing": "border-box", "pointer-events": "none",
    margin: "0", padding: "0", background: "transparent", "border-radius": "3px",
    outline: "3px solid " + (dark ? "#93c5fd" : "#1d4ed8"),
    "box-shadow": "0 0 0 5px " + (dark ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.9)") });
  place(kbdBox, kbdEl.getBoundingClientRect());
}
function kbdPins(el) {
  var out = [];
  for (var j = 0; j < pinEls.length && out.length < KBD_PINS; j++) {
    var p = pinEls[j];
    if (p && p.isConnected && (p === el || el.contains(p))) out.push(j);
  }
  return out;
}
function kbdReport(i, list) {
  var el = i >= 0 ? list[i] : null;
  var text = "";
  if (el) { try { text = core.textPrefix(el, KBD_TEXT); } catch (e) { text = ""; } }
  post({ dp: "kbd-cursor", index: i, total: list.length, kind: el ? core.blockKind(el) : "block", text: text, pins: el ? kbdPins(el) : [] });
}
/** step: 1 / -1, "first" / "last", or 0 (enter the mode: stay on the cursor's
 *  block if it is still on the page, else the first block on screen). */
function kbdMove(step) {
  var list = blocks();
  if (!list.length) { kbdEl = null; drawKbd(); kbdReport(-1, list); return; }
  var i = kbdIndexIn(list);
  if (step === "first") i = 0;
  else if (step === "last") i = list.length - 1;
  else if (i < 0) i = firstInView(list);
  else i = Math.min(list.length - 1, Math.max(0, i + step));
  kbdEl = list[i];
  if (typeof kbdEl.scrollIntoView === "function") kbdEl.scrollIntoView({ block: "nearest" });
  drawKbd();
  kbdReport(i, list);
}
function setKbd(on) {
  if (on === kbd) return;
  kbd = on;
  if (on) kbdMove(0);
  else drawKbd();
}
function kbdComment() {
  if (!kbdEl || !kbdEl.isConnected) return;
  var a = null;
  try { a = core.anchorForTarget(kbdEl); } catch (e) { a = null; }
  if (a) { flash(kbdEl); post({ dp: "anchor", anchor: a }); }
}
/** Single-key shortcuts forwarded to the parent, only before Run (no page
 *  script then to take a key from): C comment mode, ? shortcut help, ] / [
 *  next / previous comment in the review queue, Escape (leave the expanded
 *  view). The parent decides what each may do. */
var FRAME_KEYS = { c: "toggle-kbd", "?": "help", "]": "next", "[": "prev", Escape: "escape" };
/** Keys whose keydown we handled, until their keyup — by physical key
 *  (e.code), so "?" released after Shift (keyup "/") still matches. The
 *  keyup may never come here (Enter opens the composer, ] / [ focus a queue
 *  row): an entry is dropped on the next keydown of any other key, when the
 *  frame loses or gains focus, and never applies in a page field (we never
 *  handle keys there). */
var swallowed = {};
function keyId(e) { return String(e.code || e.key || ""); }
function stopKey(e) {
  e.preventDefault();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else e.stopPropagation();
}
function forgetOtherKeys(e) {
  var id = keyId(e);
  for (var k in swallowed) if (Object.prototype.hasOwnProperty.call(swallowed, k) && k !== id) delete swallowed[k];
}
function forgetKeys() { swallowed = {}; }
function swallowedKey(e) {
  var id = keyId(e);
  if (!Object.prototype.hasOwnProperty.call(swallowed, id)) return false;
  if (e.type === "keyup") delete swallowed[id];
  if (editable(targetEl(e))) { delete swallowed[id]; return false; }
  stopKey(e);
  return true;
}
function frameKey(k) {
  // C with Caps Lock (or Shift) is still C.
  return k === "C" ? "c" : k;
}
/** True when the key was ours (handled and stopped). */
function onKbdKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (editable(targetEl(e))) return false;
  var k = e.key;
  if (kbd && annotate) {
    var list = blocks(), at = kbdIndexIn(list);
    if (k === "Tab" && ((!e.shiftKey && at >= list.length - 1) || (e.shiftKey && at <= 0))) {
      // Past either end: leave the mode and let Tab move focus on.
      setKbd(false);
      post({ dp: "kbd-off" });
      return true;
    }
    var handled = true;
    if (k === "ArrowDown" || k === "ArrowRight" || (k === "Tab" && !e.shiftKey)) kbdMove(1);
    else if (k === "ArrowUp" || k === "ArrowLeft" || (k === "Tab" && e.shiftKey)) kbdMove(-1);
    else if (k === "Home") kbdMove("first");
    else if (k === "End") kbdMove("last");
    else if (k === "Enter") { if (!e.repeat) kbdComment(); }
    else if (k === "Escape") { setKbd(false); post({ dp: "kbd-off" }); }
    else handled = false;
    if (handled) {
      swallowed[keyId(e)] = true;
      stopKey(e);
      return true;
    }
  }
  var fk = frameKey(k);
  if (scripts || e.repeat || !Object.prototype.hasOwnProperty.call(FRAME_KEYS, fk)) return false;
  e.preventDefault();
  swallowed[keyId(e)] = true;
  post({ dp: "key", key: FRAME_KEYS[fk] });
  return true;
}

/** #714 gap 9 — TOUCH. A tap is a click, so it points as one (no hover
 *  needed). After a touch, the compatibility mouse events never paint the
 *  hover outline. A text selection made by touch (long-press, then the
 *  handles) gets a 44px "Comment" button under it once it settles; tapping
 *  the button posts the text anchor computed when it was shown. Mouse
 *  selections keep the mouseup path. */
var lastPointer = "", lastTouchAt = 0, selBtn = null, selAnchor = null, selPending = 0;
function now() { return Date.now ? Date.now() : new Date().getTime(); }
function touchRecent() { return lastPointer === "touch" && now() - lastTouchAt < 1500; }
function coarse() {
  if (lastPointer === "touch") return true;
  if (lastPointer === "mouse") return false;
  try { return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch (e) { return false; }
}
function isSelBtn(t) { return !!(selBtn && t && (t === selBtn || (selBtn.contains && selBtn.contains(t)))); }
function onPointerDown(e) {
  var pt = e && e.pointerType;
  if (pt === "touch" || pt === "pen") { lastPointer = "touch"; lastTouchAt = now(); hideHover(); }
  else if (pt === "mouse") lastPointer = "mouse";
  // Keep the selection alive while the Comment button is pressed.
  if (isSelBtn(targetEl(e))) e.preventDefault();
}
function hideSelBtn() {
  selAnchor = null;
  if (selBtn && selBtn.parentNode) selBtn.parentNode.removeChild(selBtn);
}
function onSelectionChange() {
  if (selPending) clearTimeout(selPending);
  selPending = setTimeout(checkSelection, 350);
}
function checkSelection() {
  selPending = 0;
  if (!annotate || lastPointer !== "touch") { hideSelBtn(); return; }
  var sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelBtn(); return; }
  var range = sel.getRangeAt(0);
  var host = range.commonAncestorContainer;
  if (host && host.nodeType !== 1) host = host.parentElement;
  if (!host || own(host)) { hideSelBtn(); return; }
  var a = null;
  try { a = core.textAnchor(range); } catch (e) { a = null; }
  if (!a) { hideSelBtn(); return; }
  var r = null;
  try { r = range.getBoundingClientRect(); } catch (e2) { r = null; }
  if (!r) { hideSelBtn(); return; }
  if (!selBtn) {
    selBtn = mk("dp-annotator-selbtn");
    // The one control of ours a screen reader may reach.
    selBtn.removeAttribute("aria-hidden");
    selBtn.setAttribute("role", "button");
    selBtn.setAttribute("aria-label", "Comment on the selected text");
    selBtn.textContent = "Comment";
  }
  // Outside our aria-hidden layer, so a screen reader can reach it.
  if (!selBtn.isConnected) (document.documentElement || document.body).appendChild(selBtn);
  selAnchor = a;
  var sx = window.scrollX || window.pageXOffset || 0, sy = window.scrollY || window.pageYOffset || 0;
  var vw = window.innerWidth || 0;
  var left = Math.max(4, Math.min(r.left, (vw || r.left + 120) - 124));
  important(selBtn, { position: "absolute", display: "block", "box-sizing": "border-box", left: (left + sx) + "px",
    top: (r.bottom + sy + 8) + "px", "min-width": "44px", "min-height": "44px", padding: "0 16px", margin: "0",
    "border-radius": "22px", border: "0", background: dark ? "#93c5fd" : "#1d4ed8", color: dark ? "#0b1220" : "#fff",
    font: "600 15px/44px system-ui, sans-serif", "pointer-events": "auto", cursor: "pointer", "z-index": "2147483647",
    "box-shadow": "0 2px 8px rgba(0,0,0,0.35)", "user-select": "none", "-webkit-user-select": "none" });
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
function badgeCoversNative(badge, hit) {
  // No hit-testing (old engines, test DOMs): we can't know what lies under
  // the offset badge, so it stays inert (conservative).
  if (typeof document.elementsFromPoint !== "function") return true;
  var r = badge.getBoundingClientRect();
  var vw = window.innerWidth || document.documentElement.clientWidth || 0;
  var vh = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!r.width || r.right < 0 || r.bottom < 0 || (vw && r.left > vw) || (vh && r.top > vh)) return true;
  if (hit && (r.left < 0 || r.top < 0 || (vw && r.right > vw) || (vh && r.bottom > vh))) return true;
  var pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]];
  for (var i = 0; i < pts.length; i++) if (nativeUnder(pageElAt(pts[i][0], pts[i][1]))) return true;
  return false;
}
/** Badge spots, in the pin box's coordinates (the box is the anchor +2px on
 *  every side): outside top-left (preferred: never on the element itself),
 *  outside top-right, then inside the anchor's top-left / top-right corners. */
function badgeSpots(r, bw, hit) {
  var w = r.width + 4, out = -(20 + 2 * (hit || 0));
  return [[out, out], [w + 2, out], [4, 4], [w - 4 - bw, 4]];
}
/** Choose an unobstructed spot. Touch badges must fit in both viewport axes.
 *  Desktop badges keep the original horizontal fit and document-top bound.
 *  Recheck the final rectangle after clamping before making a badge live. */
function placeBadge(badge, r, hit) {
  // #714 gap 9 — hit is the touch hit-area border on each side.
  var bw = Math.max(18 + 2 * (hit || 0), badge.offsetWidth || 0);
  var bh = 18 + 2 * (hit || 0);
  var vw = window.innerWidth || document.documentElement.clientWidth || 0;
  var vh = window.innerHeight || document.documentElement.clientHeight || 0;
  var sy = window.scrollY || window.pageYOffset || 0;
  var spots = badgeSpots(r, bw, hit), fallback = null;
  function fits(s) {
    var x = r.left - 2 + s[0], y = r.top - 2 + s[1];
    var fitsY = hit ? y >= 0 && (!vh || y + bh <= vh) : y + sy >= 0;
    return x >= 0 && (!vw || x + bw <= vw) && fitsY;
  }
  function put(s) { important(badge, { left: s[0] + "px", top: s[1] + "px" }); }
  for (var i = 0; i < spots.length; i++) {
    if (!fits(spots[i])) continue;
    put(spots[i]);
    if (!badgeCoversNative(badge, hit)) return false;
    if (!fallback) fallback = spots[i];
  }
  if (!fallback) {
    // Nothing fits (e.g. an anchor scrolled partly out horizontally): clamp
    // the outside-top-left spot into the viewport and the document.
    var o = 22 + 2 * (hit || 0);
    var x = Math.min(Math.max(r.left - o, 0), vw ? Math.max(vw - bw, 0) : Infinity);
    var y = Math.max(r.top - o, -sy);
    // Keep a touch fallback fully in view while its anchor is visible.
    // An offscreen anchor should continue to scroll with its badge.
    if (hit && r.bottom > 0 && (!vh || r.top < vh)) {
      y = Math.min(Math.max(y, 0), vh ? Math.max(vh - bh, 0) : Infinity);
    }
    fallback = [x - (r.left - 2), y - (r.top - 2)];
  }
  put(fallback);
  return badgeCoversNative(badge, hit);
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
    // Preferably fully OUTSIDE the anchored element's top-left corner (the
    // pin box is the element +2px; the 18px badge ends 2px before it), so it
    // never sits on the element's own interactive area; placeBadge() moves it
    // to a viewport-visible spot clear of native controls when that's off-screen.
    // #714 gap 9 — on a touch screen the badge keeps its 18px look but takes
    // a 44px hit area (a transparent border; the background stops at it).
    var hit = coarse() ? 13 : 0, off = -(20 + 2 * hit);
    important(badge, { position: "absolute", left: off + "px", top: off + "px", display: "block", "box-sizing": "content-box",
      "min-width": "10px", height: "18px", padding: "0 4px", "border-radius": (9 + hit) + "px", background: color,
      border: hit + "px solid transparent", "background-clip": "padding-box",
      color: "#111", font: "600 11px/18px system-ui, sans-serif", "text-align": "center",
      "pointer-events": "none", cursor: "default" });
    pin.appendChild(badge);
    l.appendChild(pin);
    var ok = !!id && !!badgeIds && !!badgeOk && !placeBadge(badge, r, hit);
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
  drawKbd();
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
  if ((!current.length && !(showChanges && changes.length) && !kbd) || pending) return;
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
      mo = new window.MutationObserver(function (records) { if (relevant(records)) { invalidateChanges(); kbdBlocks = null; schedule(); scheduleOutline(); } });
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
    // #714 gaps 9+13 — keyboard comment mode (only while pointing) and
    // whether the page renders dark (our cursor and button colours).
    var wasDark = dark;
    dark = d.dark === true;
    if (!annotate) { hideHover(); hideSelBtn(); }
    syncBadges();
    setKbd(d.kbd === true && annotate);
    if (dark !== wasDark) drawKbd();
  }
}
function onMouseDown() { suppressClick = false; }
function onMouseUp(e) {
  if (!annotate || e.ctrlKey || e.metaKey) return;
  // A touch selection gets the Comment button instead (checkSelection).
  if (touchRecent()) return;
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
  // #714 gap 9 — the touch selection's Comment button (ours, by reference).
  if (isSelBtn(t)) {
    e.preventDefault();
    e.stopPropagation();
    var sa = selAnchor;
    hideSelBtn();
    if (annotate && sa) {
      post({ dp: "anchor", anchor: sa });
      try { window.getSelection().removeAllRanges(); } catch (x) { /* ignore */ }
    }
    return;
  }
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
/** #714 gap 12 — render diagnostics: script errors, unhandled rejections,
 *  resources that failed to load (capture phase: element errors don't
 *  bubble) and requests the frame's CSP blocked. Installed with the other
 *  listeners, before any page markup is parsed, so both the pre-Run document
 *  and the running page are covered. Reported as bounded, de-duplicated
 *  counts: at most DIAG.samples distinct messages per kind, each redacted
 *  (URLs, data: and blob: URIs replaced) and clipped to DIAG.text; a resource
 *  is named only by tag + attribute and a block only by its directive, never
 *  by URL (a URL can carry credentials). Display-only for the parent. */
var DIAG = { samples: 3, text: 120, keys: 8, max: 9999 };
var DIAG_ATTRS = { img: ["src", "srcset"], source: ["src", "srcset"], video: ["src", "poster"], audio: ["src"], track: ["src"],
  script: ["src"], link: ["href"], iframe: ["src"], frame: ["src"], embed: ["src"], object: ["data"], input: ["src"],
  image: ["href", "xlink:href"], use: ["href", "xlink:href"] };
/** Fixed allowlists, equal to the shared PAGE_RESOURCE_KEYS and
 *  PAGE_CSP_DIRECTIVES (a parity test checks): anything else is reported as
 *  "other resource" / "other". */
var RESOURCE_KEYS = ["img src", "img srcset", "source src", "source srcset", "video src", "video poster", "audio src", "track src", "script src", "link href", "iframe src", "frame src", "embed src", "object data", "input src", "image href", "use href"];
var CSP_DIRECTIVES = ["default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "img-src", "font-src", "connect-src", "media-src", "object-src", "frame-src", "child-src", "worker-src", "manifest-src", "base-uri", "form-action", "frame-ancestors", "navigate-to", "prefetch-src", "sandbox", "trusted-types", "require-trusted-types-for", "upgrade-insecure-requests", "report-uri", "report-to"];
/** #727 — after Run the page's scripts share this realm and can patch
 *  Array.prototype (push/indexOf/sort/slice, an index setter, a species
 *  constructor). The diagnostics path therefore calls no Array method: it
 *  reads own elements in plain loops, appends with a defineProperty captured
 *  at boot (a null-prototype descriptor, so an inherited get/set can't turn
 *  it into an accessor), and swaps only existing own elements. */
var dDefine = Object.defineProperty;
function dIndex(a, v) { for (var i = 0; i < a.length; i++) if (a[i] === v) return i; return -1; }
function dPush(a, v) { dDefine(a, a.length, { __proto__: null, value: v, writable: true, enumerable: true, configurable: true }); }
function dCopy(a) { var out = []; for (var i = 0; i < a.length; i++) dPush(out, a[i]); return out; }
var diag = { script: 0, rejection: 0, scriptSamples: [], rejectionSamples: [], scriptClasses: [], rejectionClasses: [], resources: [], blocked: [] };
/** An error's CLASS name (the only part of an error the agent sees), from
 *  a fixed allowlist; anything else is "Error". Must equal the shared
 *  PAGE_ERROR_CLASSES (a parity test checks). */
var ERROR_CLASSES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError", "InternalError", "DOMException", "SecurityError", "NetworkError", "AbortError", "NotAllowedError", "NotFoundError", "NotSupportedError", "InvalidStateError", "QuotaExceededError", "TimeoutError", "DataCloneError"];
function knownClass(n) { return typeof n === "string" && dIndex(ERROR_CLASSES, n) !== -1; }
function errClass(name, message) {
  if (knownClass(name)) return name;
  D_CLASS.lastIndex = 0;
  var m = dExec(D_CLASS, typeof message === "string" ? message : "");
  return m && knownClass(m[1]) ? m[1] : "Error";
}
var diagSeen = dWsHas ? new WeakSet() : null, diagPending = 0, lastDiagJson = "";
/** Nothing is published before ready: until then the parent may not know
 *  this document, and a report it dropped would be deduped away for good. */
var readySent = false;
function redactDiag(v) {
  var t = dNorm(v);
  t = dReplace(D_DATA, t, function () { return "[data URI]"; });
  t = dReplace(D_URL, t, function () { return "[url]"; });
  t = dReplace(D_PROTO_REL, t, function (m) { return m[1] + "[url]"; });
  return dClip(t, DIAG.text);
}
function diagBump(n) { return n < DIAG.max ? n + 1 : n; }
function diagSample(list, v) {
  var t = redactDiag(v);
  if (t && list.length < DIAG.samples && dIndex(list, t) === -1) dPush(list, t);
}
/** Every distinct key is kept (keys come from finite allowlists, so this is
 *  bounded); the DIAG.keys cap is applied at report time, in canonical order
 *  (see canonKeys), so the retained keys never depend on discovery order. */
function diagKey(list, key) {
  for (var i = 0; i < list.length; i++) if (list[i].key === key) { list[i].count = diagBump(list[i].count); return; }
  dPush(list, { key: key, count: 1 });
}
function diagHas(el, attr) {
  try {
    if (attr === "xlink:href") return dGetAttrNS ? dGetAttrNS(el, XLINK, "href") !== null : false;
    return dHasAttr ? !!dHasAttr(el, attr) : false;
  } catch (e) { return false; }
}
/** #727 — only events the browser dispatched count: page script can
 *  dispatchEvent a synthetic ErrorEvent, PromiseRejectionEvent or
 *  SecurityPolicyViolationEvent, and isTrusted is unforgeable (an own
 *  [LegacyUnforgeable] property of every event). */
function untrusted(e) { return !e || e.isTrusted === false; }
function onDiagError(e) {
  if (untrusted(e)) return;
  var t = dGet(dEvTarget, e, "target");
  if (t && dGet(dNodeType, t, "nodeType") === 1) {
    if (own(t)) return;
    var tag = dLower(dString(dGet(dLocalName, t, "localName") || "")), attrs = dHasOwn(DIAG_ATTRS, tag) ? DIAG_ATTRS[tag] : null;
    if (!attrs) return;
    if (diagSeen) { if (dWsHas(diagSeen, t)) return; dWsAdd(diagSeen, t); }
    var attr = attrs[0];
    for (var i = 0; i < attrs.length; i++) if (diagHas(t, attrs[i])) { attr = attrs[i]; break; }
    var rk = tag + " " + (attr === "xlink:href" ? "href" : attr);
    diagKey(diag.resources, dIndex(RESOURCE_KEYS, rk) !== -1 ? rk : "other resource");
  } else {
    diag.script = diagBump(diag.script);
    var m = "", cls = "Error";
    try {
      var em = dGet(dErrMessage, e, "message");
      m = typeof em === "string" ? em : "";
      var er = dGet(dErrError, e, "error");
      cls = errClass(er && typeof er === "object" ? er.name : null, m);
    } catch (x) { m = ""; cls = "Error"; }
    diagSample(diag.scriptSamples, m || "Script error");
    diagKey(diag.scriptClasses, cls);
  }
  scheduleDiag();
}
function onDiagRejection(e) {
  if (untrusted(e)) return;
  var m = "", cls = "Error";
  try {
    var r = dGet(dRejReason, e, "reason");
    if (r && typeof r === "object" && typeof r.message === "string") {
      m = (typeof r.name === "string" && r.name ? r.name + ": " : "") + r.message;
      cls = errClass(r.name, "");
    } else m = dString(r);
  } catch (x) { m = "Unhandled rejection"; cls = "Error"; }
  diag.rejection = diagBump(diag.rejection);
  diagSample(diag.rejectionSamples, m || "Unhandled rejection");
  diagKey(diag.rejectionClasses, cls);
  scheduleDiag();
}
function onDiagCsp(e) {
  if (untrusted(e)) return;
  var d = "";
  try {
    d = dLower(dString(dGet(dCspEffective, e, "effectiveDirective") || dGet(dCspViolated, e, "violatedDirective") || ""));
    var sp = dStrIndex(d, " ");
    if (sp !== -1) d = dSlice(d, 0, sp);
  } catch (x) { d = ""; }
  if (dIndex(CSP_DIRECTIVES, d) === -1) d = "other";
  diagKey(diag.blocked, d);
  scheduleDiag();
}
/** The first DIAG.keys keys in canonical order: allowlist position, the
 *  catch-all ("Error" is listed; "other resource" / "other" are not) last.
 *  Must rank as the shared pageRenderIssueKeyRank does. */
function canonKeys(list, allow) {
  var all = [], out = [], i, j, x;
  for (i = 0; i < list.length; i++) dPush(all, { key: list[i].key, count: list[i].count });
  function rank(k) { var r = dIndex(allow, k); return r === -1 ? allow.length : r; }
  // Stable insertion sort (the lists are short: finite allowlists).
  for (i = 1; i < all.length; i++) {
    x = all[i];
    for (j = i - 1; j >= 0 && rank(all[j].key) > rank(x.key); j--) all[j + 1] = all[j];
    all[j + 1] = x;
  }
  for (i = 0; i < all.length && i < DIAG.keys; i++) dPush(out, all[i]);
  return out;
}
/** The dedupe signature, by string concatenation only (no JSON.stringify or
 *  inherited toJSON, which page script could patch to see or rewrite it). */
function diagSig(b) {
  function keys(l) { var s = ""; for (var i = 0; i < l.length; i++) s += "|" + l[i].key + "=" + l[i].count; return s; }
  function texts(l) { var s = ""; for (var i = 0; i < l.length; i++) s += "|" + l[i].length + ":" + l[i]; return s; }
  return "s" + b.scriptErrors.count + texts(b.scriptErrors.samples) + keys(b.scriptErrors.classes) +
    "/r" + b.rejections.count + texts(b.rejections.samples) + keys(b.rejections.classes) +
    "/x" + keys(b.resources) + "/b" + keys(b.blocked);
}
function reportDiag() {
  diagPending = 0;
  if (!readySent) return;
  if (!diag.script && !diag.rejection && !diag.resources.length && !diag.blocked.length) return;
  // #727 — the document id never goes near anything page script can patch
  // after Run: the dedupe key is built from a body WITHOUT it (diagSig, no
  // JSON.stringify), and the posted message is a fresh literal handed only to
  // the parent's cross-origin postMessage.
  var body = {
    scriptErrors: { count: diag.script, samples: dCopy(diag.scriptSamples), classes: canonKeys(diag.scriptClasses, ERROR_CLASSES) },
    rejections: { count: diag.rejection, samples: dCopy(diag.rejectionSamples), classes: canonKeys(diag.rejectionClasses, ERROR_CLASSES) },
    resources: canonKeys(diag.resources, RESOURCE_KEYS), blocked: canonKeys(diag.blocked, CSP_DIRECTIVES) };
  var json = diagSig(body);
  if (json !== lastDiagJson) {
    lastDiagJson = json;
    post({ dp: "diagnostics", doc: docId, scriptErrors: body.scriptErrors, rejections: body.rejections, resources: body.resources, blocked: body.blocked });
  }
}
function scheduleDiag() {
  if (diagPending) return;
  try { diagPending = dTimeout(reportDiag, 250); } catch (e) { diagPending = 0; }
}
function onReady() {
  if (document.body && ro) { try { ro.observe(document.body); } catch (e) { /* ignore */ } }
  post({ dp: "ready", doc: docId });
  // Ready opens publication: the full current snapshot follows at once,
  // never suppressed by a dedupe from before ready.
  readySent = true;
  lastDiagJson = "";
  if (diagPending) { dCancel(diagPending); diagPending = 0; }
  reportOutline();
  reportDiag();
}
window.addEventListener("click", onClick, true);
window.addEventListener("auxclick", onAuxClick, true);
window.addEventListener("mousedown", onMouseDown, true);
window.addEventListener("mouseup", onMouseUp, true);
window.addEventListener("mousemove", onMove, true);
window.addEventListener("mouseout", onOut, true);
window.addEventListener("pointerdown", onPointerDown, true);
document.addEventListener("selectionchange", onSelectionChange);
window.addEventListener("keydown", onKey, true);
window.addEventListener("keyup", onKey, true);
window.addEventListener("keypress", onKey, true);
window.addEventListener("blur", forgetKeys);
window.addEventListener("focus", forgetKeys);
window.addEventListener("message", onMessage);
window.addEventListener("resize", onResize);
window.addEventListener("scroll", onScroll, true);
window.addEventListener("error", onDiagError, true);
window.addEventListener("unhandledrejection", onDiagRejection);
document.addEventListener("securitypolicyviolation", onDiagCsp, true);
observe();
if (document.readyState === "complete") onReady(); else window.addEventListener("load", onReady);
return function uninstall() {
  window.removeEventListener("click", onClick, true);
  window.removeEventListener("auxclick", onAuxClick, true);
  window.removeEventListener("mousedown", onMouseDown, true);
  window.removeEventListener("mouseup", onMouseUp, true);
  window.removeEventListener("mousemove", onMove, true);
  window.removeEventListener("mouseout", onOut, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("selectionchange", onSelectionChange);
  if (selPending) clearTimeout(selPending);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKey, true);
  window.removeEventListener("keypress", onKey, true);
  window.removeEventListener("blur", forgetKeys);
  window.removeEventListener("focus", forgetKeys);
  if (selBtn && selBtn.parentNode) selBtn.parentNode.removeChild(selBtn);
  window.removeEventListener("message", onMessage);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("load", onReady);
  window.removeEventListener("error", onDiagError, true);
  window.removeEventListener("unhandledrejection", onDiagRejection);
  document.removeEventListener("securitypolicyviolation", onDiagCsp, true);
  if (diagPending) dCancel(diagPending);
  if (mo) mo.disconnect();
  if (ro) ro.disconnect();
  if (pending) clearTimeout(pending);
  if (outlinePending) clearTimeout(outlinePending);
  if (activePending) clearTimeout(activePending);
  if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
};
`;function Pe(e){let t=typeof e==`string`&&/^[0-9a-f]{16,64}$/.test(e)?JSON.stringify(e):`undefined`;return`(function(){var me=document.currentScript;if(me&&me.parentNode)me.parentNode.removeChild(me);me=null;try{var core=(function(document,window){`+Me+`
})(document,window);(function(document,window,parent,core,DP_DOC){`+Ne+`
})(document,window,window.parent,core,`+t+`);}catch(e){}})();`}var k=Pe(),Fe=new Set(T);function A(e){let t=e.replace(/[\x00-\x20\x7f-\x9f]/g,``).toLowerCase();return t.startsWith(`javascript:`)||t.startsWith(`vbscript:`)||t.startsWith(`data:text/html`)||t.startsWith(`data:application/xhtml`)}function Ie(e){for(let t of Array.from(e.attributes)){let n=t.name.toLowerCase();if(n.startsWith(`on`)){e.removeAttribute(t.name);continue}(n===`srcdoc`||A(t.value))&&e.removeAttribute(t.name)}}var Le=[`class`,`dir`,`lang`,`style`];function Re(e){return!/url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding|\\/i.test(e)}function ze(e){let t={};if(!e)return t;for(let n of Le){let r=e.getAttribute(n);r==null||r===``||n===`dir`&&!/^(ltr|rtl|auto)$/i.test(r.trim())||n===`style`&&!Re(r)||(t[n]=r)}return t}function Be(e){let t=[],n=e.documentElement?[e.documentElement]:[];for(;n.length;){let e=n.pop();t.push(e);let r=e.childNodes;for(let e=r.length-1;e>=0;e--){let t=r[e];t.nodeType===1&&n.push(t)}}return t}function Ve(e){if(typeof DOMParser>`u`)return{html:``,htmlAttrs:{},bodyAttrs:{}};let t=new DOMParser().parseFromString(e,`text/html`);for(let e of Be(t))Fe.has(e.localName.toLowerCase())&&e.remove();for(let e of Array.from(t.querySelectorAll(`script`)))e.remove();for(let e of Array.from(t.getElementsByTagNameNS(`*`,`script`)))e.remove();for(let e of Array.from(t.querySelectorAll(`meta`)))(e.getAttribute(`http-equiv`)??``).trim().toLowerCase()===`refresh`&&e.remove();for(let e of Be(t)){let t=e.localName.toLowerCase();t!==`set`&&!t.startsWith(`animate`)||(Array.from(e.attributes).find(e=>e.name.toLowerCase()===`attributename`)?.value??``).toLowerCase().includes(`href`)&&e.remove()}for(let e of Be(t))Ie(e);return{html:t.head.innerHTML+t.body.innerHTML,htmlAttrs:ze(t.documentElement),bodyAttrs:ze(t.body)}}var He=class extends Error{constructor(){super(`render aborted`),this.name=`RendererAbortError`}},Ue=class extends Error{},j=class extends Error{constructor(){super(`diagram renderer unavailable`),this.name=`RendererUnavailableError`}},We=class extends Error{constructor(){super(`diagram renderer did not load in time`),this.name=`RendererColdError`}},Ge=class extends Error{constructor(){super(`diagram renderer could not load in this tab`),this.name=`RendererExhaustedError`}},Ke=class{frame=null;ready=null;markReady=null;failReady=null;readyTimer=null;unavailable;readyMisses=0;backoffUntil=0;pending=null;unlisten=null;chain=Promise.resolve();seq=0;framesCreated=0;constructor(e){this.deps=e,this.unavailable=!!e.unavailable,this.render=Object.assign((e,t,n,r,i)=>{let a=this.blockedError();if(a)return Promise.reject(a);let o=()=>this.renderOne(e,t,n,r,i),s=this.chain.then(o,o);return this.chain=s.catch(()=>void 0),s},{reportsStart:!0})}render;blockedError(){return this.unavailable?new j:this.readyMisses>=(this.deps.maxReadyMisses??3)?new Ge:!this.frame&&Date.now()<this.backoffUntil?new We:null}dispose(){this.destroyFrame(new He),this.unlisten?.(),this.unlisten=null}onMessage=e=>{if(!this.frame||e.source!==this.frame.target)return;let t=Ee.safeParse(e.data);if(!t.success)return;let n=t.data;if(n.type===`dp-mermaid-ready`){this.readyTimer&&clearTimeout(this.readyTimer),this.readyTimer=null,this.readyMisses=0,this.markReady?.();return}let r=this.pending;!r||n.reqId!==r.reqId||(this.pending=null,n.type===`dp-mermaid-result`?r.resolve(n.svg):r.reject(new Ue(n.error)))};ensureFrame(){if(this.unlisten||=this.deps.listen(this.onMessage),this.frame&&this.ready)return this.ready;this.ready=new Promise((e,t)=>{this.markReady=e,this.failReady=t}),this.ready.catch(()=>void 0);try{this.frame=this.deps.createFrame()}catch{this.unavailable=!0;let e=this.ready;return this.destroyFrame(new j),e}return this.framesCreated++,this.readyTimer=setTimeout(()=>{this.readyTimer=null,this.readyMisses++,this.backoffUntil=Date.now()+(this.deps.readyBackoffMs??3e4);let e=this.readyMisses>=(this.deps.maxReadyMisses??3);this.destroyFrame(e?new Ge:new We)},this.deps.readyTimeoutMs??1e4),this.ready}destroyFrame(e){let t=this.pending;if(this.pending=null,this.readyTimer&&clearTimeout(this.readyTimer),this.readyTimer=null,this.failReady?.(e),this.frame)try{this.frame.destroy()}catch{}this.frame=null,this.ready=null,this.markReady=null,this.failReady=null,t?.reject(e)}renderOne(e,t,n,r,i){if(r?.aborted)return Promise.reject(new He);let a=this.blockedError();return a?Promise.reject(a):new Promise((a,o)=>{let s=`r${++this.seq}`,c=!1,l=e=>{c||(c=!0,r?.removeEventListener(`abort`,u),e())},u=()=>{this.destroyFrame(new He),l(()=>o(new He))};r?.addEventListener(`abort`,u,{once:!0}),this.ensureFrame().then(()=>{if(c||!this.frame)return;this.pending={reqId:s,resolve:e=>l(()=>a(e)),reject:e=>l(()=>o(e))};let r={type:`dp-mermaid-render`,reqId:s,id:e,source:t,theme:n};this.frame.target.postMessage(r,`*`),i?.()},e=>l(()=>o(e)))})}};function qe(e=De){let t=document.createElement(`iframe`);t.setAttribute(`sandbox`,`allow-scripts`),t.setAttribute(`aria-hidden`,`true`),t.setAttribute(`tabindex`,`-1`),t.setAttribute(`title`,`Diagram renderer`),t.setAttribute(`data-dp-mermaid-renderer`,``),t.style.cssText=`position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none`,t.src=e,document.body.appendChild(t);let n=t.contentWindow;if(!n)throw t.remove(),new Ue(`renderer frame has no window`);return{target:n,destroy:()=>t.remove()}}function M(e){let t=t=>e({source:t.source,data:t.data});return window.addEventListener(`message`,t),()=>window.removeEventListener(`message`,t)}function Je(e){return e===`http:`||e===`https:`}var Ye=/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;function Xe(e,t){let n=t?.trim()??``,r=Ye.exec(n);return r&&Number(r[1])<=65535?`${n}${De}`:Je(e)?De:null}function Ze(){return typeof document>`u`?null:document.querySelector(`head > meta[name="deeppairing-daemon-origin"]`)?.getAttribute(`content`)??null}var N=null;function Qe(){if(!N){let e=Xe(typeof location>`u`?void 0:location.protocol,Ze());N=new Ke({createFrame:()=>qe(e??`/mermaid-renderer.html`),listen:M,unavailable:e===null})}return N}var $e=`pre.mermaid, div.mermaid, code.language-mermaid`;function et(e){return/mermaid/i.test(e)}function P(e){return!et(e)||typeof DOMParser>`u`?!1:dt(new DOMParser().parseFromString(e,`text/html`)).some(e=>(e.textContent??``).trim()!==``)}var tt=new Set(`svg.g.path.rect.circle.ellipse.line.polyline.polygon.text.tspan.textpath.defs.marker.style.title.desc.lineargradient.radialgradient.stop.clippath.mask.pattern.symbol.use.foreignobject.switch.filter.feblend.fecolormatrix.fecomposite.fedropshadow.feflood.fegaussianblur.femerge.femergenode.feoffset`.split(`.`)),nt=new Set([`div`,`span`,`p`,`br`,`b`,`strong`,`i`,`em`,`u`,`s`,`code`,`sub`,`sup`,`small`,`mark`,`pre`,`ul`,`ol`,`li`]),rt=new Set([...T,`style`,`link`,`meta`,`title`,`img`,`picture`,`source`,`video`,`audio`,`track`,`svg`,`math`,`form`,`input`,`button`,`textarea`,`select`,`option`,`canvas`]),it=new Set([`class`,`dir`,`xmlns`,`style`]),at=new Set([`src`,`srcdoc`,`action`,`formaction`,`xml:base`,`background`]);function F(e){let t=e.indexOf(`url(`);for(;t!==-1;){let n=t+4;for(;n<e.length&&/\s/.test(e[n]);)n++;for((e[n]===`"`||e[n]===`'`)&&n++;n<e.length&&/\s/.test(e[n]);)n++;if(e[n]!==`#`)return!0;t=e.indexOf(`url(`,t+4)}return!1}function ot(e){if(e.includes(`\\`))return null;let t=e.toLowerCase();return/@import|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|image-set\s*\(|image\s*\(|cross-fade\s*\(|\bsrc\s*\(|<\//.test(t)||F(t)?null:e}function st(e){return e===`href`||e.endsWith(`:href`)}function ct(e){for(let t of Array.from(e.attributes)){let n=t.name.toLowerCase(),r=t.value,i=!0;if(n.startsWith(`on`)||at.has(n))i=!1;else if(st(n))i=r.trim().startsWith(`#`);else if(n===`style`){let n=ot(r);n===null?i=!1:n!==r&&e.setAttribute(t.name,n)}else (A(r)||r.toLowerCase().includes(`url(`)&&F(r.toLowerCase()))&&(i=!1);i||e.removeAttribute(t.name)}}function I(e){for(let t of Array.from(e.attributes)){let n=t.name.toLowerCase();if(!it.has(n)){e.removeAttribute(t.name);continue}if(n===`style`){let n=ot(t.value);n===null?e.removeAttribute(t.name):n!==t.value&&e.setAttribute(t.name,n)}}}function lt(e){let t=e.parentNode;if(t){for(;e.firstChild;)t.insertBefore(e.firstChild,e);e.remove()}}function L(e){let t=[{el:e,inHtml:!1}];for(;t.length;){let{el:n,inHtml:r}=t.pop(),i=n.localName.toLowerCase();if(n!==e)if(r){if(rt.has(i)){n.remove();continue}if(!nt.has(i)){let e=Array.from(n.children);lt(n);for(let n of e)t.push({el:n,inHtml:r});continue}I(n)}else{if(i===`a`){let e=Array.from(n.children);lt(n);for(let n of e)t.push({el:n,inHtml:r});continue}if(!tt.has(i)){n.remove();continue}if(i===`style`){let e=ot(n.textContent??``);if(e===null){n.remove();continue}n.textContent=e;for(let e of Array.from(n.attributes))n.removeAttribute(e.name);continue}ct(n)}else ct(n);let a=r||i===`foreignobject`;for(let e of Array.from(n.children))t.push({el:e,inHtml:a})}}function ut(e){if(typeof DOMParser>`u`)return null;let t=new DOMParser().parseFromString(`<!doctype html><html><body>${e}</body></html>`,`text/html`).body.firstElementChild;return!t||t.localName.toLowerCase()!==`svg`?null:(L(t),t)}function dt(e){let t=[];for(let n of Array.from(e.querySelectorAll($e))){let e=n,r=n.parentElement;n.localName===`code`&&r?.localName===`pre`&&r.children.length===1&&(r.textContent??``).trim()===(n.textContent??``).trim()&&(e=r),!t.some(t=>t===e||t.contains(e))&&t.push(e)}return t}var R={failed:`Diagram couldn't be rendered; showing its source.`,tooLarge:`Diagram couldn't be rendered: its source is too large; showing it as text.`,tooMany:`Diagram couldn't be rendered: this page has more diagrams than the companion renders; showing its source.`,timedOut:`Diagram took too long to render; showing its source. Reopen the page to retry.`,unavailable:`Diagrams render in the browser companion; showing source here.`,exhausted:`Diagrams couldn't load in this tab; reload to retry.`};function ft(e,t,n){let r=e.createElement(`div`);r.setAttribute(`data-dp-mermaid-note`,``),r.setAttribute(`role`,`note`),r.setAttribute(`style`,`font:12px/1.4 system-ui,sans-serif;color:#92400e;margin:2px 0 8px`),r.textContent=n,t.after(r)}function pt(e){return e===`dark`?`margin:8px 0;padding:8px;border-radius:6px;background:#1f2020;overflow-x:auto`:`margin:8px 0;padding:8px 0;overflow-x:auto`}var z=class extends Error{};function mt(e,t,n,r,i,a){let o=new AbortController;return new Promise((s,c)=>{let l,u=()=>{c(new z),o.abort()},d=setTimeout(u,a),f=()=>{l===void 0&&(l=setTimeout(u,i))},p=()=>{clearTimeout(d),l!==void 0&&clearTimeout(l)};e.reportsStart||f(),Promise.resolve().then(()=>e(t,n,r,o.signal,f)).then(e=>{p(),s(e)},e=>{p(),c(e)})})}function ht(e){return`dp-page-mermaid-${e}`}async function gt(e,t){let n={html:e,rendered:0,fallback:0,timedOut:0};if(!et(e)||typeof DOMParser>`u`)return n;let r=new DOMParser().parseFromString(e,`text/html`),i=dt(r);if(i.length===0)return n;let a=t.renderer??Qe().render,o=t.maxDiagrams??20,s=t.maxSourceChars??2e4,c=t.maxSvgChars??1048576,l=t.timeoutMs??5e3,u=Date.now()+(t.totalTimeoutMs??15e3),d=0,f=0,p=0,m=0;for(let e=0;e<i.length;e++){let n=i[e],h=(n.textContent??``).trim();if(!h)continue;if(e>=o){ft(r,n,R.tooMany),f++;continue}if(h.length>s){ft(r,n,R.tooLarge),f++;continue}let g=u-Date.now();if(g<=0){ft(r,n,R.timedOut),f++,p++;continue}let _;try{_=await mt(a,ht(e),h,t.theme,l,g)}catch(e){let t=e instanceof z||e instanceof We,i=e instanceof Ge,a=i||e instanceof j;ft(r,n,t?R.timedOut:i?R.exhausted:a?R.unavailable:R.failed),f++,t&&p++,a&&m++;continue}let v=typeof _==`string`&&_.length<=c?ut(_):null;if(!v){ft(r,n,typeof _==`string`&&_.length>c?R.tooLarge:R.failed),f++;continue}let y=r.createElement(`div`);y.setAttribute(`class`,`dp-mermaid-render`),y.setAttribute(`data-dp-mermaid`,`rendered`),y.setAttribute(`style`,pt(t.theme)),n.id&&(y.id=n.id),y.appendChild(r.importNode(v,!0)),n.replaceWith(y),d++}return d===0&&f===0?n:{html:r.documentElement.outerHTML,rendered:d,fallback:f,timedOut:p,...m?{unavailable:m}:{}}}var B=Promise.resolve();function V(e){let t=B.then(e,e);return B=t.catch(()=>void 0),t}var _t=8,H=new Map;function vt(e){let t=2166136261,n=5381;for(let r=0;r<e.length;r++){let i=e.charCodeAt(r);t=Math.imul(t^i,16777619),n=Math.imul(n,33)+i|0}return`${e.length}:${(t>>>0).toString(36)}:${(n>>>0).toString(36)}`}function yt(e,t,n){let r=`${t}|${vt(e)}`,i=H.get(r);if(i&&i.input===e&&i.theme===t)return H.delete(r),H.set(r,i),i.out;let a={input:e,theme:t,out:Promise.resolve(e)};for(a.out=V(()=>gt(e,{theme:t,renderer:n})).then(e=>((e.timedOut>0||(e.unavailable??0)>0)&&H.get(r)===a&&H.delete(r),e.html),()=>(H.get(r)===a&&H.delete(r),e)),H.set(r,a);H.size>_t;)H.delete(H.keys().next().value);return a.out}var bt={needed:P,run:(e,t)=>yt(e,t)},xt=2e4,U=50,St=32,W=80,Ct=new Set([`h1`,`h2`,`h3`,`h4`,`h5`,`h6`,`p`,`li`,`tr`,`figure`,`pre`,`blockquote`,`dt`,`dd`,`summary`,`caption`,`button`,`label`,`legend`]),wt=new Set([`h1`,`h2`,`h3`,`h4`,`h5`,`h6`]),Tt=new Set([`div`,`section`,`article`,`aside`,`header`,`footer`,`main`,`nav`,`details`]),Et=new Set(`a.abbr.b.bdi.bdo.cite.code.data.del.dfn.em.font.i.ins.kbd.mark.q.s.samp.small.span.strong.sub.sup.time.u.var.wbr.img.svg`.split(`.`));function G(e){return e.replace(/\s+/g,` `).trim()}function Dt(e){return e===` `||e===`
`||e===`	`||e===`\r`||e===`\f`}function K(e){return!!e&&!!e.closest(`script,style,noscript,template,iframe,frame,frameset,object,embed,applet,portal,dp-annotator-layer`)}var Ot=e=>e===`td`||e===`th`;function kt(e){for(let t=e.previousElementSibling;t;t=t.previousElementSibling)if(Ot(t.localName.toLowerCase()))return!0;return!1}var At={submit:`Submit`,reset:`Reset`,button:``},jt=new Set([``,`text`,`search`,`email`,`url`,`tel`,`number`]);function Mt(e){let t=(e.getAttribute(`type`)??``).trim().toLowerCase();return Object.prototype.hasOwnProperty.call(At,t)?e.getAttribute(`value`)??At[t]:jt.has(t)?e.getAttribute(`value`)??``:``}var q=class{text=``;lastSpace=!0;space(){this.lastSpace||=(this.text+=` `,!0)}cell(){this.space(),this.text+=`| `,this.lastSpace=!0}chars(e,t=1/0){for(let n=0;n<e.length;n++){let r=e.charAt(n);if(Dt(r)?this.space():(this.text+=r,this.lastSpace=!1),this.text.length>t)return!0}return!1}element(e,t=1/0){let n=e.localName.toLowerCase();if(n===`br`)this.space();else if(Ot(n))kt(e)&&this.cell();else if(n===`input`)return this.chars(Mt(e),t);return!1}};function Nt(e){let t=G(e.getAttribute(`alt`)||e.getAttribute(`aria-label`)||e.getAttribute(`title`)||e.getAttribute(`value`)||``);if(!t){let n=e.getElementsByTagName(`img`);for(let e=0;e<n.length&&!t;e++)K(n[e])||(t=G(n[e].getAttribute(`alt`)||``))}return t}function Pt(e,t=280){let n=e.ownerDocument.createTreeWalker(e,5),r=new q,i;for(;i=n.nextNode();){if(i.nodeType===1){if(K(i))continue;if(r.element(i,t))break;continue}if(!K(i.parentElement)&&r.chars(i.nodeValue??``,t))break}let a=G(r.text);return a||=Nt(e),a.length>t?a.slice(0,t):a}function Ft(e){if(typeof DOMParser>`u`)return null;try{return new DOMParser().parseFromString(e,`text/html`)}catch{return null}}var It=3;function Lt(e,t=xt){let n=e.body??e.documentElement;if(!n)return{blocks:[],truncated:!1};let r=Array.from(n.getElementsByTagName(`*`)),i=new Map,a=new Map,o=new Set;for(let e=r.length-1;e>=0;e--){let t=r[e],n=t.localName.toLowerCase();if(K(t))continue;let s=i.get(t)??0,c=Ct.has(n)||Tt.has(n)&&s===0;c&&o.add(t);let l=s+(c?1:0),u=(a.get(t)??0)+(wt.has(n)?1:0);t.parentElement&&(l&&i.set(t.parentElement,(i.get(t.parentElement)??0)+l),u&&a.set(t.parentElement,(a.get(t.parentElement)??0)+u))}let s=[],c=new Map,l=e=>{for(let t=e;t;t=t.parentElement)if(o.has(t))return t;return null},u=e=>{let t=e;for(;t&&t!==n&&Et.has(t.localName.toLowerCase());)t=t.parentElement;return t??n},d=null,f=0,p=e.createTreeWalker(n,5),m,h=e=>{let t=u(e);return(!d||d.el!==t)&&(d={el:t,buf:new q,pos:f,synthetic:!0},s.push(d)),d};for(;m=p.nextNode();){if(f++,m.nodeType===1){let e=m;if(K(e))continue;let t=e.localName.toLowerCase();if(o.has(e)){let t={el:e,buf:new q,pos:f,synthetic:!1};s.push(t),c.set(e,t)}if(!Et.has(t)&&t!==`br`&&t!==`input`&&(d=null),t===`br`||Ot(t)||t===`input`){let n=l(e.parentElement);n?c.get(n).buf.element(e):(t===`input`?Mt(e).trim():d)&&h(e.parentElement).buf.element(e)}continue}let e=m.parentElement;if(K(e))continue;let t=m.nodeValue??``,n=l(e);if(n){c.get(n).buf.chars(t);continue}!t.trim()&&!d||h(e).buf.chars(t)}s.sort((e,t)=>e.pos-t.pos);let g=[],_=``,v=-1,y=!1,b=[],x=``;for(let e of s){let n=e.el,r=G(e.buf.text);if(!r&&!e.synthetic){let e=n.getElementsByTagName(`img`);for(let t=0;t<e.length&&!r;t++)K(e[t])||(r=G(e[t].getAttribute(`alt`)||``))}if(!r)continue;if(g.length>=t){y=!0;break}let o=n.localName.toLowerCase(),s=!e.synthetic&&wt.has(o);if(s){_=r.length>W?`${r.slice(0,W-1)}…`:r,v=g.length;let e=Number(o.slice(1));for(;b.length&&b[b.length-1].level>=e;)b.pop();b.push({level:e,text:_}),x=b.map(e=>e.text).join(` › `)}let c={tag:o,text:r,section:_,sectionId:v,sectionPath:x,heading:s,el:n};e.synthetic&&(c.synthetic=!0,(o===`body`||o===`html`||o===`main`||(i.get(n)??0)>It||(a.get(n)??0)>1)&&(c.unlocatable=!0)),g.push(c)}return{blocks:g,truncated:y}}function J(e){let t=e.body??e.documentElement;if(!t)return``;let n=e.createTreeWalker(t,5),r=new q,i;for(;i=n.nextNode();){if(i.nodeType===1){let e=i;if(K(e))continue;let t=e.localName.toLowerCase();(Ct.has(t)||Tt.has(t))&&r.space(),r.element(e);continue}K(i.parentElement)||r.chars(i.nodeValue??``)}return G(r.text)}function Rt(e){let t=[],n=Array(e.length).fill(-1);for(let r=0;r<e.length;r++){let i=0,a=t.length;for(;i<a;){let n=i+a>>1;e[t[n]]<e[r]?i=n+1:a=n}i>0&&(n[r]=t[i-1]),t[i]=r}let r=[],i=t.length?t[t.length-1]:-1;for(;i!==-1;)r.push(i),i=n[i];return r.reverse()}function zt(e,t,n,r,i,a,o){let s=n-t,c=a-i,l=c+1,u=new Uint32Array((s+1)*l);for(let n=s-1;n>=0;n--)for(let a=c-1;a>=0;a--)u[n*l+a]=e[t+n]===r[i+a]?u[(n+1)*l+a+1]+1:Math.max(u[(n+1)*l+a],u[n*l+a+1]);let d=0,f=0;for(;d<s&&f<c;)e[t+d]===r[i+f]?(o.push([t+d,i+f]),d++,f++):u[(d+1)*l+f]>=u[d*l+f+1]?d++:f++}function Bt(e,t,n,r,i,a,o){let s=new Map;for(let r=t;r<n;r++){let t=s.get(e[r]);t?t.idx.push(r):s.set(e[r],{idx:[r],p:0})}let c=t-1;for(let e=i;e<a;e++){let t=s.get(r[e]);if(t){for(;t.p<t.idx.length&&t.idx[t.p]<=c;)t.p++;t.p<t.idx.length&&(c=t.idx[t.p],t.p++,o.push([c,e]))}}}function Vt(e,t,n,r,i,a,o,s){for(;t<n&&i<a&&e[t]===r[i];)s.push([t++,i++]);let c=[];for(;t<n&&i<a&&e[n-1]===r[a-1];)c.push([--n,--a]);if(t<n&&i<a)if((n-t)*(a-i)<=12e4)zt(e,t,n,r,i,a,s);else{let c=new Map;for(let r=t;r<n;r++){let t=c.get(e[r]);t?t.ca++:c.set(e[r],{ca:1,cb:0,ia:r})}let l=[],u=[];for(let e=i;e<a;e++){let t=c.get(r[e]);t&&t.cb++}for(let e=i;e<a;e++){let t=c.get(r[e]);t&&t.ca===1&&t.cb===1&&(l.push(e),u.push(t.ia))}if(u.length===0||o>=St)Bt(e,t,n,r,i,a,s);else{let c=t,d=i;for(let t of Rt(u)){let n=u[t],i=l[t];Vt(e,c,n,r,d,i,o+1,s),s.push([n,i]),c=n+1,d=i+1}Vt(e,c,n,r,d,a,o+1,s)}}for(let e=c.length-1;e>=0;e--)s.push(c[e])}function Ht(e,t){let n=[];return Vt(e,0,e.length,t,0,t.length,0,n),n}var Ut=e=>`${e.tag}\u0001${e.text}`;function Wt(e,t){let n=e.map(Ut),r=t.map(Ut),i=Ht(n,r),a=new Uint8Array(n.length),o=new Uint8Array(r.length);for(let[e,t]of i)a[e]=1,o[t]=1;let s=[...i],c=new Map;for(let e=0;e<n.length;e++){if(a[e])continue;let t=c.get(n[e]);t?t.push(e):c.set(n[e],[e])}let l=new Set;for(let e=0;e<r.length;e++){if(o[e])continue;let t=c.get(r[e]);if(!t||!t.length)continue;let n=t.shift();a[n]=1,o[e]=1,s.push([n,e]),l.add(e)}let u=new Map,d=[],f=new Map,p=new Map,m=new Map;for(let t of e)!t.heading&&t.sectionId>=0&&m.set(t.sectionId,(m.get(t.sectionId)??0)+1);let h=new Map;for(let e of t)!e.heading&&e.sectionId>=0&&h.set(e.sectionId,(h.get(e.sectionId)??0)+1);for(let[n,r]of s){let i=e[n],a=t[r];if(i.heading||a.heading||i.sectionId<0||a.sectionId<0)continue;let o=`${i.sectionId}:${a.sectionId}`;p.set(o,(p.get(o)??0)+1)}let g=(n,r)=>{u.set(r,{kind:`changed`,block:t[r],previous:e[n],levelChanged:!0}),f.set(n,r)},_=[[-1,-1],...i,[n.length,r.length]];for(let n=0;n+1<_.length;n++){let[r,i]=_[n],[s,c]=_[n+1],l=[],m=[];for(let e=r+1;e<s;e++)a[e]||l.push(e);for(let e=i+1;e<c;e++)o[e]||m.push(e);if(!l.length&&!m.length)continue;let h=new Set,v=(n,r)=>{h.add(n),u.set(r,{kind:`changed`,block:t[r],previous:e[n]}),e[n].heading&&t[r].heading&&f.set(n,r)},y=new Map,b=new Map;for(let t of l)if(e[t].heading){let n=y.get(e[t].text);n?n.push(t):y.set(e[t].text,[t])}for(let e of m)if(t[e].heading){let n=b.get(t[e].text);n?n.push(e):b.set(t[e].text,[e])}for(let[e,t]of b){let n=y.get(e);if(!n)continue;if(n.length===1&&t.length===1){h.add(n[0]),g(n[0],t[0]);continue}let r=[];for(let e of n)for(let n of t)p.get(`${e}:${n}`)&&r.push([e,n]);r.length===1&&(h.add(r[0][0]),g(r[0][0],r[0][1]))}let x=new Map;for(let t of l){let n=e[t],r=`${n.tag}\u0001${n.heading?``:n.section}`,i=x.get(r);i?i.push(t):x.set(r,[t])}let S=[];for(let e of m){if(u.has(e))continue;let n=t[e],r=x.get(`${n.tag}\u0001${n.heading?``:n.section}`),i;for(;r&&r.length&&i===void 0;){let e=r.shift();h.has(e)||(i=e)}i===void 0?S.push(e):v(i,e)}let C=l.filter(e=>!h.has(e)),ee=Math.min(C.length,S.length);for(let n=0;n<ee;n++){let r=C[n],i=S[n];e[r].tag===t[i].tag&&v(r,i)}for(let e of S)u.has(e)||u.set(e,{kind:`added`,block:t[e]});for(let t of l)h.has(t)||d.push(e[t])}let v=0,y=d.filter(e=>e.heading).map(e=>e.sectionId);if(y.length){let n=[...u.entries()].filter(([,e])=>e.kind===`added`&&e.block.heading).map(([e])=>e),r=[];for(let i of y)for(let a of n){if(e[i].text!==t[a].text)continue;let n=p.get(`${i}:${a}`)??0;n>=1&&n*2>(m.get(i)??0)&&n*2>=(h.get(a)??0)&&r.push([i,a])}let i=new Set;for(let[e,t]of r)r.filter(([n,r])=>n===e||r===t).length===1&&(i.add(e),g(e,t),v++);if(i.size){let e=d.filter(e=>!(e.heading&&i.has(e.sectionId)));d.length=0,d.push(...e)}}for(let[n,r]of s)e[n].heading&&t[r].heading&&f.set(n,r);let b=(e,t)=>e.sectionId<0||t.sectionId<0?e.sectionId<0&&t.sectionId<0:f.get(e.sectionId)===t.sectionId,x=v;for(let[n,r]of s){let i=e[n],a=t[r];if(a.heading){l.has(r)&&x++;continue}b(i,a)?l.has(r)&&x++:u.set(r,{kind:`moved`,block:a,previous:i})}return{changes:[...u.entries()].sort((e,t)=>e[0]-t[0]).map(([,e])=>e),removed:d,moved:x}}function Gt(e,t){let n=new Map,r=[];for(let{el:i,kind:a}of t){let t=i.localName.toLowerCase(),o=n.get(t);if(!o){o=new Map;let r=new Map,i=e.getElementsByTagName(t);for(let e=0;e<i.length;e++){let t=i[e];if(K(t))continue;let n=Pt(t),a=r.get(n)??0;r.set(n,a+1),o.set(t,{text:n,occurrence:a})}n.set(t,o)}let s=o.get(i);!s||!s.text||r.push({kind:a,tag:t,text:s.text,occurrence:s.occurrence})}return r}var Kt=[];function qt(e,t){return Kt.find(n=>n.oldHtml===e&&n.newHtml===t)?.diff}function Jt(e,t){let n=Kt.find(n=>n.oldHtml===e&&n.newHtml===t);if(n)return n.diff;let r=Yt(e,t);return Kt.unshift({oldHtml:e,newHtml:t,diff:r}),Kt.length>4&&Kt.pop(),r}function Yt(e,t){let n=Ft(e),r=Ft(t);if(!n||!r)return null;let i=e===t,a=Lt(n),o=Lt(r),s=i?{changes:[],removed:[],moved:0}:Wt(a.blocks,o.blocks),c=s.changes.length===0&&s.removed.length===0&&s.moved===0,l=!i&&c&&J(n)!==J(r),u=[],d=new Set,f=0;for(let e of s.changes){let t=e.block.el;if(!t||e.block.unlocatable){f++;continue}d.has(t)||(d.add(t),u.push({el:t,kind:e.kind}))}let p=[];for(let e of Array.from(r.querySelectorAll(`[data-dp-changed]`)).slice(0,U))d.has(e)||K(e)||(d.add(e),p.push({el:e,kind:`hinted`}));let m=[...u,...p].slice(0,300);return{...s,truncated:a.truncated||o.truncated,identical:i,textChangedOutsideBlocks:l,marks:Gt(r,m),changeMarksTotal:u.length,hintMarksTotal:p.length,unhighlightable:f}}var Xt={p:[`paragraph`,`paragraphs`],li:[`list item`,`list items`],tr:[`table row`,`table rows`],pre:[`code block`,`code blocks`],blockquote:[`quote`,`quotes`],figure:[`figure`,`figures`],dt:[`term`,`terms`],dd:[`definition`,`definitions`]};function Zt(e,t){let[n,r]=Xt[e.size===1?[...e][0]:``]??[`block`,`blocks`];return t===1?n:r}var Qt=``;function $t(e){let t=[],n=[],r=[],i={},a={};for(let t of e.changes){let e=a[t.block.section]??=[];e.includes(t.block.sectionId)||e.push(t.block.sectionId)}for(let t of e.changes)t.levelChanged&&t.previous&&a[t.block.section].length===1&&(i[t.block.section]=`${t.previous.tag}\u2192${t.block.tag}`);for(let n of e.changes)n.kind===`added`&&n.block.heading&&!t.includes(n.block.section)&&t.push(n.block.section);for(let i of e.changes){if(i.kind===`moved`&&i.previous){let e=i.previous.section===i.block.section;r.push({text:i.block.text,from:e&&i.previous.sectionPath||i.previous.section,to:e&&i.block.sectionPath||i.block.section})}let e=i.block.section;t.includes(e)||n.includes(e)||n.push(e)}let o=new Set(e.removed.filter(e=>e.heading).map(e=>e.sectionId)),s=new Map;for(let t of e.removed)t.heading&&s.set(t.sectionId,{section:t.section,sectionId:t.sectionId,texts:[],noun:``,tags:new Set});let c=new Map;for(let t of e.removed){if(t.heading)continue;if(o.has(t.sectionId)){let e=s.get(t.sectionId);e.texts.push(t.text),e.tags.add(t.tag);continue}let e=c.get(t.sectionId);e||c.set(t.sectionId,e={section:t.section,tags:new Set,texts:[]}),e.tags.add(t.tag),e.texts.push(t.text)}let l=[...s.values()].map(({tags:e,...t})=>({...t,noun:Zt(e,t.texts.length)})),u=[...c.entries()].map(([e,t])=>({section:t.section,sectionId:e,count:t.texts.length,noun:Zt(t.tags,t.texts.length),texts:t.texts}));return{state:e.changes.length>0||e.removed.length>0||e.moved>0?`changes`:e.identical?`identical`:e.textChangedOutsideBlocks?`outside-blocks`:`markup-only`,changedSections:n,...Object.keys(i).length?{headingLevels:i}:{},addedSections:t,removedSections:l,removed:u,movedAcross:r,movedCount:e.moved,changeCount:e.changes.length}}function Y(e){return e===Qt?`Top of page`:e}function en(e,t=6,n=Y){let r=e.slice(0,t).map(n);return e.length>t?`${r.join(`, `)} and ${e.length-t} more`:r.join(`, `)}function tn(e,t=60){return e.length>t?`${e.slice(0,t-1)}…`:e}var nn={identical:`Page content unchanged.`,"markup-only":`No change found in the compared text (attributes, styling and live form state aren't compared).`,"outside-blocks":`Text changed outside recognised blocks.`};function rn(e){if(e.state!==`changes`)return nn[e.state];let t=[];if(e.changedSections.length){let n=e.headingLevels??{};t.push(`Changed: ${en(e.changedSections,6,e=>Object.hasOwn(n,e)?`${Y(e)} (${n[e]})`:Y(e))}`)}if(e.addedSections.length&&t.push(`Added: ${en(e.addedSections)}`),e.movedAcross.length){let n=e.movedAcross.slice(0,3).map(e=>`“${tn(e.text)}” from ${Y(e.from)} to ${Y(e.to)}`);e.movedAcross.length>3&&n.push(`${e.movedAcross.length-3} more`),t.push(`Moved: ${n.join(`, `)}`)}let n=[];for(let t of e.removedSections.slice(0,4))n.push(`section ${Y(t.section)}${t.texts.length?` (${t.texts.length} ${t.noun})`:``}`);e.removedSections.length>4&&n.push(`${e.removedSections.length-4} more sections`);for(let t of e.removed.slice(0,4))n.push(`${t.count} ${t.noun} ${t.section===Qt?`at the top of the page`:`under ${t.section}`}`);return e.removed.length>4&&n.push(`more in ${e.removed.length-4} other sections`),n.length&&t.push(`Removed: ${n.join(`, `)}`),e.movedCount&&t.push(`${e.movedCount} ${e.movedCount===1?`block`:`blocks`} moved`),t.join(`; `)}function X(e,t){if(!t||e.source!==t)return null;let n=e.data;return!n||typeof n!=`object`||Array.isArray(n)?null:n}function an(e,t){let n=X(e,t);if(!n||n.dp!==`anchor`)return null;let r=ue.safeParse(n.anchor);return r.success?r.data:null}var on=500,sn=g().regex(/^[0-9a-z:]{1,64}$/);function cn(e,t){let n=X(e,t);if(!n||n.dp!==`pins-status`)return null;let r=n.found;if(!Array.isArray(r)||r.length>on||!r.every(e=>typeof e==`boolean`))return null;let i=sn.safeParse(n.key);return i.success?{found:r,key:i.data}:{found:r}}function ln(e,t){let n=X(e,t);return!!n&&n.dp===`ready`}var un=g().regex(/^[0-9a-f]{16,64}$/);function dn(e,t){let n=X(e,t);return!!n&&n.dp===`toggle-pointing`}var fn=m({kind:h([`added`,`changed`,`moved`,`hinted`]),tag:g().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/),text:g().min(1).max(280),occurrence:f().int().min(0).max(1e6)}).strict(),pn=m({dp:l(`changes`),marks:d(fn).max(300),show:p()}).strict();function mn(e,t){let n=[];for(let t of e.slice(0,300)){let e=fn.safeParse(t);e.success&&n.push(e.data)}return pn.parse({dp:`changes`,marks:n,show:t})}function hn(e,t){let n=X(e,t);if(!n||n.dp!==`changes-status`)return null;let r=n.found;return!Array.isArray(r)||r.length>300||!r.every(e=>typeof e==`boolean`)?null:r}var gn=g().min(1).max(de.locator),_n=f().int().min(-1).max(199),vn=m({level:u([l(1),l(2),l(3)]),text:g().min(1).max(120),locator:gn}).strict(),yn=m({dp:l(`outline`),headings:d(vn).max(200),pins:d(_n).max(500),changes:d(_n).max(300)}).strict().superRefine((e,t)=>{for(let[n,r]of[[`pins`,e.pins],[`changes`,e.changes]])r.some(t=>t>=e.headings.length)&&t.addIssue({code:`custom`,path:[n],message:`section index out of range`})});function bn(e,t){let n=X(e,t);if(!n||n.dp!==`outline`)return null;let r=yn.safeParse(n);return r.success?r.data:null}function xn(e,t){let n=X(e,t);if(!n||n.dp!==`outline-active`)return null;let r=_n.safeParse(n.index);return r.success?r.data:null}var Sn=m({kind:h([`decision`,`question`]),text:g().max(E.text),locator:gn,id:g().min(1).max(E.id).optional()}).strict(),Cn=m({dp:l(`asks`),asks:d(Sn).max(E.max),pinAsks:d(f().int().min(-1).max(E.max-1)).max(500),key:sn.optional()}).strict().superRefine((e,t)=>{e.pinAsks.some(t=>t>=e.asks.length)&&t.addIssue({code:`custom`,path:[`pinAsks`],message:`ask index out of range`})});function wn(e,t){let n=X(e,t);if(!n||n.dp!==`asks`)return null;let r=Cn.safeParse(n);return r.success?r.data:null}function Tn(e){let t=ue.safeParse({kind:`element`,locator:e.locator,quote:e.text});return t.success?t.data:null}var En=h([`open`,`addressed`]),Z=g().min(1).max(128);function Dn(e,t,n,r){let i=Math.min(e.length,on),a=[],o=[];for(let e=0;e<i;e++){a.push(En.safeParse(t[e]).success?t[e]:`open`);let r=n[e];o.push(typeof r==`string`&&Z.safeParse(r).success?r:``)}let s=r!==void 0&&sn.safeParse(r).success?{key:r}:{};return{dp:`pins`,anchors:e.slice(0,i),states:a,ids:o,...s}}function On(e,t){let n=X(e,t);if(!n||n.dp!==`pin-click`)return null;let r=Z.safeParse(n.id);return r.success?r.data:null}var kn=m({x:f().finite().min(-1e4).max(1e5),y:f().finite().min(-1e4).max(1e5)}).strict();function An(e,t){let n=X(e,t);if(!n||n.dp!==`pin-hover`)return;if(n.id===null)return{id:null};let r=Z.safeParse(n.id),i=kn.safeParse({x:n.x,y:n.y});return r.success&&i.success?{id:r.data,at:i.data}:void 0}var jn={samples:3,text:120,keys:8,max:9999},Mn=f().int().min(0).max(jn.max),Nn=g().min(1).max(jn.text),Pn=g().min(1).max(64).transform(e=>te(e)),Fn=m({count:Mn,samples:d(Nn).max(jn.samples),classes:d(m({key:Pn,count:Mn.min(1)}).strict()).max(jn.keys)}).strict(),In=g().min(1).max(64).transform(e=>S(e)),Ln=g().min(1).max(64).transform(e=>ee(e)),Rn=m({dp:l(`diagnostics`),doc:un,scriptErrors:Fn,rejections:Fn,resources:d(m({key:In,count:Mn.min(1)}).strict()).max(jn.keys),blocked:d(m({key:Ln,count:Mn.min(1)}).strict()).max(jn.keys)}).strict();function zn(e,t){let n=X(e,t);if(!n||n.dp!==`diagnostics`)return null;let r=Rn.safeParse(n);if(!r.success)return null;let{dp:i,doc:a,...o}=r.data;return{doc:a,diagnostics:Bn(o)}}function Bn(e){return{scriptErrors:{...e.scriptErrors,classes:Vn(e.scriptErrors.classes,`script`)},rejections:{...e.rejections,classes:Vn(e.rejections.classes,`rejection`)},resources:Vn(e.resources,`resource`),blocked:Vn(e.blocked,`blocked`)}}function Vn(e,t){let n=[];for(let t of e){let e=n.find(e=>e.key===t.key);e?e.count=Math.min(e.count+t.count,jn.max):n.push({key:t.key,count:t.count})}return n.sort((e,n)=>w(t,e.key)-w(t,n.key))}var Hn={blocks:2e3,text:120,pins:20},Un=m({dp:l(`kbd-cursor`),index:f().int().min(-1).max(Hn.blocks-1),total:f().int().min(0).max(Hn.blocks),kind:h([`decision`,`question`,`diagram node`,`heading`,`paragraph`,`list item`,`quote`,`code`,`image`,`caption`,`cell`,`link`,`control`,`block`]),text:g().max(Hn.text),pins:d(f().int().min(0).max(on-1)).max(Hn.pins)}).strict().refine(e=>e.index<e.total,{message:`index out of range`});function Wn(e,t){let n=X(e,t);if(!n||n.dp!==`kbd-cursor`)return null;let r=Un.safeParse(n);if(!r.success)return null;let{dp:i,...a}=r.data;return a}function Gn(e,t){let n=X(e,t);return!!n&&n.dp===`kbd-off`&&Object.keys(n).length===1}var Kn=m({dp:l(`key`),key:h([`toggle-kbd`,`help`,`next`,`prev`,`escape`])}).strict();function qn(e,t){let n=X(e,t);if(!n||n.dp!==`key`)return null;let r=Kn.safeParse(n);return r.success?r.data.key:null}function Jn(e){return{dp:`mode`,annotate:e.annotate,scripts:e.scripts,kbd:e.kbd&&e.annotate,dark:e.dark}}var Q=n(),Yn=(e,t,n)=>`${e} ${e===1?t:n}`;function Xn(e,t){return e.map((n,r)=>{let i=t[r]??0,a=i;for(let i=r+1;i<e.length&&e[i].level>n.level;i++)a+=t[i]??0;return{total:a,own:i}})}function Zn(e,t,n){if(e.total===0)return``;let r=e.total-e.own;return r>0?`${Yn(e.total,t,n)} (${e.own} in this section, ${r} in subsections)`:Yn(e.total,t,n)}function Qn({headings:e,commentCounts:t,changeCounts:n,active:r,onJump:i,variant:a}){let o=Math.min(...e.map(e=>e.level)),s=Xn(e,t),c=Xn(e,n);return(0,Q.jsx)(`ol`,{className:`space-y-0.5`,"data-testid":`page-outline-list-${a}`,children:e.map((e,t)=>{let n=s[t].total,a=c[t].total,l=t===r,u=[e.text,Zn(s[t],`open comment`,`open comments`),Zn(c[t],`changed block`,`changed blocks`),l?`you are here`:``].filter(Boolean).join(`, `);return(0,Q.jsx)(`li`,{style:{paddingLeft:`${(e.level-o)*.75}rem`},children:(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>i(t),"aria-current":l?`location`:void 0,"aria-label":`Go to ${u}`,title:e.text,className:`w-full flex items-center gap-1.5 text-left px-1.5 py-0.5 rounded text-2xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${l?`bg-accent-blue-dim/40 text-text-primary font-semibold border-l-2 border-accent-blue`:`text-text-secondary hover:bg-surface-elevated border-l-2 border-transparent`}`,"data-testid":`page-outline-entry`,"data-level":e.level,children:[(0,Q.jsx)(`span`,{className:`flex-1 min-w-0 truncate`,children:e.text}),n>0&&(0,Q.jsx)(`span`,{"aria-hidden":`true`,className:`shrink-0 px-1 rounded-full bg-accent-amber text-[10px] font-semibold text-black`,"data-testid":`page-outline-comments`,children:n}),a>0&&(0,Q.jsxs)(`span`,{"aria-hidden":`true`,className:`shrink-0 px-1 rounded-full border border-accent-violet/60 text-[10px] font-semibold text-accent-violet`,"data-testid":`page-outline-changes`,children:[`~`,a]})]})},t)})})}function $n(e,t,n){let r=e>=0?n[e]:void 0;return r?`Section ${e+1} of ${t}: ${r.text}`:`Top of the page (${Yn(t,`section`,`sections`)})`}function er(e){let{headings:t,active:n,variant:r}=e;if(t.length===0)return null;let i=$n(n,t.length,t);return r===`disclosure`?(0,Q.jsxs)(`details`,{className:`rounded-lg border border-border-default text-2xs`,"data-testid":`page-outline-disclosure`,children:[(0,Q.jsxs)(`summary`,{className:`cursor-pointer px-2 py-1 text-text-secondary`,children:[`Outline `,(0,Q.jsxs)(`span`,{className:`text-text-muted`,children:[`· `,i]})]}),(0,Q.jsx)(`nav`,{"aria-label":`Page outline`,className:`px-1 pb-1.5 max-h-64 overflow-y-auto`,children:(0,Q.jsx)(Qn,{...e})})]}):(0,Q.jsxs)(`nav`,{"aria-label":`Page outline`,className:`sticky top-2 max-h-[70vh] overflow-y-auto rounded-lg border border-border-default p-1.5 space-y-1`,"data-testid":`page-outline-rail`,children:[(0,Q.jsx)(`div`,{className:`px-1.5 text-2xs font-semibold text-text-muted uppercase tracking-wide`,children:`Outline`}),(0,Q.jsx)(`div`,{className:`px-1.5 text-[10px] text-text-muted`,"data-testid":`page-outline-progress`,children:i}),(0,Q.jsx)(Qn,{...e})]})}var tr={decision:`Decide`,question:`Question`};function nr({asks:e,answered:t,checking:n=!1,readOnly:r,onJump:i,onReply:a}){if(e.length===0)return null;let o=t.filter(Boolean).length,s=e.length-o,c=n&&s>0?`${s} checking`:`${s} open`;return(0,Q.jsxs)(`section`,{"aria-label":`Wants from you: ${e.length} ${e.length===1?`ask`:`asks`}, ${c}`,className:`rounded-lg border border-accent-amber/40 bg-accent-amber/5 px-3 py-2 space-y-1.5`,"data-testid":`page-asks`,children:[(0,Q.jsxs)(`h3`,{className:`flex flex-wrap items-baseline gap-2 text-xs font-semibold text-text-primary`,children:[(0,Q.jsxs)(`span`,{children:[`Wants from you (`,e.length,`)`]}),(0,Q.jsxs)(`span`,{className:`text-2xs font-normal text-text-muted`,"data-testid":`page-asks-tally`,children:[c,` · `,o,` answered`]})]}),(0,Q.jsx)(`ul`,{className:`space-y-1 max-h-60 overflow-y-auto`,children:e.map((e,o)=>{let s=t[o]===!0,c=s?`answered`:n?`checking`:`open`,l=e.text.trim()||(e.id?`#${e.id}`:`(no text)`);return(0,Q.jsxs)(`li`,{className:`flex flex-wrap items-start gap-2 text-2xs ${s?`opacity-70`:``}`,"data-testid":`page-ask`,"data-answered":s?`true`:`false`,"data-state":c,children:[(0,Q.jsx)(`span`,{className:`shrink-0 px-1.5 py-0.5 rounded font-semibold ${e.kind===`decision`?`bg-accent-violet/15 text-accent-violet`:`bg-accent-blue-dim/40 text-accent-blue`}`,children:tr[e.kind]}),(0,Q.jsx)(`span`,{className:`flex-1 min-w-0 text-xs text-text-primary break-words line-clamp-2`,children:l}),(0,Q.jsx)(`span`,{className:`shrink-0 ${s?`text-accent-green`:n?`text-text-muted`:`text-accent-amber`}`,"data-testid":`page-ask-state`,children:s?`Answered`:n?`Checking…`:`Open`}),(0,Q.jsxs)(`span`,{className:`shrink-0 inline-flex gap-1`,children:[(0,Q.jsx)(`button`,{type:`button`,onClick:()=>i(o),"aria-label":`Show on the page: ${l}`,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,children:`Jump`}),!r&&(0,Q.jsx)(`button`,{type:`button`,onClick:()=>a(o),"aria-label":`Reply to: ${l}`,className:`px-1.5 py-0.5 rounded border border-accent-blue/40 hover:bg-accent-blue-dim/30 text-accent-blue`,children:`Reply`})]})]},`${o}-${e.locator}`)})})]})}var rr=`[${oe}], [${me}]`,ir=`script,style,noscript,template`,ar=T.join(`,`),or=50,sr=new Set([...ir.split(`,`),`title`,...T]);function cr(e){let t=new fe,n=[],r=e=>{for(let t=e.lastChild;t;t=t.previousSibling)n.push({node:t})};for(r(e);n.length>0;){let e=n.pop();if(e.close){t.separate();continue}let i=e.node;if(i.nodeType===3){t.push(i.nodeValue??``);continue}if(i.nodeType!==1)continue;let a=i.localName.toLowerCase();sr.has(a)||(re(a)&&(t.separate(),n.push({close:!0})),r(i))}return t.digest()}function lr(e){return(e.getAttribute(`alt`)||e.getAttribute(`aria-label`)||e.getAttribute(`title`)||e.getAttribute(`value`)||``).replace(/\s+/g,` `).trim()}function ur(e,t){let n=e.ownerDocument.createTreeWalker(e,4),r=``,i=!0;for(let e=n.nextNode();e&&!(r.length>t);e=n.nextNode()){let n=e.parentElement,a=e.nodeValue??``;if(!(n&&n.closest(ir))){for(let e of a)if(/\s/.test(e)?i||=(r+=` `,!0):(r+=e,i=!1),r.length>t)break}}let a=r.replace(/\s+/g,` `).trim(),o=lr(e);a||=o;let s=cr(e)??(o?v(o):void 0);return{text:a.length>t?a.slice(0,t):a,...s?{fullHash:s}:{}}}function dr(e){let t=Ft(e);if(!t)return null;let n=[];for(let e of Array.from(t.querySelectorAll(rr))){if(n.length>=E.max)break;if(e.closest(ar))continue;let t=e.id;if(!t||t.length>E.id)continue;let r=[];for(let t of Array.from(e.querySelectorAll(`[id]`))){if(r.length>=or)break;t.closest(rr)===e&&t.id&&t.id.length<=E.id&&r.push(t.id)}n.push({id:t,...ur(e,E.text),...r.length?{childIds:r}:{}})}return n}var $=new Map,fr=50;function pr(e){if(!$.has(e))return;let t=$.get(e);return $.delete(e),$.set(e,t),t}function mr(e,t){let n=pr(e);if(n!==void 0)return n;let r=dr(t);return $.set(e,r),$.size>fr&&$.delete($.keys().next().value),r}function hr(e,t){let n=t?e.map(e=>e.id).join(`\0`):``,[r,i]=(0,O.useState)(0),a=n?e.filter(e=>pr(e.id)===void 0).map(e=>e.id).join(`\0`):``;return(0,O.useEffect)(()=>{if(!a)return;let t=e.filter(e=>pr(e.id)===void 0);if(t.length===0)return;let n=!1,r=()=>{if(!n){for(let e of t)mr(e.id,ie(e.content).html);n||i(e=>e+1)}},o=window;if(typeof o.requestIdleCallback==`function`){let e=o.requestIdleCallback(r,{timeout:400});return()=>{n=!0,o.cancelIdleCallback?.(e)}}let s=setTimeout(r,0);return()=>{n=!0,clearTimeout(s)}},[a]),(0,O.useMemo)(()=>{let e=new Set(n?n.split(`\0`):[]);return{get:t=>e.has(t)?pr(t)??void 0:void 0,pending:a!==``}},[n,r,a])}function gr(e){let t=s(e=>e.artifacts);return(0,O.useMemo)(()=>{let n=[];if(e.type!==`page`)return n;let r=new Set([e.id]),i=e.parentId;for(;i&&!r.has(i);){r.add(i);let e=t.find(e=>e.id===i);if(!e||e.type!==`page`)break;n.push({artifact:e,autoSave:!!ae(e.fileWatch).recorded}),i=e.parentId}return n},[t,e.id,e.parentId,e.type])}function _r(e,t){let n=t?.type===`page`?ie(t.content).html:null,r=e.type===`page`?ie(e.content).html:null,i=t&&n!==null&&r!==null?`${t.id}\u0000${e.id}`:null,[a,o]=(0,O.useState)(null),s=i&&n!==null&&r!==null?qt(n,r):void 0;(0,O.useEffect)(()=>{if(!i||n===null||r===null||qt(n,r)!==void 0)return;let e=!1,t=()=>{if(e)return;let t=Jt(n,r);e||o({key:i,diff:t})},a=window;if(typeof a.requestIdleCallback==`function`){let n=a.requestIdleCallback(t,{timeout:400});return()=>{e=!0,a.cancelIdleCallback?.(n)}}let s=setTimeout(t,0);return()=>{e=!0,clearTimeout(s)}},[i,n,r]);let c=s===void 0?a&&a.key===i?a.diff:void 0:s;return{changes:(0,O.useMemo)(()=>t&&c?{base:t,diff:c,summary:$t(c)}:null,[t,c]),pending:!!i&&c===void 0}}var vr=(e,t=160)=>e.length>t?`${e.slice(0,t-1)}…`:e;function yr({summary:e,truncated:t}){return(0,Q.jsxs)(`span`,{className:`text-2xs text-text-secondary`,"data-testid":`page-change-summary-line`,"data-state":e.state,children:[rn(e),t?` (Very large page: only the first part was compared.)`:``]})}function br({summary:e}){return(0,Q.jsxs)(`ul`,{className:`space-y-1`,"data-testid":`page-removed-list`,children:[e.removedSections.map(e=>(0,Q.jsxs)(`li`,{"data-testid":`page-removed-section`,children:[(0,Q.jsxs)(`span`,{className:`text-text-secondary`,children:[`Section `,(0,Q.jsx)(`span`,{className:`font-medium`,children:Y(e.section)}),e.texts.length>0?` (${e.texts.length} ${e.noun})`:``]}),e.texts.length>0&&(0,Q.jsx)(xr,{texts:e.texts})]},`s-${e.sectionId}`)),e.removed.map(e=>(0,Q.jsxs)(`li`,{"data-testid":`page-removed-group`,children:[(0,Q.jsxs)(`span`,{className:`text-text-secondary`,children:[e.count,` `,e.noun,` `,e.section?`under ${e.section}`:`at the top of the page`]}),(0,Q.jsx)(xr,{texts:e.texts})]},`g-${e.sectionId}`))]})}function xr({texts:e}){let t=e.slice(0,8);return(0,Q.jsxs)(`ul`,{className:`pl-3 text-text-muted`,children:[t.map((e,t)=>(0,Q.jsx)(`li`,{className:`line-through opacity-80 break-words`,children:vr(e)},t)),e.length>t.length&&(0,Q.jsxs)(`li`,{children:[`and `,e.length-t.length,` more`]})]})}var Sr=[`open`,`addressed`,`orphaned`],Cr={open:`Open`,addressed:`Addressed`,orphaned:`Orphaned`};function wr(e,t){let n=new Map;for(let e of t){if(!e.parentCommentId)continue;let t=n.get(e.parentCommentId);t?t.push(e):n.set(e.parentCommentId,[e])}let r=[],i=new Set([e.id]),a=[...n.get(e.id)??[]];for(;a.length;){let e=a.shift();i.has(e.id)||(i.add(e.id),r.push(e),a.push(...n.get(e.id)??[]))}return r}var Tr={human:0,resolve:1,answer:2,revision:3};function Er(e){if(!e)return;let t=Date.parse(e);return Number.isFinite(t)?t:void 0}function Dr(e,t,n,r={}){let i=Er(e.createdAt)??0,a=[{t:i,kind:`human`}];for(let e of t){let t=Er(e.createdAt)??i;a.push({t,kind:e.author===`agent`?`answer`:`human`})}e.answeredByCommentId&&!t.some(t=>t.id===e.answeredByCommentId)&&a.push({t:i,kind:`answer`});let o=e.addressedIn;if(o&&Number.isInteger(o.version)&&o.version>0){let e=Er(o.at)??Er(r.revisionAt?.(o.artifactId))??i;a.push({t:e,kind:`revision`,version:o.version})}let s=Er(e.humanResolvedAt);s!==void 0&&a.push({t:s,kind:`resolve`});let c=a[0];for(let e of a)(e.t>c.t||e.t===c.t&&Tr[e.kind]>Tr[c.kind])&&(c=e);return c.kind===`revision`?{kind:`addressed`,via:`revision`,version:c.version}:c.kind===`answer`?{kind:`addressed`,via:`answer`}:c.kind===`resolve`?{kind:`addressed`,via:`resolved`}:n?{kind:`orphaned`}:a.some(e=>e.kind!==`human`)?{kind:`open`,seen:e.acknowledged===!0,reopened:!0}:{kind:`open`,seen:e.acknowledged===!0}}function Or(e){return e.kind}function kr(e){return e.kind===`addressed`?`addressed`:`open`}function Ar(e){switch(e.kind){case`addressed`:return e.via===`revision`?{text:`Addressed in v${e.version}`,title:`The agent revised the page and named this comment as addressed in v${e.version}. Check the change yourself.`}:e.via===`answer`?{text:`Answered by the agent`,title:`The agent replied to this comment.`}:{text:`Resolved by you`,title:`You marked this resolved.`};case`orphaned`:return{text:`Not found in this version`,title:`The spot this comment points at is not on this version of the page, and nothing has addressed it.`};case`open`:return e.reopened?{text:`Reopened`,title:`You replied after the agent's answer, the revision that addressed it, or your own resolve, so it's open again.`}:e.seen?{text:`Seen by agent`,title:`The agent has read this comment (check_feedback) but hasn't answered it or named it addressed in a revision.`}:{text:`Open`,title:`Delivered to the session; the agent hasn't acted on it yet.`}}}function jr(e,t,n,r={}){return e.map((e,i)=>{let a=wr(e,t),o=n(e,i),s=Dr(e,a,o,r),c={comment:e,index:i,replies:a.length,missing:o,state:s};return e.humanResolvedAt&&(c.withoutResolve=Dr({...e,humanResolvedAt:null},a,o,r)),c})}function Mr(e){let t={open:0,addressed:0,orphaned:0};for(let n of e)t[Or(n.state)]++;return t}function Nr(e,t={}){let n=e.comment;if(n.author!==`human`||n.parentCommentId||n.intent===`question`||t.answersAsk)return null;if(e.state.kind===`addressed`&&e.state.via===`resolved`){let t=e.withoutResolve;return t&&t.kind===`addressed`?{kind:`reopen`,label:`Undo resolve`,title:`Withdraw your resolve; it goes back to "${Ar(t).text}". Reply in its thread to reopen it.`}:{kind:`reopen`,label:`Reopen`,title:`Withdraw your resolve; the comment is open again for the agent.`}}return{kind:`resolve`,label:`Resolve`,title:e.state.kind===`addressed`?`Mark it done yourself: you've checked the agent's answer or revision.`:`Mark it done yourself: it no longer needs the agent. The agent sees it as resolved by you.`}}function Pr({anchor:e}){let t=e.quote.trim(),n=typeof e.section?.heading==`string`?e.section.heading.trim():``,r=typeof e.section?.id==`string`?e.section.id:``;return(0,Q.jsxs)(`div`,{className:`space-y-0.5 text-2xs text-text-muted`,"data-testid":`page-anchor-context`,children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-1.5`,children:[(0,Q.jsx)(`span`,{className:`px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary`,children:xe(e.kind)}),t?(0,Q.jsxs)(`span`,{className:`text-text-primary italic break-words`,children:[`“`,t,`”`]}):(0,Q.jsx)(`code`,{className:`font-mono break-all`,children:e.locator})]}),e.table&&(e.table.row||e.table.col)&&(0,Q.jsxs)(`div`,{children:[e.table.row&&(0,Q.jsxs)(Q.Fragment,{children:[`Row `,(0,Q.jsx)(`span`,{className:`text-text-secondary`,children:e.table.row})]}),e.table.row&&e.table.col&&` · `,e.table.col&&(0,Q.jsxs)(Q.Fragment,{children:[`Column `,(0,Q.jsx)(`span`,{className:`text-text-secondary`,children:e.table.col})]})]}),(n||r)&&(0,Q.jsxs)(`div`,{className:`break-words`,"data-testid":`page-anchor-section`,children:[`In `,n&&(0,Q.jsx)(`span`,{className:`text-text-secondary`,children:n}),n&&r&&` `,r&&(0,Q.jsxs)(`code`,{className:`font-mono`,children:[`#`,r]})]}),e.nodeId&&(0,Q.jsxs)(`div`,{children:[`Node `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.nodeId})]}),e.href&&(0,Q.jsxs)(`div`,{className:`break-all`,children:[`Link to `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.href})]}),t&&(0,Q.jsxs)(`div`,{className:`break-all`,children:[`at `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.locator})]})]})}function Fr({n:e,state:t}){let n=t.kind===`addressed`?`bg-text-muted text-black`:t.kind===`orphaned`?`border border-dashed border-accent-amber text-accent-amber bg-transparent`:`bg-accent-amber text-black`;return(0,Q.jsx)(`span`,{"aria-hidden":`true`,className:`shrink-0 w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center ${n}`,"data-testid":`page-annotation-pin`,"data-state":t.kind,children:e})}var Ir={open:`text-accent-blue`,addressed:`text-text-muted`,orphaned:`text-accent-amber`};function Lr({entries:e,counts:t,filter:n,onFilter:r,highlightId:i,revealNonce:a,focusRow:o,onSelect:s,fromVersion:c,liveStances:l,variant:u,onStep:d,onResolve:f,askAnswerIds:p,offlineReason:m=null}){let h=(0,O.useRef)(null),g=(0,O.useId)();if((0,O.useEffect)(()=>{if(!a||!i)return;let e=Array.from(h.current?.querySelectorAll(`[data-comment-id]`)??[]).find(e=>e.getAttribute(`data-comment-id`)===i);e?.scrollIntoView?.({block:`nearest`,behavior:`smooth`}),o&&e?.focus?.({preventScroll:!0})},[a]),e.length===0)return null;let _=n===`all`?e:e.filter(e=>Or(e.state)===n),v=[...Sr,`all`];return(0,Q.jsxs)(`section`,{className:`space-y-1.5`,"data-testid":`page-annotations`,"data-variant":u,"aria-label":`Comments on the page`,children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-x-2 gap-y-1`,children:[(0,Q.jsx)(`h3`,{className:`text-2xs font-semibold text-text-muted uppercase tracking-wide`,children:`On the page`}),(0,Q.jsx)(`div`,{className:`flex flex-wrap gap-1`,role:`group`,"aria-label":`Filter comments`,"data-testid":`page-queue-filters`,children:v.map(i=>{let a=i===`all`?e.length:t[i],o=i===`all`?`All`:Cr[i];return(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>r(i),"aria-pressed":n===i,className:`px-1.5 py-0.5 rounded border text-2xs pointer-coarse:min-h-11 ${n===i?`border-accent-blue bg-accent-blue-dim/40 text-text-primary`:`border-border-default text-text-secondary hover:bg-surface-elevated`}`,"data-testid":`page-queue-filter-${i}`,children:[o,` `,(0,Q.jsx)(`span`,{className:`tabular-nums`,children:a})]},i)})}),d&&_.length>0&&(0,Q.jsxs)(`div`,{className:`flex gap-1 ml-auto`,role:`group`,"aria-label":`Step through comments`,children:[(0,Q.jsx)(`button`,{type:`button`,onClick:()=>d(-1),"aria-label":`Previous comment`,"aria-keyshortcuts":`[`,title:`Previous comment ( [ )`,className:`px-1.5 py-0.5 rounded border border-border-default text-2xs text-text-secondary hover:bg-surface-elevated pointer-coarse:min-h-11 pointer-coarse:min-w-11`,"data-testid":`page-queue-prev`,children:`‹`}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>d(1),"aria-label":`Next comment`,"aria-keyshortcuts":`]`,title:`Next comment ( ] )`,className:`px-1.5 py-0.5 rounded border border-border-default text-2xs text-text-secondary hover:bg-surface-elevated pointer-coarse:min-h-11 pointer-coarse:min-w-11`,"data-testid":`page-queue-next`,children:`›`})]})]}),_.length===0?(0,Q.jsx)(`p`,{className:`text-2xs text-text-muted italic`,"data-testid":`page-queue-empty`,children:n===`open`?`Nothing open: every comment has been addressed or is no longer on the page.`:n===`addressed`?`Nothing addressed yet.`:`Every comment's spot is on this version.`}):(0,Q.jsx)(`ol`,{className:`space-y-1.5`,ref:h,children:_.map(e=>{let{comment:t,index:n,state:r,replies:a,missing:o}=e,u=t.target.htmlAnchor,d=Ar(r),h=t.id===i,_=c(t),v=f?Nr(e,{answersAsk:p?.has(t.id)===!0}):null;return(0,Q.jsxs)(`li`,{className:`flex gap-1 items-stretch`,children:[(0,Q.jsx)(`span`,{className:`sr-only`,id:`${g}-state-${n}`,children:d.title}),(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>s(n),"aria-current":h?`true`:void 0,"aria-describedby":`${g}-state-${n}`,className:`flex-1 min-w-0 text-left flex gap-2 p-2 rounded border hover:bg-surface-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${h?`border-accent-blue ring-1 ring-accent-blue bg-accent-blue-dim/20`:`border-border-default`} ${r.kind===`addressed`?`opacity-75`:``}`,"data-testid":`page-annotation`,"data-comment-id":t.id,"data-state":r.kind,children:[(0,Q.jsx)(Fr,{n:n+1,state:r}),(0,Q.jsxs)(`span`,{className:`flex-1 min-w-0 space-y-1`,children:[(0,Q.jsxs)(`span`,{className:`sr-only`,children:[`Comment `,n+1,`.`]}),(0,Q.jsxs)(`span`,{className:`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs`,children:[(0,Q.jsx)(`span`,{className:`font-semibold ${Ir[Or(r)]}`,title:d.title,"data-testid":r.kind===`orphaned`?`page-anchor-missing`:`page-annotation-state`,children:d.text}),a>0&&(0,Q.jsxs)(`span`,{className:`text-text-muted`,"data-testid":`page-annotation-replies`,children:[a,` `,a===1?`reply`:`replies`]}),_!=null&&(0,Q.jsxs)(`span`,{className:`text-text-muted italic`,children:[`from v`,_]})]}),(0,Q.jsx)(Pr,{anchor:u}),t.ruleOut&&l.has(t.ruleOut.description)&&(0,Q.jsxs)(`span`,{className:`block text-2xs text-accent-red`,"data-testid":`page-annotation-ruled-out`,children:[`Ruled out: Claude won't present a page that still contains “`,t.ruleOut.description,`”`]}),t.ruleOut&&!l.has(t.ruleOut.description)&&(0,Q.jsx)(`span`,{className:`block text-2xs text-text-muted`,"data-testid":`page-annotation-ruled-out-retired`,children:`Was ruled out; that stance has since been retired`}),o&&r.kind!==`orphaned`&&(0,Q.jsx)(`span`,{className:`block text-2xs text-text-muted`,"data-testid":`page-anchor-gone`,children:`Its spot is no longer on this version of the page.`}),(0,Q.jsx)(`span`,{className:`block text-xs text-text-primary line-clamp-3 break-words`,children:t.content})]})]}),v&&(0,Q.jsx)(`button`,{type:`button`,onClick:()=>{m||f(t.id,v.kind===`resolve`)},disabled:!!m,title:m??v.title,"aria-label":`${v.label} comment ${n+1}`,className:`shrink-0 self-start px-2 py-1 rounded border border-border-default text-2xs text-text-secondary hover:bg-surface-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:opacity-50 disabled:cursor-not-allowed`,"data-testid":v.kind===`resolve`?`page-annotation-resolve`:`page-annotation-reopen`,children:v.label})]},t.id)})})]})}function Rr({artifactId:e,anchor:t,ruledOut:n,onRecorded:o}){let c=ge(),l=ne(t.quote),u=l.ok?l.key:null,d=l.ok?null:y[l.reason],[f,p]=(0,O.useState)(!1),[m,h]=(0,O.useState)(``);he(`page-rule-out:${e}:${t.locator}`,m);let[g,_]=(0,O.useState)(!1),[v,b]=(0,O.useState)(null),[x,S]=(0,O.useState)(null),C=o?n??null:x??n??null,ee=(0,O.useRef)(null),te=(0,O.useRef)(!1);(0,O.useEffect)(()=>{!f&&te.current&&(te.current=!1,ee.current?.focus())},[f]);let w=()=>{te.current=!0,p(!1),h(``),b(null)},T=m.trim(),re=async()=>{if(!(c||g||!T||!u)){_(!0),b(null);try{let n=s.getState().owningSession(e),c=await i(`${r()}/api/artifacts/${encodeURIComponent(e)}/rule-out`,{method:`POST`,headers:a(n),body:JSON.stringify({htmlAnchor:t,reason:T})}),l=null;try{l=await c.json()}catch{}l?.comment?.id&&s.getState().addComment(l.comment),S(l?.description??u),o?.(l?.description??u),p(!1),h(``)}catch(e){b(e instanceof Error?e.message:`Couldn't save that. Try again.`)}finally{_(!1)}}};if(C)return(0,Q.jsxs)(`p`,{className:`text-2xs text-accent-red`,role:`status`,"data-testid":`page-rule-out-recorded`,children:[`✓ Ruled out “`,C,`”. Claude won't present a page that still contains this text in this project. You can retire it in the Ledger.`]});if(!f)return(0,Q.jsxs)(`span`,{className:`inline-flex flex-wrap items-center justify-end gap-1.5`,children:[d&&(0,Q.jsx)(`span`,{className:`text-2xs text-text-muted`,"data-testid":`page-rule-out-unavailable`,children:d}),(0,Q.jsx)(`button`,{ref:ee,type:`button`,onClick:()=>p(!0),disabled:!u,title:d??`Remember this text as rejected, so Claude won't present a page that still contains it in this project`,className:`px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-accent-red hover:bg-accent-red-dim/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`,children:`Rule this out`})]});let ie=`page-rule-out-reason-${e}`;return(0,Q.jsxs)(`div`,{role:`group`,"aria-label":`Rule this out`,className:`w-full p-2 bg-surface-secondary border border-accent-red/30 rounded-lg`,"data-testid":`page-rule-out-panel`,onKeyDown:e=>{e.key===`Escape`&&!e.defaultPrevented&&(e.preventDefault(),w())},children:[(0,Q.jsxs)(`label`,{htmlFor:ie,className:`block text-2xs text-text-muted mb-1.5`,children:[`Rule out “`,(0,Q.jsx)(`span`,{className:`text-text-primary`,children:u}),`”? Claude won't present a page that still contains this text in this project. It only applies to pages, and this page's status doesn't change (you can retire the stance later in the Ledger). Why are you ruling it out? (required)`]}),(0,Q.jsx)(`textarea`,{id:ie,rows:2,autoFocus:!0,value:m,onChange:e=>h(e.target.value),onKeyDown:e=>{e.key===`Enter`&&(e.metaKey||e.ctrlKey)&&(e.preventDefault(),re()),e.key===`Escape`&&(e.preventDefault(),w())},placeholder:`Your reason (Claude sees it when the gate refuses this text)…`,className:`w-full px-2 py-1.5 bg-surface-primary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none`}),v&&(0,Q.jsx)(`p`,{className:`mt-1 text-2xs text-accent-red`,role:`alert`,children:v}),(0,Q.jsxs)(`div`,{className:`flex gap-1.5 mt-1.5 justify-end`,children:[(0,Q.jsx)(`button`,{type:`button`,onClick:w,className:`px-2 py-1 text-2xs text-text-muted hover:text-text-secondary cursor-pointer`,children:`Cancel`}),(0,Q.jsx)(`button`,{type:`button`,title:c??(T?void 0:`Say why first`),onClick:()=>void re(),disabled:g||!!c||!T,className:`px-2 py-1 text-2xs text-text-inverse bg-accent-red hover:bg-accent-red/80 rounded press-scale cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`,children:`Rule it out`})]})]})}var zr=/<!--[\s\S]*?-->|<(pre|code|script|textarea|xmp|listing|plaintext)\b[\s\S]*?<\/\1\s*>/gi,Br=/<meta\b[^>]*>/gi,Vr=/\bname\s*=\s*["']?\s*color-scheme\b/i,Hr=/\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i,Ur=/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,Wr=/<[a-z][^>]*?\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi,Gr=/(?:^|[\s;{])color-scheme\s*:\s*[^;}]*\bdark\b/i,Kr=/prefers-color-scheme\s*:\s*dark/i,qr=/\blight-dark\s*\(/i;function Jr(e){return Gr.test(e)||Kr.test(e)||qr.test(e)}function Yr(e){if(!e)return!1;let t=e.replace(zr,` `);for(let e of t.match(Br)??[]){if(!Vr.test(e))continue;let t=Hr.exec(e),n=(t?.[2]??t?.[3]??t?.[4]??``).toLowerCase();if(/\bdark\b/.test(n)&&!/\bonly\s+light\b/.test(n))return!0}for(let e of t.matchAll(Ur))if(Jr(e[1]??``))return!0;for(let e of t.matchAll(Wr))if(Jr(e[2]??e[3]??``))return!0;return!1}var Xr=new Set([`img-src`,`media-src`,`script-src`,`script-src-elem`,`style-src`,`style-src-elem`]),Zr=new Set([`img`,`image`,`input`]),Qr=new Set([`video`,`audio`,`source`,`track`]);function $r(e,t=120){let n=e.replace(/\s+/g,` `).trim().replace(/\b(?:data|blob):[^\s"'<>()]*/gi,`[data URI]`).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]*/gi,`[url]`).replace(/(^|[\s("'=])\/\/[^\s"'<>()]+/g,`$1[url]`);return n.length>t?n.slice(0,t):n}var ei=(e,t,n)=>`${e} ${e===1?t:n}`,ti=e=>e.split(` `,1)[0]??``,ni=e=>e.reduce((e,t)=>e+t.count,0);function ri(e){return!!e&&(e.scriptErrors.count>0||e.rejections.count>0||e.resources.length>0||e.blocked.length>0)}function ii(e){let t=[],n=e.scriptErrors.count+e.rejections.count;n>0&&t.push(ei(n,`script error`,`script errors`));let r=ni(e.resources.filter(e=>Zr.has(ti(e.key)))),i=ni(e.resources.filter(e=>Qr.has(ti(e.key)))),a=ni(e.resources)-r-i;r>0&&t.push(`${ei(r,`image`,`images`)} that didn't load`),i>0&&t.push(`${ei(i,`media file`,`media files`)} that didn't load`),a>0&&t.push(`${ei(a,`other asset`,`other assets`)} that didn't load`);let o=ni(e.blocked.filter(e=>!Xr.has(e.key)));return t.length===0&&o===0&&(o=ni(e.blocked)),o>0&&t.push(ei(o,`blocked request`,`blocked requests`)),t.length===0?null:t.length===1?t[0]:`${t.slice(0,-1).join(`, `)} and ${t[t.length-1]}`}var ai=e=>e.map(e=>`${e.key} ×${e.count}`).join(`, `);function oi(e){let t=[],n=e=>e.map(e=>$r(e)).filter(Boolean).join(` · `);if(e.scriptErrors.count>0){let r=n(e.scriptErrors.samples);t.push(`Script errors (${e.scriptErrors.count})${r?`: ${r}`:``}`)}if(e.rejections.count>0){let r=n(e.rejections.samples);t.push(`Unhandled promise rejections (${e.rejections.count})${r?`: ${r}`:``}`)}return e.resources.length>0&&t.push(`Didn't load: ${ai(e.resources)}`),e.blocked.length>0&&t.push(`Blocked by the frame's no-network policy: ${ai(e.blocked)}`),(e.resources.length>0||e.blocked.some(e=>e.key===`img-src`||e.key===`media-src`||e.key===`font-src`))&&t.push(`Relative and external asset paths can't load in the review frame; the page should inline them as data: URIs.`),t}function si(e,t){let n=[...e.scriptErrors.classes.map(e=>({kind:`script`,key:e.key,count:e.count})),...e.rejections.classes.map(e=>({kind:`rejection`,key:e.key,count:e.count})),...e.resources.map(e=>({kind:`resource`,key:e.key,count:e.count})),...e.blocked.map(e=>({kind:`blocked`,key:e.key,count:e.count}))];return ce({version:t.version,running:t.running,items:n})}function ci(e){let t=C(e);return t?x(t):e}function li({diagnostics:e}){let[t,n]=(0,O.useState)(null);if(!ri(e))return null;let r=ii(e);if(!r)return null;let i=JSON.stringify(e);if(t===i)return null;let a=oi(e);return(0,Q.jsxs)(`div`,{className:`flex items-start gap-2 px-3 py-2 rounded-lg border border-accent-amber/40 bg-accent-amber/10 text-xs text-text-primary`,role:`status`,"data-testid":`page-render-issues`,children:[(0,Q.jsxs)(`div`,{className:`min-w-0 flex-1`,children:[(0,Q.jsxs)(`span`,{"data-testid":`page-render-issues-headline`,children:[`This page has `,r,`.`]}),a.length>0&&(0,Q.jsxs)(`details`,{className:`mt-1 text-2xs text-text-secondary`,children:[(0,Q.jsx)(`summary`,{className:`cursor-pointer text-text-muted`,children:`Details`}),(0,Q.jsx)(`ul`,{className:`mt-1 space-y-0.5 list-disc pl-4 break-words`,"data-testid":`page-render-issues-details`,children:a.map(e=>(0,Q.jsx)(`li`,{children:e},e))})]})]}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>n(i),"aria-label":`Dismiss render issues`,className:`shrink-0 px-1 rounded text-text-muted hover:bg-surface-elevated`,"data-testid":`page-render-issues-dismiss`,children:`×`})]})}var ui=1152;function di(e,t){let[n,r]=(0,O.useState)(!1);return(0,O.useLayoutEffect)(()=>{let n=e.current;if(!n||typeof ResizeObserver!=`function`)return;let i=()=>r(n.getBoundingClientRect().width>=t);i();let a=new ResizeObserver(i);return a.observe(n),()=>a.disconnect()},[e,t]),n}var fi=(e,t,n)=>Math.min(Math.max(e,t),Math.max(t,n)),pi=320;function mi(e){let t=e.trim().replace(/\s+/g,` `);return t.length>200?`${t.slice(0,200)}…`:t}var hi={},gi=6e4,_i=1500,vi=5e3,yi={script:k,scriptFor:Pe,sanitize:Ve,prepare:bt},bi=[];function xi(){let e=typeof navigator<`u`&&navigator.platform||``;return/Mac|iPhone|iPad|iPod/.test(e)?`⌘I`:`Ctrl+I`}function Si(e){if(e.metaKey||e.ctrlKey||e.altKey)return!1;let t=e.target,n=t?.tagName;return n===`INPUT`||n===`TEXTAREA`||n===`SELECT`||t?.isContentEditable===!0?!1:!document.querySelector(`[aria-modal="true"]`)}function Ci(e){if(e.index<0||e.total===0)return`Comment mode: this page has no blocks to comment on. Press Escape to leave.`;let t=e.text.trim(),n=e.pins.length?` Has ${e.pins.length===1?`comment`:`comments`} ${e.pins.map(e=>e+1).join(`, `)}.`:``;return`${e.kind[0].toUpperCase()}${e.kind.slice(1)}, ${e.index+1} of ${e.total}${t?`: ${t}`:``}.${n}`}function wi(e){return(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&(e.key===`i`||e.key===`I`)}function Ti(e){return e.filter(e=>D(`page`,e)).slice().sort((e,t)=>e.createdAt.localeCompare(t.createdAt))}function Ei({artifact:e}){let t=ie(e.content),n=(0,O.useRef)(null),r=o(e=>e.active),i=be(e.status,r),a=i===`closed`||i===`frozen`,l=ae(e.fileWatch),u=(0,O.useMemo)(()=>new Set((ae(e.fileWatch).recorded?.orphaned??[]).map(e=>e.commentId)),[e.fileWatch]),d=ye(e.id),{rows:f,remember:p}=Ae(s(t=>t.owningSession(e.id))),m=(0,O.useMemo)(()=>new Set(f.map(e=>e.description)),[f]),h=(0,O.useMemo)(()=>Ti(d),[d]),g=(0,O.useMemo)(()=>h.map(e=>e.id).join(`\0`),[h]),y=(0,O.useMemo)(()=>v(g)??`0`,[g]),x=(0,O.useMemo)(()=>h.map(e=>e.target.htmlAnchor),[h]),S=(0,O.useMemo)(()=>h.map(e=>e.id),[h]),C=s(e=>e.artifacts),ee=(0,O.useMemo)(()=>({revisionAt:e=>C.find(t=>t.id===e)?.createdAt}),[C]),te=h.map(e=>kr(Dr(e,wr(e,d),!1,ee))).join(`,`),ne=(0,O.useMemo)(()=>te?te.split(`,`):[],[te]),[w,T]=(0,O.useState)(null),re=(0,O.useRef)(w);re.current=w;let[oe,ce]=(0,O.useState)(0),[ue,de]=(0,O.useState)(!1),fe=(0,O.useRef)(null),[me,E]=(0,O.useState)(0),he=(0,O.useRef)(null),D=(0,O.useRef)(e.id);D.current=e.id;let Ee=(0,O.useCallback)(e=>!e||e!==n.current||!e.isConnected||document.activeElement!==e||e.closest(`[inert]`)?!1:s.getState().selectedArtifactId===D.current,[]),De=(0,O.useRef)(Ee);De.current=Ee;let[Me,Ne]=(0,O.useState)(null),Pe=Me&&Me.forId===e.id&&Me.key===y?Me.found:null,[k,Fe]=(0,O.useState)(!1),A=(0,O.useMemo)(()=>jr(h,d,(e,t)=>Pe?Pe[t]===!1:u.has(e.id),ee),[h,d,Pe,u,ee]),Ie=(0,O.useMemo)(()=>Mr(A),[A]),[Le,Re]=(0,O.useState)(null),ze=Le??(Ie.open>0?`open`:`all`),[Be,Ve]=(0,O.useState)(null),[He,Ue]=(0,O.useState)({nonce:0,focus:!1}),[j,We]=(0,O.useState)(null),Ge=(0,O.useRef)(A);Ge.current=A;let Ke=(0,O.useRef)(ze);Ke.current=ze;let qe=(0,O.useRef)(null),M=di(qe,ui),Je=(0,O.useRef)(M);Je.current=M;let Ye=(0,O.useRef)(null),[Xe,Ze]=(0,O.useState)(null);(0,O.useLayoutEffect)(()=>{if(!j)return;let e=Ye.current,t=()=>{let t=n.current;if(!e||!t)return Ze(null);let r=e.getBoundingClientRect(),i=t.getBoundingClientRect();Ze({top:i.top-r.top,left:i.left-r.left,width:i.width,height:i.height})};if(t(),!e||typeof ResizeObserver!=`function`)return;let r=new ResizeObserver(t);return r.observe(e),()=>r.disconnect()},[j,M,k]);let[N,Qe]=(0,O.useState)(null),[$e,et]=(0,O.useState)(-1),[P,tt]=(0,O.useState)([]),[nt,rt]=(0,O.useState)(null),[it,at]=(0,O.useState)(null);(0,O.useEffect)(()=>{Qe(null),et(-1),tt([]),rt(null),at(null)},[e.id]);let[F,ot]=(0,O.useState)(!0),[st,ct]=(0,O.useState)(!1),I=st&&F&&!a&&!k,lt=(0,O.useRef)(I);lt.current=I;let[L,ut]=(0,O.useState)(!1),[dt,R]=(0,O.useState)(!1),[ft,pt]=(0,O.useState)(``),z=(0,O.useCallback)(e=>{pt(t=>t===e?`${e}\u00a0`:e)},[]),mt=ve(_e(e=>e.theme))===`dark`,ht=(0,O.useMemo)(()=>Yr(t.html),[t.html]),gt=mt&&ht,B=(0,O.useRef)(null),[V,_t]=(0,O.useState)(null),H=V&&V.doc===B.current&&V.id===e.id?V.diag:null,vt=gr(e),[yt,bt]=(0,O.useState)(null),xt=(yt&&yt.forId===e.id?vt.find(e=>e.artifact.id===yt.baseId):void 0)??vt[0],{changes:U,pending:St}=_r(e,xt?.artifact),W=U?.diff.marks??bi,[Ct,wt]=(0,O.useState)(!0),[Tt,Et]=(0,O.useState)(null),[G,Dt]=(0,O.useState)(-1);(0,O.useEffect)(()=>{Et(null),Dt(-1)},[W]);let K=(0,O.useCallback)(e=>{n.current?.contentWindow?.postMessage(e,`*`)},[]),Ot=(0,O.useCallback)(()=>K(Dn(x,ne,S,y)),[K,x,ne,S,y]),kt=(0,O.useCallback)(()=>K(Jn({annotate:F,scripts:k,kbd:I,dark:gt})),[K,F,k,I,gt]),At=(0,O.useCallback)(()=>K(mn(W,Ct&&W.length>0)),[K,W,Ct]),jt=(0,O.useRef)({sendPins:Ot,sendMode:kt,sendChanges:At});jt.current={sendPins:Ot,sendMode:kt,sendChanges:At};let Mt=(0,O.useRef)(!0);Mt.current=F;let q=(0,O.useRef)(k);q.current=k;let Nt=(0,O.useRef)(()=>{}),Pt=(0,O.useRef)(null),Ft=(0,O.useId)();(0,O.useEffect)(()=>{function t(t){let r=n.current,i=r?.contentWindow,o=an(t,i);if(o){if(a||!Mt.current||!De.current(r))return;fe.current=r,T({...o,version:e.version}),de(!1),ce(e=>e+1),E(e=>e+1);return}if(ln(t,i)){jt.current.sendMode(),jt.current.sendPins(),jt.current.sendChanges();return}if(dn(t,i)){!a&&!q.current&&De.current(r)&&ot(e=>!e);return}if(Gn(t,i)){if(!lt.current)return;lt.current=!1,ct(!1),z(`Comment mode off.`);return}let s=Wn(t,i);if(s){q.current||z(Ci(s));return}let c=qn(t,i);if(c){if(q.current||!De.current(r))return;Nt.current(c);return}let l=cn(t,i);if(l){Ne({forId:D.current,key:l.key??``,found:l.found}),q.current||at({forId:D.current,key:l.key??``,found:l.found});return}let u=On(t,i);if(u!==null){if(q.current)return;let e=Ge.current.find(e=>e.comment.id===u);if(!e)return;let t=Or(e.state);Ke.current!==`all`&&Ke.current!==t&&Re(t),Ve(e.comment.id),Ue(e=>({nonce:e.nonce+1,focus:De.current(r)}));return}let d=An(t,i);if(d){if(q.current)return;We(d.id===null?null:d);return}let f=bn(t,i);if(f){q.current||Qe(f);return}let p=xn(t,i);if(p!==null){q.current||et(p);return}let m=wn(t,i);if(m){q.current||(tt(m.asks),rt({forId:D.current,key:m.key??``,list:m.pinAsks}));return}let h=zn(t,i);if(h){h.doc===B.current&&_t({doc:h.doc,id:D.current,diag:h.diagnostics});return}let g=hn(t,i);g&&!q.current&&Et(g)}return window.addEventListener(`message`,t),()=>window.removeEventListener(`message`,t)},[e.version,a,z]),(0,O.useEffect)(()=>{if(a)return;function e(e){if(e.defaultPrevented||e.repeat||!wi(e))return;let t=e.target,n=t?.tagName;if(n===`INPUT`||n===`TEXTAREA`||n===`SELECT`||t?.isContentEditable===!0)return;let r=Pt.current;!r||!r.isConnected||r.closest(`[inert]`)||s.getState().selectedArtifactId===D.current&&(e.preventDefault(),ot(e=>!e))}return window.addEventListener(`keydown`,e),()=>window.removeEventListener(`keydown`,e)},[a]),(0,O.useEffect)(()=>{Ot()},[Ot]),(0,O.useEffect)(()=>{kt()},[kt]),(0,O.useEffect)(()=>{At()},[At]),(0,O.useEffect)(()=>{Ne(null),Et(null),We(null)},[k]);let It=ge(),Lt=It!==null,J=(0,O.useRef)(null);(0,O.useEffect)(()=>()=>{J.current&&clearTimeout(J.current.timer),J.current=null},[]);let Rt=(0,O.useCallback)(e=>{e!==B.current&&(B.current=e,J.current&&clearTimeout(J.current.timer),J.current=null,_t(null))},[]);(0,O.useEffect)(()=>{let t=()=>{J.current&&clearTimeout(J.current.timer),J.current=null};if(Lt||a||!V||V.doc!==B.current||V.id!==e.id||!ri(V.diag))return t();let n=V.doc,r=si(V.diag,{version:e.version,running:k});if(!r)return t();let i=e.id,o=ci(r),c=hi[i];if(c&&c.key===o&&(c.text===r||Date.now()-c.at<gi))return t();let l=J.current,u=Date.now(),d=l&&l.doc===n&&l.id===i?l.firstAt:u;t();let f=()=>{let e=J.current;J.current=null,!(!e||e.doc!==B.current||e.id!==D.current)&&(hi[e.id]={key:e.key,text:e.summary,at:Date.now()},s.getState().reportRenderFailure(e.id,_,e.summary))},p=Math.max(0,Math.min(_i,d+vi-u));J.current={doc:n,id:i,key:o,summary:r,firstAt:d,timer:setTimeout(f,p)}},[V,a,k,e.id,e.version,Lt]),(0,O.useEffect)(()=>{Ve(null),We(null),Re(null)},[e.id]),(0,O.useEffect)(()=>{if(!(!me||!Ee(fe.current))&&(he.current?.querySelector(`textarea`)?.focus?.({preventScroll:!0}),!Je.current&&re.current)){he.current?.scrollIntoView?.({block:`nearest`});let{version:e,...t}=re.current;K({dp:`focus`,anchor:t,block:`end`})}},[me,Ee,K]);let zt=(0,O.useCallback)(e=>Fe(e),[]),Bt=e=>{let t=W.length;if(t)for(let n=1;n<=t;n++){let r=(((G<0?e===1?-1:0:G)+e*n)%t+t)%t;if(!(Tt&&Tt[r]===!1)){Dt(r),K({dp:`focus-change`,index:r});return}}},Vt=Tt?Tt.filter(Boolean).length:W.length,Ht=U?U.diff.changeMarksTotal+U.diff.hintMarksTotal:0,Ut=!!xt&&(ie(xt.artifact.content).summary??``).trim()!==(t.summary??``).trim(),Wt=e.version>1&&!l.recorded?e.agentReasoning?.trim():``,Gt=t=>{let n=x[t];n&&(K(M?{dp:`focus`,index:t}:{dp:`focus`,index:t,block:`end`}),Ve(h[t]?.id??null),a||(fe.current=null,T({...n,version:e.version}),de(!0),ce(e=>e+1)))},Kt=(0,O.useRef)(Be);Kt.current=Be;let qt=(0,O.useCallback)(e=>{let t=Ge.current,n=Ke.current,r=n===`all`?t:t.filter(e=>Or(e.state)===n);if(!r.length)return;let i=r.findIndex(e=>e.comment.id===Kt.current),a=r[i<0?e===1?0:r.length-1:(i+e+r.length)%r.length];Ve(a.comment.id),Ue(e=>({nonce:e.nonce+1,focus:!0})),a.missing||K(Je.current?{dp:`focus`,index:a.index}:{dp:`focus`,index:a.index,block:`end`});let o=a.comment.target.htmlAnchor,s=o.quote.trim();z(`Comment ${a.index+1}, ${r.indexOf(a)+1} of ${r.length}: ${Ar(a.state).text}. ${xe(o.kind)}${s?` “${s.slice(0,80)}”`:``}. ${mi(a.comment.content)}`)},[K,z]),Jt=(0,O.useCallback)(()=>{if(a||k)return;let e=!(st&&F);ct(e),e&&(ot(!0),n.current?.focus?.()),z(e?`Comment mode on. Arrow keys or Tab move between blocks, Enter comments, Escape leaves.`:`Comment mode off.`)},[a,k,st,F,z]);(0,O.useEffect)(()=>{(!F||k)&&ct(!1)},[F,k]),Nt.current=e=>{e===`toggle-kbd`?Jt():e===`help`?R(e=>!e):e===`next`?qt(1):e===`prev`?qt(-1):e===`escape`&&(dt?R(!1):L&&ut(!1))},(0,O.useEffect)(()=>{function e(e){if(e.defaultPrevented||e.repeat||!Si(e))return;let t=e.key===`C`?`c`:e.key;if(t!==`c`&&t!==`]`&&t!==`[`)return;let n=Pt.current;if(!(!n||!n.isConnected||n.closest(`[inert]`))&&s.getState().selectedArtifactId===D.current){if(t===`c`){if(a)return;e.preventDefault(),Jt();return}e.preventDefault(),qt(t===`]`?1:-1)}}return window.addEventListener(`keydown`,e),()=>window.removeEventListener(`keydown`,e)},[a,Jt,qt]);let Yt=(0,O.useRef)(null);(0,O.useEffect)(()=>{let t=new Set(h.map(e=>e.id)),n=Yt.current?.forId===e.id?Yt.current.ids:null;if(Yt.current={forId:e.id,ids:t},!n)return;let r=h.filter(e=>!n.has(e.id));r.length===1?z(`Comment ${h.indexOf(r[0])+1} posted.`):r.length>1&&z(`${r.length} comments added.`)},[h,z,e.id]);let Xt=Pe?Pe.filter(e=>!e).length:0;(0,O.useEffect)(()=>{Xt>0&&z(`${Xt} of ${h.length} ${h.length===1?`comment's spot is`:`comments' spots are`} not on this version.`)},[Xt]);let Zt=s(e=>e.markQuestionResolved),Qt=s(e=>e.reopenComment),$t=(0,O.useCallback)((e,t)=>{if(It)return;let n=h.findIndex(t=>t.id===e)+1;(t?Zt(e):Qt(e)).then(()=>z(`Comment ${n} ${t?`resolved`:`reopened`}.`),()=>{})},[h,Zt,Qt,z,It]),Y=N?.headings??[],en=(0,O.useMemo)(()=>{let e=N?.headings.length??0,t=Array(e).fill(0),n=Array(e).fill(0);return N?(N.pins.length===h.length&&h.forEach((e,n)=>{let r=N.pins[n];r<0||A[n]?.state.kind!==`open`||(t[r]=(t[r]??0)+1)}),N.changes.length===W.length&&N.changes.forEach(e=>{e>=0&&(n[e]=(n[e]??0)+1)}),{comments:t,changes:n}):{comments:t,changes:n}},[N,h,A,W]),tn=e=>{let t=Y[e];t&&(et(e),K({dp:`focus-heading`,index:e,locator:t.locator}))},nn=(0,O.useMemo)(()=>{let t=new Set;for(let n of h)n.target.artifactId&&n.target.artifactId!==e.id&&t.add(n.target.artifactId);return t},[h,e.id]),{get:rn,pending:X}=hr((0,O.useMemo)(()=>[e,...vt.map(e=>e.artifact).filter(e=>nn.has(e.id))],[e,vt,nn]),P.length>0&&h.length>0),on=(0,O.useRef)(null),{answered:sn,answerIds:un,checking:fn}=(0,O.useMemo)(()=>{let t={artifactId:e.id,version:e.version},n=t=>t&&t.forId===e.id&&t.key===y?t:null,r=n(nt)?.list??null,i=n(it)?.found??null,a=!!r&&r.length===h.length,o=rn(e.id),s=t=>t===e.id?void 0:rn(t),c=new Set,l=P.map((e,n)=>{let l=e.id?o?.find(t=>t.id===e.id):void 0,u={...e,...l?.fullHash?{fullHash:l.fullHash}:{},...l?.childIds?{childIds:l.childIds}:{}},d=!1;return h.forEach((e,t)=>{f(e,t)&&(d=!0,c.add(e.id))}),d;function f(e,o){return b(e,t)?pe(u,e,t,{earlierAsks:s}):i&&i[o]===!1?!1:pe(u,e,t,{insideByFrame:a&&r[o]===n&&i?.[o]===!0})}}),u=P.length>0&&h.length>0&&X,d=h.some(e=>!b(e,t)),f=!k&&d&&(!r||!i),p=P.map(e=>`${e.kind}\u0001${e.locator}`).join(`\0`),m=on.current;return f?m&&m.forId===e.id?{answered:m.asksKey===p?l.map((e,t)=>e||m.answered[t]===!0):l,answerIds:c,checking:u}:{answered:l,answerIds:c,checking:!0}:(on.current={forId:e.id,asksKey:p,answered:l},{answered:l,answerIds:c,checking:u})},[P,h,y,nt,it,e.id,e.version,rn,X,k]),pn=e=>{let t=P[e];t&&K({dp:`focus-ask`,index:e,locator:t.locator})},gn=t=>{let n=P[t],r=n?Tn(n):null;!n||!r||a||(K({dp:`focus-ask`,index:t,locator:n.locator}),fe.current=null,T({...r,version:e.version}),de(!0),ce(e=>e+1))},_n={headings:Y,commentCounts:en.comments,changeCounts:Ct?en.changes:[],active:$e,onJump:tn},vn=w?d.filter(e=>{if(Te(e.target.htmlAnchor,w))return!0;let t=h.find(t=>t.id===e.parentCommentId);return!!t&&Te(t.target.htmlAnchor,w)}):[],yn=()=>{T(null),n.current?.focus?.()},Sn=e=>{e.key!==`Escape`||e.defaultPrevented||(e.preventDefault(),e.stopPropagation(),yn())},Cn=w&&!a?(0,Q.jsxs)(`div`,{className:`p-3 rounded-lg border border-accent-blue/30 bg-surface-elevated space-y-2`,ref:he,role:`group`,"aria-label":`Comment composer`,onKeyDown:Sn,"data-testid":`page-anchor-composer`,"data-placement":M?`rail`:`below`,children:[(0,Q.jsxs)(`div`,{className:`flex items-start gap-2`,children:[(0,Q.jsx)(`div`,{className:`flex-1 min-w-0`,children:(0,Q.jsx)(Pr,{anchor:w})}),(0,Q.jsx)(`button`,{type:`button`,onClick:yn,title:`Close (Esc) and return to the page`,className:`text-2xs text-text-muted hover:text-text-secondary`,children:`Close`})]}),(0,Q.jsx)(Ce,{artifactId:e.id,comments:vn,target:{htmlAnchor:w},roomy:!0,focusOnOpen:ue,placeholder:`Comment on this spot… (⌘⏎ to send, Esc to return to the page)`,textareaLabel:`Comment on the selected spot`,secondarySubmitLabel:`Ask`,secondarySubmitTitle:`Post as a question about this spot — the agent owes you an answer`},oe),(0,Q.jsx)(`div`,{className:`flex justify-end`,"data-testid":`page-rule-out`,children:(0,Q.jsx)(Rr,{artifactId:e.id,anchor:w,ruledOut:(()=>{let e=le(w.quote);return e&&m.has(e)?e:void 0})(),onRecorded:t=>p({description:t,sourceArtifactId:e.id})},oe)})]}):null,En=t=>(0,Q.jsx)(Lr,{entries:A,counts:Ie,filter:ze,onFilter:Re,highlightId:Be,revealNonce:He.nonce,focusRow:He.focus,onSelect:Gt,fromVersion:t=>c(C,t,e.id),liveStances:m,variant:t,onStep:qt,onResolve:a?void 0:$t,askAnswerIds:un,offlineReason:It}),Z=j?A.find(e=>e.comment.id===j.id):void 0,kn=j&&Z?{left:(Xe?.left??0)+fi(j.at.x,0,(Xe?.width??0)-pi),top:(Xe?.top??0)+fi(j.at.y+4,0,Xe?.height??j.at.y+4),maxWidth:pi}:void 0;return(0,Q.jsxs)(`div`,{className:`space-y-3`,"data-testid":`page-artifact`,ref:Pt,children:[t.summary&&(0,Q.jsx)(`div`,{className:`px-4 py-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg`,children:(0,Q.jsx)(we,{text:t.summary,className:`prose-field text-sm text-text-primary space-y-2`})}),(t.sourcePath||t.concept)&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,children:[t.concept&&(0,Q.jsx)(ke,{name:t.concept.name,explanation:t.concept.oneLineExplanation}),t.sourcePath&&(0,Q.jsxs)(`span`,{children:[`From `,(0,Q.jsx)(`code`,{className:`font-mono text-text-secondary`,children:t.sourcePath})]})]}),(Wt||l.recorded||xt)&&(0,Q.jsxs)(`div`,{className:`px-3 py-2 rounded-lg border border-accent-violet/30 bg-accent-violet/5 space-y-1.5`,"data-testid":`page-version-changes`,children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-baseline gap-x-3 gap-y-1`,children:[Wt&&(0,Q.jsxs)(`p`,{className:`text-xs text-text-primary`,"data-testid":`page-revise-reason`,children:[(0,Q.jsxs)(`span`,{className:`font-semibold text-accent-violet`,children:[`Why v`,e.version,`:`]}),` `,Wt]}),l.recorded&&(0,Q.jsxs)(`div`,{className:`text-2xs text-text-muted`,"data-testid":`page-file-recorded`,children:[`Recorded automatically from `,(0,Q.jsx)(`code`,{className:`font-mono text-text-secondary`,children:l.recorded.sourcePath}),` after a save, replacing v`,l.recorded.fromVersion,`.`,l.recorded.orphaned.length+(l.recorded.orphanedOverflow??0)>0&&(0,Q.jsxs)(Q.Fragment,{children:[` `,l.recorded.orphaned.length+(l.recorded.orphanedOverflow??0),` earlier comment(s) point at text that is no longer on the page.`]})]})]}),xt&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,"data-testid":`page-changes-bar`,children:[(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>wt(e=>!e),"aria-pressed":Ct,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,title:`Mark the blocks that are new, reworded or moved to another section since the version you compare with`,"data-testid":`page-changes-toggle`,children:[`Changes since v`,xt.artifact.version,`: `,Ct?`on`:`off`]}),vt.length>1&&(0,Q.jsxs)(`label`,{className:`inline-flex items-center gap-1`,children:[(0,Q.jsx)(`span`,{children:`Compare with`}),(0,Q.jsx)(`select`,{"aria-label":`Compare with`,value:xt.artifact.id,onChange:t=>bt({forId:e.id,baseId:t.target.value}),className:`bg-surface-elevated border border-border-default rounded px-1 py-0.5 text-text-secondary`,"data-testid":`page-compare-with`,children:vt.map(e=>(0,Q.jsxs)(`option`,{value:e.artifact.id,children:[`v`,e.artifact.version,e.autoSave?` (auto-save)`:``]},e.artifact.id))})]}),St&&(0,Q.jsx)(`span`,{"data-testid":`page-changes-pending`,children:`Comparing…`}),U&&Ct&&W.length>0&&(0,Q.jsxs)(`span`,{className:`inline-flex items-center gap-1`,"data-testid":`page-changes-nav`,children:[(0,Q.jsxs)(`span`,{"data-testid":`page-changes-count`,children:[Vt,` `,Vt===1?`highlight`:`highlights`,G>=0&&Vt>0?` (at ${G+1})`:``]}),(0,Q.jsxs)(`span`,{className:`text-text-muted`,"data-testid":`page-changes-breakdown`,children:[`(`,U.diff.changeMarksTotal,` `,U.diff.changeMarksTotal===1?`change`:`changes`,U.diff.hintMarksTotal>0?` · ${U.diff.hintMarksTotal} author ${U.diff.hintMarksTotal===1?`hint`:`hints`}`:``,U.diff.unhighlightable>0?` · ${U.diff.unhighlightable} not highlightable`:``,Ht>W.length?`; showing ${W.length} of ${Ht}`:``,`)`]}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>Bt(-1),disabled:Vt===0,"aria-label":`Previous highlight`,className:`px-1 rounded border border-border-default hover:bg-surface-elevated disabled:opacity-40`,children:`‹`}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>Bt(1),disabled:Vt===0,"aria-label":`Next highlight`,className:`px-1 rounded border border-border-default hover:bg-surface-elevated disabled:opacity-40`,children:`›`})]}),U&&W.length===0&&U.diff.unhighlightable>0&&(0,Q.jsxs)(`span`,{"data-testid":`page-changes-unhighlightable`,children:[`(`,U.diff.unhighlightable,` `,U.diff.unhighlightable===1?`change`:`changes`,` not highlightable)`]}),U&&(0,Q.jsx)(yr,{summary:U.summary,truncated:U.diff.truncated}),Ut&&(0,Q.jsx)(`span`,{"data-testid":`page-summary-changed`,children:`The summary above was updated too.`})]}),U&&(U.summary.removed.length>0||U.summary.removedSections.length>0)&&(0,Q.jsxs)(`details`,{className:`text-2xs`,"data-testid":`page-changes-removed`,children:[(0,Q.jsxs)(`summary`,{className:`cursor-pointer text-text-muted`,children:[`Removed since v`,U.base.version,` (not on the page any more)`]}),(0,Q.jsx)(`div`,{className:`pt-1`,children:(0,Q.jsx)(br,{summary:U.summary})})]})]}),l.refused&&!a&&(0,Q.jsxs)(`div`,{className:`px-3 py-2 rounded-lg border border-accent-amber/40 bg-accent-amber/10 text-xs text-text-primary`,role:`status`,"data-testid":`page-file-refused`,children:[`A later save to`,` `,(0,Q.jsx)(`code`,{className:`font-mono`,children:l.refused.sourcePath}),l.refused.cause===`gate`?(0,Q.jsxs)(Q.Fragment,{children:[` was not recorded: `,l.refused.message,`. You are still looking at v`,e.version,`.`]}):(0,Q.jsxs)(Q.Fragment,{children:[` could not be recorded: `,l.refused.message,`. You are still looking at v`,e.version,`.`]})]}),(0,Q.jsxs)(`div`,{className:L?`fixed inset-0 z-40 overflow-y-auto overflow-x-hidden bg-surface-primary p-2 sm:p-3 space-y-3`:`space-y-3`,role:L?`region`:void 0,"aria-label":L?`${e.title||`Page`} — expanded review`:void 0,"data-testid":`page-review-area`,"data-expanded":L?`true`:`false`,onKeyDown:e=>{!L||e.key!==`Escape`||e.defaultPrevented||(e.preventDefault(),e.stopPropagation(),ut(!1))},children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,"data-testid":`page-view-bar`,children:[(0,Q.jsx)(`button`,{type:`button`,onClick:()=>ut(e=>!e),"aria-pressed":L,title:L?`Back to the normal view (Esc)`:`Fill the window with the page and its review`,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary pointer-coarse:min-h-11`,"data-testid":`page-expand-toggle`,children:L?`Collapse`:`Expand`}),(0,Q.jsx)(Se,{open:dt,onOpenChange:R}),mt&&(0,Q.jsx)(`span`,{"data-testid":`page-theme-note`,children:ht?`The page supports dark mode, so it's shown dark.`:`The page is shown as authored (light).`})]}),!a&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,"data-testid":`page-pointing-bar`,children:[(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>ot(e=>!e),"aria-pressed":F,"aria-describedby":Ft,"aria-keyshortcuts":`Control+I Meta+I`,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,title:(F?`Clicks point at the page (${xi()} to switch). Hold ⌘/Ctrl to let one click through; switch off to let every click reach the page.`:`Clicks reach the page (${xi()} to switch). Switch on to point at things.`)+` After Run, use this toggle or press ${xi()} outside the page.`,children:[F?`Pointing: on`:`Pointing: off`,(0,Q.jsx)(`kbd`,{className:`ml-1 font-mono text-[9px] text-text-muted`,children:xi()})]}),(0,Q.jsxs)(`button`,{type:`button`,onClick:Jt,disabled:k,"aria-pressed":I,"aria-keyshortcuts":`C`,title:k?`Comment mode isn't available once the page's scripts run. Click or select text to comment.`:`Comment without a mouse: arrow keys or Tab move between blocks in the page, Enter comments on one, Escape leaves (C)`,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary pointer-coarse:min-h-11 disabled:opacity-50 disabled:cursor-not-allowed`,"data-testid":`page-kbd-toggle`,children:[I?`Comment mode: on`:`Comment mode: off`,(0,Q.jsx)(`kbd`,{className:`ml-1 font-mono text-[9px] text-text-muted`,children:`C`})]}),(0,Q.jsxs)(`span`,{id:Ft,"data-testid":`page-pointing-hint`,children:[F?`Click anything on the page, or select text, to comment on that spot. In-page links, summaries, radio/checkbox tabs and form fields still work — Alt/Option-click to comment on one.`:`Pointing is off: clicks go to the page. Turn it on to comment on a spot.`,I&&` Comment mode: arrow keys or Tab move between blocks, Enter comments, Escape leaves.`,k&&` Scripts are running: to switch pointing, use this toggle or press ${xi()} outside the page.`]})]}),(0,Q.jsx)(li,{diagnostics:H}),(0,Q.jsx)(nr,{asks:P,answered:sn,checking:fn,readOnly:a,onJump:pn,onReply:gn}),(0,Q.jsxs)(`div`,{className:`@container`,ref:qe,"data-review-layout":M?`rail`:`below`,children:[Y.length>0&&(0,Q.jsx)(`div`,{className:`@3xl:hidden mb-2`,children:(0,Q.jsx)(er,{..._n,variant:`disclosure`})}),(0,Q.jsxs)(`div`,{className:`grid gap-3 items-start grid-cols-1 ${Y.length>0?`@3xl:grid-cols-[14rem_minmax(0,1fr)]`:``}`,style:M?{gridTemplateColumns:`${Y.length>0?`14rem `:``}minmax(0,1fr) 18rem`}:void 0,"data-testid":`page-review-grid`,children:[Y.length>0&&(0,Q.jsx)(`div`,{className:`hidden @3xl:block self-stretch`,children:(0,Q.jsx)(er,{..._n,variant:`rail`})}),(0,Q.jsxs)(`div`,{className:`min-w-0 relative`,ref:Ye,"data-testid":`page-frame-box`,children:[(0,Q.jsx)(Oe,{html:t.html,maxBytes:se,staticFirst:!0,noun:`page`,frameClassName:`w-full ${L?`h-[calc(100dvh-8rem)] min-h-[320px]`:`h-[70vh] min-h-[320px] sm:min-h-[420px]`} rounded border border-border-default ${gt?`bg-surface-secondary [color-scheme:dark]`:`bg-white [color-scheme:light]`}`,annotation:yi,iframeRef:n,onRunningChange:zt,onDocChange:Rt}),Z&&(0,Q.jsxs)(`div`,{role:`tooltip`,className:`absolute z-20 pointer-events-none max-w-xs px-2 py-1.5 rounded border border-border-default bg-surface-elevated shadow-lg text-2xs space-y-0.5`,style:kn,"data-testid":`page-pin-preview`,children:[(0,Q.jsxs)(`div`,{className:`flex items-center gap-1.5 text-text-muted`,children:[(0,Q.jsxs)(`span`,{className:`font-semibold text-text-secondary`,children:[`#`,Z.index+1]}),(0,Q.jsx)(`span`,{children:Ar(Z.state).text}),Z.replies>0&&(0,Q.jsxs)(`span`,{children:[`· `,Z.replies,` `,Z.replies===1?`reply`:`replies`]})]}),(0,Q.jsx)(`p`,{className:`text-text-primary line-clamp-3 break-words`,children:mi(Z.comment.content)})]})]}),(0,Q.jsxs)(`div`,{className:M?`sticky top-2 max-h-[calc(70vh+2rem)] overflow-y-auto space-y-3 pr-0.5`:`col-span-full space-y-3`,role:M?`complementary`:void 0,"aria-label":`Review`,"data-testid":`page-review-column`,"data-placement":M?`rail`:`below`,children:[Cn,En(M?`rail`:`below`)]})]})]})]}),(0,Q.jsx)(`div`,{role:`status`,"aria-live":`polite`,"aria-atomic":`true`,className:`sr-only`,"data-testid":`page-live-region`,children:ft}),(0,Q.jsx)(je,{artifact:e})]})}export{Ei as PageArtifact};