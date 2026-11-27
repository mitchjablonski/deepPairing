import{a as e}from"./chunk-Dy9vhvp_.js";import{t}from"./react-MiZfE901.js";import{t as n}from"./jsx-runtime-DRdVPR4T.js";import{n as r,o as i,s as a}from"./api-BRSI0TD2.js";import{S as o,h as s,s as c}from"./artifact-y_dPz51v.js";import{a as l,d as u,n as d,o as f,r as p,s as m,t as h,u as g}from"./schemas-DIAwpD5w.js";import{C as _,D as v,E as y,H as b,I as x,J as ee,O as te,S,T as ne,b as C,et as re,k as ie,q as ae,v as w,w as oe,x as se,y as T}from"./dist-CUuuoFnR.js";import{f as ce,t as le}from"./useOfflineReason-D5t9U6aK.js";import{C as ue,T as de,_ as fe,g as pe,j as me,m as he,v as ge}from"./index-CyjEI_pX.js";import{r as _e,t as ve}from"./mermaidRendererProtocol-Tplhn0By.js";import{t as ye}from"./PrototypeFrame-B4VD5pSA.js";import{t as be}from"./ConceptBadge-rezfmVSx.js";import{r as xe}from"./NeverSuggestControl-DDS2_bqx.js";import{t as Se}from"./ArtifactStatusActions-Q_Xr1mPe.js";var E=e(t(),1),Ce=String.raw`
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
`,we=String.raw`
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
/** Badge spots, in the pin box's coordinates (the box is the anchor +2px on
 *  every side): outside top-left (preferred: never on the element itself),
 *  outside top-right, then inside the anchor's top-left / top-right corners. */
function badgeSpots(r, bw) {
  var w = r.width + 4;
  return [[-20, -20], [w + 2, -20], [4, 4], [w - 4 - bw, 4]];
}
/** Place the badge on the first spot that is fully inside the viewport
 *  horizontally (and not above the document's top) AND clear of native
 *  controls; else the first spot that is on screen (it stays inert); else
 *  clamp it to the viewport edge. Returns badgeCoversNative() for the spot
 *  chosen, so a badge over a control is never live. */
function placeBadge(badge, r) {
  var bw = Math.max(18, badge.offsetWidth || 0);
  var vw = window.innerWidth || document.documentElement.clientWidth || 0;
  var sy = window.scrollY || window.pageYOffset || 0;
  var spots = badgeSpots(r, bw), fallback = null;
  function fits(s) {
    var x = r.left - 2 + s[0], y = r.top - 2 + s[1];
    return x >= 0 && (!vw || x + bw <= vw) && y + sy >= 0;
  }
  function put(s) { important(badge, { left: s[0] + "px", top: s[1] + "px" }); }
  for (var i = 0; i < spots.length; i++) {
    if (!fits(spots[i])) continue;
    put(spots[i]);
    if (!badgeCoversNative(badge)) return false;
    if (!fallback) fallback = spots[i];
  }
  if (!fallback) {
    // Nothing fits (e.g. an anchor scrolled partly out horizontally): clamp
    // the outside-top-left spot into the viewport and the document.
    var x = Math.min(Math.max(r.left - 22, 0), vw ? Math.max(vw - bw, 0) : Infinity);
    var y = Math.max(r.top - 22, -sy);
    fallback = [x - (r.left - 2), y - (r.top - 2)];
  }
  put(fallback);
  return badgeCoversNative(badge);
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
    important(badge, { position: "absolute", left: "-20px", top: "-20px", display: "block", "box-sizing": "border-box",
      "min-width": "18px", height: "18px", padding: "0 4px", "border-radius": "9px", background: color,
      color: "#111", font: "600 11px/18px system-ui, sans-serif", "text-align": "center",
      "pointer-events": "none", cursor: "default" });
    pin.appendChild(badge);
    l.appendChild(pin);
    var ok = !!id && !!badgeIds && !!badgeOk && !placeBadge(badge, r);
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
`,D=`(function(){try{var core=(function(document,window){`+Ce+`
})(document,window);(function(document,window,parent,core){`+we+`
})(document,window,window.parent,core);}catch(e){}})();`,Te=new Set(S);function Ee(e){let t=e.replace(/[\x00-\x20\x7f-\x9f]/g,``).toLowerCase();return t.startsWith(`javascript:`)||t.startsWith(`vbscript:`)||t.startsWith(`data:text/html`)||t.startsWith(`data:application/xhtml`)}function De(e){for(let t of Array.from(e.attributes)){let n=t.name.toLowerCase();if(n.startsWith(`on`)){e.removeAttribute(t.name);continue}(n===`srcdoc`||Ee(t.value))&&e.removeAttribute(t.name)}}var Oe=[`class`,`dir`,`lang`,`style`];function ke(e){return!/url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding|\\/i.test(e)}function O(e){let t={};if(!e)return t;for(let n of Oe){let r=e.getAttribute(n);r==null||r===``||n===`dir`&&!/^(ltr|rtl|auto)$/i.test(r.trim())||n===`style`&&!ke(r)||(t[n]=r)}return t}function Ae(e){let t=[],n=e.documentElement?[e.documentElement]:[];for(;n.length;){let e=n.pop();t.push(e);let r=e.childNodes;for(let e=r.length-1;e>=0;e--){let t=r[e];t.nodeType===1&&n.push(t)}}return t}function k(e){if(typeof DOMParser>`u`)return{html:``,htmlAttrs:{},bodyAttrs:{}};let t=new DOMParser().parseFromString(e,`text/html`);for(let e of Ae(t))Te.has(e.localName.toLowerCase())&&e.remove();for(let e of Array.from(t.querySelectorAll(`script`)))e.remove();for(let e of Array.from(t.getElementsByTagNameNS(`*`,`script`)))e.remove();for(let e of Array.from(t.querySelectorAll(`meta`)))(e.getAttribute(`http-equiv`)??``).trim().toLowerCase()===`refresh`&&e.remove();for(let e of Ae(t)){let t=e.localName.toLowerCase();t!==`set`&&!t.startsWith(`animate`)||(Array.from(e.attributes).find(e=>e.name.toLowerCase()===`attributename`)?.value??``).toLowerCase().includes(`href`)&&e.remove()}for(let e of Ae(t))De(e);return{html:t.head.innerHTML+t.body.innerHTML,htmlAttrs:O(t.documentElement),bodyAttrs:O(t.body)}}var je=class extends Error{constructor(){super(`render aborted`),this.name=`RendererAbortError`}},Me=class extends Error{},A=class extends Error{constructor(){super(`diagram renderer unavailable`),this.name=`RendererUnavailableError`}},j=class extends Error{constructor(){super(`diagram renderer did not load in time`),this.name=`RendererColdError`}},Ne=class extends Error{constructor(){super(`diagram renderer could not load in this tab`),this.name=`RendererExhaustedError`}},Pe=class{frame=null;ready=null;markReady=null;failReady=null;readyTimer=null;unavailable;readyMisses=0;backoffUntil=0;pending=null;unlisten=null;chain=Promise.resolve();seq=0;framesCreated=0;constructor(e){this.deps=e,this.unavailable=!!e.unavailable,this.render=Object.assign((e,t,n,r,i)=>{let a=this.blockedError();if(a)return Promise.reject(a);let o=()=>this.renderOne(e,t,n,r,i),s=this.chain.then(o,o);return this.chain=s.catch(()=>void 0),s},{reportsStart:!0})}render;blockedError(){return this.unavailable?new A:this.readyMisses>=(this.deps.maxReadyMisses??3)?new Ne:!this.frame&&Date.now()<this.backoffUntil?new j:null}dispose(){this.destroyFrame(new je),this.unlisten?.(),this.unlisten=null}onMessage=e=>{if(!this.frame||e.source!==this.frame.target)return;let t=_e.safeParse(e.data);if(!t.success)return;let n=t.data;if(n.type===`dp-mermaid-ready`){this.readyTimer&&clearTimeout(this.readyTimer),this.readyTimer=null,this.readyMisses=0,this.markReady?.();return}let r=this.pending;!r||n.reqId!==r.reqId||(this.pending=null,n.type===`dp-mermaid-result`?r.resolve(n.svg):r.reject(new Me(n.error)))};ensureFrame(){if(this.unlisten||=this.deps.listen(this.onMessage),this.frame&&this.ready)return this.ready;this.ready=new Promise((e,t)=>{this.markReady=e,this.failReady=t}),this.ready.catch(()=>void 0);try{this.frame=this.deps.createFrame()}catch{this.unavailable=!0;let e=this.ready;return this.destroyFrame(new A),e}return this.framesCreated++,this.readyTimer=setTimeout(()=>{this.readyTimer=null,this.readyMisses++,this.backoffUntil=Date.now()+(this.deps.readyBackoffMs??3e4);let e=this.readyMisses>=(this.deps.maxReadyMisses??3);this.destroyFrame(e?new Ne:new j)},this.deps.readyTimeoutMs??1e4),this.ready}destroyFrame(e){let t=this.pending;if(this.pending=null,this.readyTimer&&clearTimeout(this.readyTimer),this.readyTimer=null,this.failReady?.(e),this.frame)try{this.frame.destroy()}catch{}this.frame=null,this.ready=null,this.markReady=null,this.failReady=null,t?.reject(e)}renderOne(e,t,n,r,i){if(r?.aborted)return Promise.reject(new je);let a=this.blockedError();return a?Promise.reject(a):new Promise((a,o)=>{let s=`r${++this.seq}`,c=!1,l=e=>{c||(c=!0,r?.removeEventListener(`abort`,u),e())},u=()=>{this.destroyFrame(new je),l(()=>o(new je))};r?.addEventListener(`abort`,u,{once:!0}),this.ensureFrame().then(()=>{if(c||!this.frame)return;this.pending={reqId:s,resolve:e=>l(()=>a(e)),reject:e=>l(()=>o(e))};let r={type:`dp-mermaid-render`,reqId:s,id:e,source:t,theme:n};this.frame.target.postMessage(r,`*`),i?.()},e=>l(()=>o(e)))})}};function Fe(){let e=document.createElement(`iframe`);e.setAttribute(`sandbox`,`allow-scripts`),e.setAttribute(`aria-hidden`,`true`),e.setAttribute(`tabindex`,`-1`),e.setAttribute(`title`,`Diagram renderer`),e.setAttribute(`data-dp-mermaid-renderer`,``),e.style.cssText=`position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none`,e.src=ve,document.body.appendChild(e);let t=e.contentWindow;if(!t)throw e.remove(),new Me(`renderer frame has no window`);return{target:t,destroy:()=>e.remove()}}function Ie(e){let t=t=>e({source:t.source,data:t.data});return window.addEventListener(`message`,t),()=>window.removeEventListener(`message`,t)}function M(e){return e===`http:`||e===`https:`}var Le=null;function Re(){return Le||=new Pe({createFrame:Fe,listen:Ie,unavailable:!M(typeof location>`u`?void 0:location.protocol)}),Le}var ze=`pre.mermaid, div.mermaid, code.language-mermaid`;function Be(e){return/mermaid/i.test(e)}function N(e){return!Be(e)||typeof DOMParser>`u`?!1:Qe(new DOMParser().parseFromString(e,`text/html`)).some(e=>(e.textContent??``).trim()!==``)}var Ve=new Set(`svg.g.path.rect.circle.ellipse.line.polyline.polygon.text.tspan.textpath.defs.marker.style.title.desc.lineargradient.radialgradient.stop.clippath.mask.pattern.symbol.use.foreignobject.switch.filter.feblend.fecolormatrix.fecomposite.fedropshadow.feflood.fegaussianblur.femerge.femergenode.feoffset`.split(`.`)),He=new Set([`div`,`span`,`p`,`br`,`b`,`strong`,`i`,`em`,`u`,`s`,`code`,`sub`,`sup`,`small`,`mark`,`pre`,`ul`,`ol`,`li`]),Ue=new Set([...S,`style`,`link`,`meta`,`title`,`img`,`picture`,`source`,`video`,`audio`,`track`,`svg`,`math`,`form`,`input`,`button`,`textarea`,`select`,`option`,`canvas`]),We=new Set([`class`,`dir`,`xmlns`,`style`]),P=new Set([`src`,`srcdoc`,`action`,`formaction`,`xml:base`,`background`]);function Ge(e){let t=e.indexOf(`url(`);for(;t!==-1;){let n=t+4;for(;n<e.length&&/\s/.test(e[n]);)n++;for((e[n]===`"`||e[n]===`'`)&&n++;n<e.length&&/\s/.test(e[n]);)n++;if(e[n]!==`#`)return!0;t=e.indexOf(`url(`,t+4)}return!1}function Ke(e){if(e.includes(`\\`))return null;let t=e.toLowerCase();return/@import|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|image-set\s*\(|image\s*\(|cross-fade\s*\(|\bsrc\s*\(|<\//.test(t)||Ge(t)?null:e}function qe(e){return e===`href`||e.endsWith(`:href`)}function F(e){for(let t of Array.from(e.attributes)){let n=t.name.toLowerCase(),r=t.value,i=!0;if(n.startsWith(`on`)||P.has(n))i=!1;else if(qe(n))i=r.trim().startsWith(`#`);else if(n===`style`){let n=Ke(r);n===null?i=!1:n!==r&&e.setAttribute(t.name,n)}else (Ee(r)||r.toLowerCase().includes(`url(`)&&Ge(r.toLowerCase()))&&(i=!1);i||e.removeAttribute(t.name)}}function Je(e){for(let t of Array.from(e.attributes)){let n=t.name.toLowerCase();if(!We.has(n)){e.removeAttribute(t.name);continue}if(n===`style`){let n=Ke(t.value);n===null?e.removeAttribute(t.name):n!==t.value&&e.setAttribute(t.name,n)}}}function Ye(e){let t=e.parentNode;if(t){for(;e.firstChild;)t.insertBefore(e.firstChild,e);e.remove()}}function Xe(e){let t=[{el:e,inHtml:!1}];for(;t.length;){let{el:n,inHtml:r}=t.pop(),i=n.localName.toLowerCase();if(n!==e)if(r){if(Ue.has(i)){n.remove();continue}if(!He.has(i)){let e=Array.from(n.children);Ye(n);for(let n of e)t.push({el:n,inHtml:r});continue}Je(n)}else{if(i===`a`){let e=Array.from(n.children);Ye(n);for(let n of e)t.push({el:n,inHtml:r});continue}if(!Ve.has(i)){n.remove();continue}if(i===`style`){let e=Ke(n.textContent??``);if(e===null){n.remove();continue}n.textContent=e;for(let e of Array.from(n.attributes))n.removeAttribute(e.name);continue}F(n)}else F(n);let a=r||i===`foreignobject`;for(let e of Array.from(n.children))t.push({el:e,inHtml:a})}}function Ze(e){if(typeof DOMParser>`u`)return null;let t=new DOMParser().parseFromString(`<!doctype html><html><body>${e}</body></html>`,`text/html`).body.firstElementChild;return!t||t.localName.toLowerCase()!==`svg`?null:(Xe(t),t)}function Qe(e){let t=[];for(let n of Array.from(e.querySelectorAll(ze))){let e=n,r=n.parentElement;n.localName===`code`&&r?.localName===`pre`&&r.children.length===1&&(r.textContent??``).trim()===(n.textContent??``).trim()&&(e=r),!t.some(t=>t===e||t.contains(e))&&t.push(e)}return t}var I={failed:`Diagram couldn't be rendered; showing its source.`,tooLarge:`Diagram couldn't be rendered: its source is too large; showing it as text.`,tooMany:`Diagram couldn't be rendered: this page has more diagrams than the companion renders; showing its source.`,timedOut:`Diagram took too long to render; showing its source. Reopen the page to retry.`,unavailable:`Diagrams render in the browser companion; showing source here.`,exhausted:`Diagrams couldn't load in this tab; reload to retry.`};function L(e,t,n){let r=e.createElement(`div`);r.setAttribute(`data-dp-mermaid-note`,``),r.setAttribute(`role`,`note`),r.setAttribute(`style`,`font:12px/1.4 system-ui,sans-serif;color:#92400e;margin:2px 0 8px`),r.textContent=n,t.after(r)}function R(e){return e===`dark`?`margin:8px 0;padding:8px;border-radius:6px;background:#1f2020;overflow-x:auto`:`margin:8px 0;padding:8px 0;overflow-x:auto`}var $e=class extends Error{};function et(e,t,n,r,i,a){let o=new AbortController;return new Promise((s,c)=>{let l,u=()=>{c(new $e),o.abort()},d=setTimeout(u,a),f=()=>{l===void 0&&(l=setTimeout(u,i))},p=()=>{clearTimeout(d),l!==void 0&&clearTimeout(l)};e.reportsStart||f(),Promise.resolve().then(()=>e(t,n,r,o.signal,f)).then(e=>{p(),s(e)},e=>{p(),c(e)})})}function z(e){return`dp-page-mermaid-${e}`}async function B(e,t){let n={html:e,rendered:0,fallback:0,timedOut:0};if(!Be(e)||typeof DOMParser>`u`)return n;let r=new DOMParser().parseFromString(e,`text/html`),i=Qe(r);if(i.length===0)return n;let a=t.renderer??Re().render,o=t.maxDiagrams??20,s=t.maxSourceChars??2e4,c=t.maxSvgChars??1048576,l=t.timeoutMs??5e3,u=Date.now()+(t.totalTimeoutMs??15e3),d=0,f=0,p=0,m=0;for(let e=0;e<i.length;e++){let n=i[e],h=(n.textContent??``).trim();if(!h)continue;if(e>=o){L(r,n,I.tooMany),f++;continue}if(h.length>s){L(r,n,I.tooLarge),f++;continue}let g=u-Date.now();if(g<=0){L(r,n,I.timedOut),f++,p++;continue}let _;try{_=await et(a,z(e),h,t.theme,l,g)}catch(e){let t=e instanceof $e||e instanceof j,i=e instanceof Ne,a=i||e instanceof A;L(r,n,t?I.timedOut:i?I.exhausted:a?I.unavailable:I.failed),f++,t&&p++,a&&m++;continue}let v=typeof _==`string`&&_.length<=c?Ze(_):null;if(!v){L(r,n,typeof _==`string`&&_.length>c?I.tooLarge:I.failed),f++;continue}let y=r.createElement(`div`);y.setAttribute(`class`,`dp-mermaid-render`),y.setAttribute(`data-dp-mermaid`,`rendered`),y.setAttribute(`style`,R(t.theme)),n.id&&(y.id=n.id),y.appendChild(r.importNode(v,!0)),n.replaceWith(y),d++}return d===0&&f===0?n:{html:r.documentElement.outerHTML,rendered:d,fallback:f,timedOut:p,...m?{unavailable:m}:{}}}var tt=Promise.resolve();function V(e){let t=tt.then(e,e);return tt=t.catch(()=>void 0),t}var H=8,U=new Map;function nt(e){let t=2166136261,n=5381;for(let r=0;r<e.length;r++){let i=e.charCodeAt(r);t=Math.imul(t^i,16777619),n=Math.imul(n,33)+i|0}return`${e.length}:${(t>>>0).toString(36)}:${(n>>>0).toString(36)}`}function rt(e,t,n){let r=`${t}|${nt(e)}`,i=U.get(r);if(i&&i.input===e&&i.theme===t)return U.delete(r),U.set(r,i),i.out;let a={input:e,theme:t,out:Promise.resolve(e)};for(a.out=V(()=>B(e,{theme:t,renderer:n})).then(e=>((e.timedOut>0||(e.unavailable??0)>0)&&U.get(r)===a&&U.delete(r),e.html),()=>(U.get(r)===a&&U.delete(r),e)),U.set(r,a);U.size>H;)U.delete(U.keys().next().value);return a.out}var it={needed:N,run:(e,t)=>rt(e,t)},at=2e4,W=50,ot=32,st=80,ct=new Set([`h1`,`h2`,`h3`,`h4`,`h5`,`h6`,`p`,`li`,`tr`,`figure`,`pre`,`blockquote`,`dt`,`dd`,`summary`,`caption`,`button`,`label`,`legend`]),G=new Set([`h1`,`h2`,`h3`,`h4`,`h5`,`h6`]),lt=new Set([`div`,`section`,`article`,`aside`,`header`,`footer`,`main`,`nav`,`details`]),K=new Set(`a.abbr.b.bdi.bdo.cite.code.data.del.dfn.em.font.i.ins.kbd.mark.q.s.samp.small.span.strong.sub.sup.time.u.var.wbr.img.svg`.split(`.`));function q(e){return e.replace(/\s+/g,` `).trim()}function ut(e){return e===` `||e===`
`||e===`	`||e===`\r`||e===`\f`}function J(e){return!!e&&!!e.closest(`script,style,noscript,template,iframe,frame,frameset,object,embed,applet,portal,dp-annotator-layer`)}var dt=e=>e===`td`||e===`th`;function ft(e){for(let t=e.previousElementSibling;t;t=t.previousElementSibling)if(dt(t.localName.toLowerCase()))return!0;return!1}var pt={submit:`Submit`,reset:`Reset`,button:``},mt=new Set([``,`text`,`search`,`email`,`url`,`tel`,`number`]);function ht(e){let t=(e.getAttribute(`type`)??``).trim().toLowerCase();return Object.prototype.hasOwnProperty.call(pt,t)?e.getAttribute(`value`)??pt[t]:mt.has(t)?e.getAttribute(`value`)??``:``}var gt=class{text=``;lastSpace=!0;space(){this.lastSpace||=(this.text+=` `,!0)}cell(){this.space(),this.text+=`| `,this.lastSpace=!0}chars(e,t=1/0){for(let n=0;n<e.length;n++){let r=e.charAt(n);if(ut(r)?this.space():(this.text+=r,this.lastSpace=!1),this.text.length>t)return!0}return!1}element(e,t=1/0){let n=e.localName.toLowerCase();if(n===`br`)this.space();else if(dt(n))ft(e)&&this.cell();else if(n===`input`)return this.chars(ht(e),t);return!1}};function Y(e){let t=q(e.getAttribute(`alt`)||e.getAttribute(`aria-label`)||e.getAttribute(`title`)||e.getAttribute(`value`)||``);if(!t){let n=e.getElementsByTagName(`img`);for(let e=0;e<n.length&&!t;e++)J(n[e])||(t=q(n[e].getAttribute(`alt`)||``))}return t}function _t(e,t=280){let n=e.ownerDocument.createTreeWalker(e,5),r=new gt,i;for(;i=n.nextNode();){if(i.nodeType===1){if(J(i))continue;if(r.element(i,t))break;continue}if(!J(i.parentElement)&&r.chars(i.nodeValue??``,t))break}let a=q(r.text);return a||=Y(e),a.length>t?a.slice(0,t):a}function vt(e){if(typeof DOMParser>`u`)return null;try{return new DOMParser().parseFromString(e,`text/html`)}catch{return null}}var yt=3;function bt(e,t=at){let n=e.body??e.documentElement;if(!n)return{blocks:[],truncated:!1};let r=Array.from(n.getElementsByTagName(`*`)),i=new Map,a=new Map,o=new Set;for(let e=r.length-1;e>=0;e--){let t=r[e],n=t.localName.toLowerCase();if(J(t))continue;let s=i.get(t)??0,c=ct.has(n)||lt.has(n)&&s===0;c&&o.add(t);let l=s+(c?1:0),u=(a.get(t)??0)+(G.has(n)?1:0);t.parentElement&&(l&&i.set(t.parentElement,(i.get(t.parentElement)??0)+l),u&&a.set(t.parentElement,(a.get(t.parentElement)??0)+u))}let s=[],c=new Map,l=e=>{for(let t=e;t;t=t.parentElement)if(o.has(t))return t;return null},u=e=>{let t=e;for(;t&&t!==n&&K.has(t.localName.toLowerCase());)t=t.parentElement;return t??n},d=null,f=0,p=e.createTreeWalker(n,5),m,h=e=>{let t=u(e);return(!d||d.el!==t)&&(d={el:t,buf:new gt,pos:f,synthetic:!0},s.push(d)),d};for(;m=p.nextNode();){if(f++,m.nodeType===1){let e=m;if(J(e))continue;let t=e.localName.toLowerCase();if(o.has(e)){let t={el:e,buf:new gt,pos:f,synthetic:!1};s.push(t),c.set(e,t)}if(!K.has(t)&&t!==`br`&&t!==`input`&&(d=null),t===`br`||dt(t)||t===`input`){let n=l(e.parentElement);n?c.get(n).buf.element(e):(t===`input`?ht(e).trim():d)&&h(e.parentElement).buf.element(e)}continue}let e=m.parentElement;if(J(e))continue;let t=m.nodeValue??``,n=l(e);if(n){c.get(n).buf.chars(t);continue}!t.trim()&&!d||h(e).buf.chars(t)}s.sort((e,t)=>e.pos-t.pos);let g=[],_=``,v=-1,y=!1,b=[],x=``;for(let e of s){let n=e.el,r=q(e.buf.text);if(!r&&!e.synthetic){let e=n.getElementsByTagName(`img`);for(let t=0;t<e.length&&!r;t++)J(e[t])||(r=q(e[t].getAttribute(`alt`)||``))}if(!r)continue;if(g.length>=t){y=!0;break}let o=n.localName.toLowerCase(),s=!e.synthetic&&G.has(o);if(s){_=r.length>st?`${r.slice(0,st-1)}…`:r,v=g.length;let e=Number(o.slice(1));for(;b.length&&b[b.length-1].level>=e;)b.pop();b.push({level:e,text:_}),x=b.map(e=>e.text).join(` › `)}let c={tag:o,text:r,section:_,sectionId:v,sectionPath:x,heading:s,el:n};e.synthetic&&(c.synthetic=!0,(o===`body`||o===`html`||o===`main`||(i.get(n)??0)>yt||(a.get(n)??0)>1)&&(c.unlocatable=!0)),g.push(c)}return{blocks:g,truncated:y}}function xt(e){let t=e.body??e.documentElement;if(!t)return``;let n=e.createTreeWalker(t,5),r=new gt,i;for(;i=n.nextNode();){if(i.nodeType===1){let e=i;if(J(e))continue;let t=e.localName.toLowerCase();(ct.has(t)||lt.has(t))&&r.space(),r.element(e);continue}J(i.parentElement)||r.chars(i.nodeValue??``)}return q(r.text)}function St(e){let t=[],n=Array(e.length).fill(-1);for(let r=0;r<e.length;r++){let i=0,a=t.length;for(;i<a;){let n=i+a>>1;e[t[n]]<e[r]?i=n+1:a=n}i>0&&(n[r]=t[i-1]),t[i]=r}let r=[],i=t.length?t[t.length-1]:-1;for(;i!==-1;)r.push(i),i=n[i];return r.reverse()}function Ct(e,t,n,r,i,a,o){let s=n-t,c=a-i,l=c+1,u=new Uint32Array((s+1)*l);for(let n=s-1;n>=0;n--)for(let a=c-1;a>=0;a--)u[n*l+a]=e[t+n]===r[i+a]?u[(n+1)*l+a+1]+1:Math.max(u[(n+1)*l+a],u[n*l+a+1]);let d=0,f=0;for(;d<s&&f<c;)e[t+d]===r[i+f]?(o.push([t+d,i+f]),d++,f++):u[(d+1)*l+f]>=u[d*l+f+1]?d++:f++}function wt(e,t,n,r,i,a,o){let s=new Map;for(let r=t;r<n;r++){let t=s.get(e[r]);t?t.idx.push(r):s.set(e[r],{idx:[r],p:0})}let c=t-1;for(let e=i;e<a;e++){let t=s.get(r[e]);if(t){for(;t.p<t.idx.length&&t.idx[t.p]<=c;)t.p++;t.p<t.idx.length&&(c=t.idx[t.p],t.p++,o.push([c,e]))}}}function Tt(e,t,n,r,i,a,o,s){for(;t<n&&i<a&&e[t]===r[i];)s.push([t++,i++]);let c=[];for(;t<n&&i<a&&e[n-1]===r[a-1];)c.push([--n,--a]);if(t<n&&i<a)if((n-t)*(a-i)<=12e4)Ct(e,t,n,r,i,a,s);else{let c=new Map;for(let r=t;r<n;r++){let t=c.get(e[r]);t?t.ca++:c.set(e[r],{ca:1,cb:0,ia:r})}let l=[],u=[];for(let e=i;e<a;e++){let t=c.get(r[e]);t&&t.cb++}for(let e=i;e<a;e++){let t=c.get(r[e]);t&&t.ca===1&&t.cb===1&&(l.push(e),u.push(t.ia))}if(u.length===0||o>=ot)wt(e,t,n,r,i,a,s);else{let c=t,d=i;for(let t of St(u)){let n=u[t],i=l[t];Tt(e,c,n,r,d,i,o+1,s),s.push([n,i]),c=n+1,d=i+1}Tt(e,c,n,r,d,a,o+1,s)}}for(let e=c.length-1;e>=0;e--)s.push(c[e])}function Et(e,t){let n=[];return Tt(e,0,e.length,t,0,t.length,0,n),n}var Dt=e=>`${e.tag}\u0001${e.text}`;function Ot(e,t){let n=e.map(Dt),r=t.map(Dt),i=Et(n,r),a=new Uint8Array(n.length),o=new Uint8Array(r.length);for(let[e,t]of i)a[e]=1,o[t]=1;let s=[...i],c=new Map;for(let e=0;e<n.length;e++){if(a[e])continue;let t=c.get(n[e]);t?t.push(e):c.set(n[e],[e])}let l=new Set;for(let e=0;e<r.length;e++){if(o[e])continue;let t=c.get(r[e]);if(!t||!t.length)continue;let n=t.shift();a[n]=1,o[e]=1,s.push([n,e]),l.add(e)}let u=new Map,d=[],f=new Map,p=[[-1,-1],...i,[n.length,r.length]];for(let n=0;n+1<p.length;n++){let[r,i]=p[n],[s,c]=p[n+1],l=[],m=[];for(let e=r+1;e<s;e++)a[e]||l.push(e);for(let e=i+1;e<c;e++)o[e]||m.push(e);if(!l.length&&!m.length)continue;let h=new Set,g=(n,r)=>{h.add(n),u.set(r,{kind:`changed`,block:t[r],previous:e[n]}),e[n].heading&&t[r].heading&&f.set(n,r)},_=new Map;for(let t of l){let n=e[t],r=`${n.tag}\u0001${n.heading?``:n.section}`,i=_.get(r);i?i.push(t):_.set(r,[t])}let v=[];for(let e of m){let n=t[e],r=_.get(`${n.tag}\u0001${n.heading?``:n.section}`),i;for(;r&&r.length&&i===void 0;){let e=r.shift();h.has(e)||(i=e)}i===void 0?v.push(e):g(i,e)}let y=l.filter(e=>!h.has(e)),b=Math.min(y.length,v.length);for(let n=0;n<b;n++){let r=y[n],i=v[n];e[r].tag===t[i].tag&&g(r,i)}for(let e of v)u.has(e)||u.set(e,{kind:`added`,block:t[e]});for(let t of l)h.has(t)||d.push(e[t])}for(let[n,r]of s)e[n].heading&&t[r].heading&&f.set(n,r);let m=(e,t)=>e.sectionId<0||t.sectionId<0?e.sectionId<0&&t.sectionId<0:f.get(e.sectionId)===t.sectionId,h=0;for(let[n,r]of s){let i=e[n],a=t[r];if(a.heading){l.has(r)&&h++;continue}m(i,a)?l.has(r)&&h++:u.set(r,{kind:`moved`,block:a,previous:i})}return{changes:[...u.entries()].sort((e,t)=>e[0]-t[0]).map(([,e])=>e),removed:d,moved:h}}function kt(e,t){let n=new Map,r=[];for(let{el:i,kind:a}of t){let t=i.localName.toLowerCase(),o=n.get(t);if(!o){o=new Map;let r=new Map,i=e.getElementsByTagName(t);for(let e=0;e<i.length;e++){let t=i[e];if(J(t))continue;let n=_t(t),a=r.get(n)??0;r.set(n,a+1),o.set(t,{text:n,occurrence:a})}n.set(t,o)}let s=o.get(i);!s||!s.text||r.push({kind:a,tag:t,text:s.text,occurrence:s.occurrence})}return r}var X=[];function At(e,t){return X.find(n=>n.oldHtml===e&&n.newHtml===t)?.diff}function jt(e,t){let n=X.find(n=>n.oldHtml===e&&n.newHtml===t);if(n)return n.diff;let r=Mt(e,t);return X.unshift({oldHtml:e,newHtml:t,diff:r}),X.length>4&&X.pop(),r}function Mt(e,t){let n=vt(e),r=vt(t);if(!n||!r)return null;let i=e===t,a=bt(n),o=bt(r),s=i?{changes:[],removed:[],moved:0}:Ot(a.blocks,o.blocks),c=s.changes.length===0&&s.removed.length===0&&s.moved===0,l=!i&&c&&xt(n)!==xt(r),u=[],d=new Set,f=0;for(let e of s.changes){let t=e.block.el;if(!t||e.block.unlocatable){f++;continue}d.has(t)||(d.add(t),u.push({el:t,kind:e.kind}))}let p=[];for(let e of Array.from(r.querySelectorAll(`[data-dp-changed]`)).slice(0,W))d.has(e)||J(e)||(d.add(e),p.push({el:e,kind:`hinted`}));let m=[...u,...p].slice(0,300);return{...s,truncated:a.truncated||o.truncated,identical:i,textChangedOutsideBlocks:l,marks:kt(r,m),changeMarksTotal:u.length,hintMarksTotal:p.length,unhighlightable:f}}var Nt={p:[`paragraph`,`paragraphs`],li:[`list item`,`list items`],tr:[`table row`,`table rows`],pre:[`code block`,`code blocks`],blockquote:[`quote`,`quotes`],figure:[`figure`,`figures`],dt:[`term`,`terms`],dd:[`definition`,`definitions`]};function Pt(e,t){let[n,r]=Nt[e.size===1?[...e][0]:``]??[`block`,`blocks`];return t===1?n:r}var Ft=``;function It(e){let t=[],n=[],r=[];for(let n of e.changes)n.kind===`added`&&n.block.heading&&!t.includes(n.block.section)&&t.push(n.block.section);for(let i of e.changes){if(i.kind===`moved`&&i.previous){let e=i.previous.section===i.block.section;r.push({text:i.block.text,from:e&&i.previous.sectionPath||i.previous.section,to:e&&i.block.sectionPath||i.block.section})}let e=i.block.section;t.includes(e)||n.includes(e)||n.push(e)}let i=new Set(e.removed.filter(e=>e.heading).map(e=>e.sectionId)),a=new Map;for(let t of e.removed)t.heading&&a.set(t.sectionId,{section:t.section,sectionId:t.sectionId,texts:[],noun:``,tags:new Set});let o=new Map;for(let t of e.removed){if(t.heading)continue;if(i.has(t.sectionId)){let e=a.get(t.sectionId);e.texts.push(t.text),e.tags.add(t.tag);continue}let e=o.get(t.sectionId);e||o.set(t.sectionId,e={section:t.section,tags:new Set,texts:[]}),e.tags.add(t.tag),e.texts.push(t.text)}let s=[...a.values()].map(({tags:e,...t})=>({...t,noun:Pt(e,t.texts.length)})),c=[...o.entries()].map(([e,t])=>({section:t.section,sectionId:e,count:t.texts.length,noun:Pt(t.tags,t.texts.length),texts:t.texts}));return{state:e.changes.length>0||e.removed.length>0||e.moved>0?`changes`:e.identical?`identical`:e.textChangedOutsideBlocks?`outside-blocks`:`markup-only`,changedSections:n,addedSections:t,removedSections:s,removed:c,movedAcross:r,movedCount:e.moved,changeCount:e.changes.length}}function Lt(e){return e===Ft?`Top of page`:e}function Rt(e,t=6){let n=e.slice(0,t).map(Lt);return e.length>t?`${n.join(`, `)} and ${e.length-t} more`:n.join(`, `)}function zt(e,t=60){return e.length>t?`${e.slice(0,t-1)}…`:e}var Bt={identical:`Page content unchanged.`,"markup-only":`No change found in the compared text (attributes, styling and live form state aren't compared).`,"outside-blocks":`Text changed outside recognised blocks.`};function Vt(e){if(e.state!==`changes`)return Bt[e.state];let t=[];if(e.changedSections.length&&t.push(`Changed: ${Rt(e.changedSections)}`),e.addedSections.length&&t.push(`Added: ${Rt(e.addedSections)}`),e.movedAcross.length){let n=e.movedAcross.slice(0,3).map(e=>`“${zt(e.text)}” from ${Lt(e.from)} to ${Lt(e.to)}`);e.movedAcross.length>3&&n.push(`${e.movedAcross.length-3} more`),t.push(`Moved: ${n.join(`, `)}`)}let n=[];for(let t of e.removedSections.slice(0,4))n.push(`section ${Lt(t.section)}${t.texts.length?` (${t.texts.length} ${t.noun})`:``}`);e.removedSections.length>4&&n.push(`${e.removedSections.length-4} more sections`);for(let t of e.removed.slice(0,4))n.push(`${t.count} ${t.noun} ${t.section===Ft?`at the top of the page`:`under ${t.section}`}`);return e.removed.length>4&&n.push(`more in ${e.removed.length-4} other sections`),n.length&&t.push(`Removed: ${n.join(`, `)}`),e.movedCount&&t.push(`${e.movedCount} ${e.movedCount===1?`block`:`blocks`} moved`),t.join(`; `)}function Z(e,t){if(!t||e.source!==t)return null;let n=e.data;return!n||typeof n!=`object`||Array.isArray(n)?null:n}function Ht(e,t){let n=Z(e,t);if(!n||n.dp!==`anchor`)return null;let r=ee.safeParse(n.anchor);return r.success?r.data:null}var Ut=500,Wt=g().regex(/^[0-9a-z:]{1,64}$/);function Gt(e,t){let n=Z(e,t);if(!n||n.dp!==`pins-status`)return null;let r=n.found;if(!Array.isArray(r)||r.length>Ut||!r.every(e=>typeof e==`boolean`))return null;let i=Wt.safeParse(n.key);return i.success?{found:r,key:i.data}:{found:r}}function Kt(e,t){let n=Z(e,t);return!!n&&n.dp===`ready`}function qt(e,t){let n=Z(e,t);return!!n&&n.dp===`toggle-pointing`}var Jt=m({kind:h([`added`,`changed`,`moved`,`hinted`]),tag:g().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/),text:g().min(1).max(280),occurrence:f().int().min(0).max(1e6)}).strict(),Yt=m({dp:l(`changes`),marks:d(Jt).max(300),show:p()}).strict();function Xt(e,t){let n=[];for(let t of e.slice(0,300)){let e=Jt.safeParse(t);e.success&&n.push(e.data)}return Yt.parse({dp:`changes`,marks:n,show:t})}function Zt(e,t){let n=Z(e,t);if(!n||n.dp!==`changes-status`)return null;let r=n.found;return!Array.isArray(r)||r.length>300||!r.every(e=>typeof e==`boolean`)?null:r}var Qt=g().min(1).max(ae.locator),$t=f().int().min(-1).max(199),en=m({level:u([l(1),l(2),l(3)]),text:g().min(1).max(120),locator:Qt}).strict(),tn=m({dp:l(`outline`),headings:d(en).max(200),pins:d($t).max(500),changes:d($t).max(300)}).strict().superRefine((e,t)=>{for(let[n,r]of[[`pins`,e.pins],[`changes`,e.changes]])r.some(t=>t>=e.headings.length)&&t.addIssue({code:`custom`,path:[n],message:`section index out of range`})});function nn(e,t){let n=Z(e,t);if(!n||n.dp!==`outline`)return null;let r=tn.safeParse(n);return r.success?r.data:null}function rn(e,t){let n=Z(e,t);if(!n||n.dp!==`outline-active`)return null;let r=$t.safeParse(n.index);return r.success?r.data:null}var an=m({kind:h([`decision`,`question`]),text:g().max(T.text),locator:Qt,id:g().min(1).max(T.id).optional()}).strict(),on=m({dp:l(`asks`),asks:d(an).max(T.max),pinAsks:d(f().int().min(-1).max(T.max-1)).max(500),key:Wt.optional()}).strict().superRefine((e,t)=>{e.pinAsks.some(t=>t>=e.asks.length)&&t.addIssue({code:`custom`,path:[`pinAsks`],message:`ask index out of range`})});function sn(e,t){let n=Z(e,t);if(!n||n.dp!==`asks`)return null;let r=on.safeParse(n);return r.success?r.data:null}function cn(e){let t=ee.safeParse({kind:`element`,locator:e.locator,quote:e.text});return t.success?t.data:null}var ln=h([`open`,`addressed`]),un=g().min(1).max(128);function dn(e,t,n,r){let i=Math.min(e.length,Ut),a=[],o=[];for(let e=0;e<i;e++){a.push(ln.safeParse(t[e]).success?t[e]:`open`);let r=n[e];o.push(typeof r==`string`&&un.safeParse(r).success?r:``)}let s=r!==void 0&&Wt.safeParse(r).success?{key:r}:{};return{dp:`pins`,anchors:e.slice(0,i),states:a,ids:o,...s}}function fn(e,t){let n=Z(e,t);if(!n||n.dp!==`pin-click`)return null;let r=un.safeParse(n.id);return r.success?r.data:null}var pn=m({x:f().finite().min(-1e4).max(1e5),y:f().finite().min(-1e4).max(1e5)}).strict();function mn(e,t){let n=Z(e,t);if(!n||n.dp!==`pin-hover`)return;if(n.id===null)return{id:null};let r=un.safeParse(n.id),i=pn.safeParse({x:n.x,y:n.y});return r.success&&i.success?{id:r.data,at:i.data}:void 0}var Q=n(),hn=(e,t,n)=>`${e} ${e===1?t:n}`;function gn(e,t){return e.map((n,r)=>{let i=t[r]??0,a=i;for(let i=r+1;i<e.length&&e[i].level>n.level;i++)a+=t[i]??0;return{total:a,own:i}})}function _n(e,t,n){if(e.total===0)return``;let r=e.total-e.own;return r>0?`${hn(e.total,t,n)} (${e.own} in this section, ${r} in subsections)`:hn(e.total,t,n)}function vn({headings:e,commentCounts:t,changeCounts:n,active:r,onJump:i,variant:a}){let o=Math.min(...e.map(e=>e.level)),s=gn(e,t),c=gn(e,n);return(0,Q.jsx)(`ol`,{className:`space-y-0.5`,"data-testid":`page-outline-list-${a}`,children:e.map((e,t)=>{let n=s[t].total,a=c[t].total,l=t===r,u=[e.text,_n(s[t],`open comment`,`open comments`),_n(c[t],`changed block`,`changed blocks`),l?`you are here`:``].filter(Boolean).join(`, `);return(0,Q.jsx)(`li`,{style:{paddingLeft:`${(e.level-o)*.75}rem`},children:(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>i(t),"aria-current":l?`location`:void 0,"aria-label":`Go to ${u}`,title:e.text,className:`w-full flex items-center gap-1.5 text-left px-1.5 py-0.5 rounded text-2xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${l?`bg-accent-blue-dim/40 text-text-primary font-semibold border-l-2 border-accent-blue`:`text-text-secondary hover:bg-surface-elevated border-l-2 border-transparent`}`,"data-testid":`page-outline-entry`,"data-level":e.level,children:[(0,Q.jsx)(`span`,{className:`flex-1 min-w-0 truncate`,children:e.text}),n>0&&(0,Q.jsx)(`span`,{"aria-hidden":`true`,className:`shrink-0 px-1 rounded-full bg-accent-amber text-[10px] font-semibold text-black`,"data-testid":`page-outline-comments`,children:n}),a>0&&(0,Q.jsxs)(`span`,{"aria-hidden":`true`,className:`shrink-0 px-1 rounded-full border border-accent-violet/60 text-[10px] font-semibold text-accent-violet`,"data-testid":`page-outline-changes`,children:[`~`,a]})]})},t)})})}function yn(e,t,n){let r=e>=0?n[e]:void 0;return r?`Section ${e+1} of ${t}: ${r.text}`:`Top of the page (${hn(t,`section`,`sections`)})`}function bn(e){let{headings:t,active:n,variant:r}=e;if(t.length===0)return null;let i=yn(n,t.length,t);return r===`disclosure`?(0,Q.jsxs)(`details`,{className:`rounded-lg border border-border-default text-2xs`,"data-testid":`page-outline-disclosure`,children:[(0,Q.jsxs)(`summary`,{className:`cursor-pointer px-2 py-1 text-text-secondary`,children:[`Outline `,(0,Q.jsxs)(`span`,{className:`text-text-muted`,children:[`· `,i]})]}),(0,Q.jsx)(`nav`,{"aria-label":`Page outline`,className:`px-1 pb-1.5 max-h-64 overflow-y-auto`,children:(0,Q.jsx)(vn,{...e})})]}):(0,Q.jsxs)(`nav`,{"aria-label":`Page outline`,className:`sticky top-2 max-h-[70vh] overflow-y-auto rounded-lg border border-border-default p-1.5 space-y-1`,"data-testid":`page-outline-rail`,children:[(0,Q.jsx)(`div`,{className:`px-1.5 text-2xs font-semibold text-text-muted uppercase tracking-wide`,children:`Outline`}),(0,Q.jsx)(`div`,{className:`px-1.5 text-[10px] text-text-muted`,"data-testid":`page-outline-progress`,children:i}),(0,Q.jsx)(vn,{...e})]})}var xn={decision:`Decide`,question:`Question`};function Sn({asks:e,answered:t,readOnly:n,onJump:r,onReply:i}){if(e.length===0)return null;let a=t.filter(Boolean).length,o=e.length-a;return(0,Q.jsxs)(`section`,{"aria-label":`Wants from you: ${e.length} ${e.length===1?`ask`:`asks`}, ${o} open`,className:`rounded-lg border border-accent-amber/40 bg-accent-amber/5 px-3 py-2 space-y-1.5`,"data-testid":`page-asks`,children:[(0,Q.jsxs)(`h3`,{className:`flex flex-wrap items-baseline gap-2 text-xs font-semibold text-text-primary`,children:[(0,Q.jsxs)(`span`,{children:[`Wants from you (`,e.length,`)`]}),(0,Q.jsxs)(`span`,{className:`text-2xs font-normal text-text-muted`,"data-testid":`page-asks-tally`,children:[o,` open · `,a,` answered`]})]}),(0,Q.jsx)(`ul`,{className:`space-y-1 max-h-60 overflow-y-auto`,children:e.map((e,a)=>{let o=t[a]===!0,s=e.text.trim()||(e.id?`#${e.id}`:`(no text)`);return(0,Q.jsxs)(`li`,{className:`flex flex-wrap items-start gap-2 text-2xs ${o?`opacity-70`:``}`,"data-testid":`page-ask`,"data-answered":o?`true`:`false`,children:[(0,Q.jsx)(`span`,{className:`shrink-0 px-1.5 py-0.5 rounded font-semibold ${e.kind===`decision`?`bg-accent-violet/15 text-accent-violet`:`bg-accent-blue-dim/40 text-accent-blue`}`,children:xn[e.kind]}),(0,Q.jsx)(`span`,{className:`flex-1 min-w-0 text-xs text-text-primary break-words line-clamp-2`,children:s}),(0,Q.jsx)(`span`,{className:`shrink-0 ${o?`text-accent-green`:`text-accent-amber`}`,"data-testid":`page-ask-state`,children:o?`Answered`:`Open`}),(0,Q.jsxs)(`span`,{className:`shrink-0 inline-flex gap-1`,children:[(0,Q.jsx)(`button`,{type:`button`,onClick:()=>r(a),"aria-label":`Show on the page: ${s}`,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,children:`Jump`}),!n&&(0,Q.jsx)(`button`,{type:`button`,onClick:()=>i(a),"aria-label":`Reply to: ${s}`,className:`px-1.5 py-0.5 rounded border border-accent-blue/40 hover:bg-accent-blue-dim/30 text-accent-blue`,children:`Reply`})]})]},`${a}-${e.locator}`)})})]})}var Cn=`[${C}], [${se}]`,wn=`script,style,noscript,template`,Tn=S.join(`,`),En=50,Dn=new Set([...wn.split(`,`),`title`,...S]);function On(e){let t=new w,n=[],r=e=>{for(let t=e.lastChild;t;t=t.previousSibling)n.push({node:t})};for(r(e);n.length>0;){let e=n.pop();if(e.close){t.separate();continue}let i=e.node;if(i.nodeType===3){t.push(i.nodeValue??``);continue}if(i.nodeType!==1)continue;let a=i.localName.toLowerCase();Dn.has(a)||(ne(a)&&(t.separate(),n.push({close:!0})),r(i))}return t.digest()}function kn(e){return(e.getAttribute(`alt`)||e.getAttribute(`aria-label`)||e.getAttribute(`title`)||e.getAttribute(`value`)||``).replace(/\s+/g,` `).trim()}function An(e,t){let n=e.ownerDocument.createTreeWalker(e,4),r=``,i=!0;for(let e=n.nextNode();e&&!(r.length>t);e=n.nextNode()){let n=e.parentElement,a=e.nodeValue??``;if(!(n&&n.closest(wn))){for(let e of a)if(/\s/.test(e)?i||=(r+=` `,!0):(r+=e,i=!1),r.length>t)break}}let a=r.replace(/\s+/g,` `).trim(),o=kn(e);a||=o;let s=On(e)??(o?_(o):void 0);return{text:a.length>t?a.slice(0,t):a,...s?{fullHash:s}:{}}}function jn(e){let t=vt(e);if(!t)return null;let n=[];for(let e of Array.from(t.querySelectorAll(Cn))){if(n.length>=T.max)break;if(e.closest(Tn))continue;let t=e.id;if(!t||t.length>T.id)continue;let r=[];for(let t of Array.from(e.querySelectorAll(`[id]`))){if(r.length>=En)break;t.closest(Cn)===e&&t.id&&t.id.length<=T.id&&r.push(t.id)}n.push({id:t,...An(e,T.text),...r.length?{childIds:r}:{}})}return n}var $=new Map,Mn=50;function Nn(e){if(!$.has(e))return;let t=$.get(e);return $.delete(e),$.set(e,t),t}function Pn(e,t){let n=Nn(e);if(n!==void 0)return n;let r=jn(t);return $.set(e,r),$.size>Mn&&$.delete($.keys().next().value),r}function Fn(e,t){let n=t?e.map(e=>e.id).join(`\0`):``,[r,i]=(0,E.useState)(0);return(0,E.useEffect)(()=>{if(!n)return;let t=e.filter(e=>Nn(e.id)===void 0);if(t.length===0)return;let r=!1,a=()=>{if(!r){for(let e of t)Pn(e.id,x(e.content).html);r||i(e=>e+1)}},o=window;if(typeof o.requestIdleCallback==`function`){let e=o.requestIdleCallback(a,{timeout:400});return()=>{r=!0,o.cancelIdleCallback?.(e)}}let s=setTimeout(a,0);return()=>{r=!0,clearTimeout(s)}},[n]),(0,E.useMemo)(()=>{let e=new Set(n?n.split(`\0`):[]);return t=>e.has(t)?Nn(t)??void 0:void 0},[n,r])}function In(e){let t=s(e=>e.artifacts);return(0,E.useMemo)(()=>{let n=[];if(e.type!==`page`)return n;let r=new Set([e.id]),i=e.parentId;for(;i&&!r.has(i);){r.add(i);let e=t.find(e=>e.id===i);if(!e||e.type!==`page`)break;n.push({artifact:e,autoSave:!!b(e.fileWatch).recorded}),i=e.parentId}return n},[t,e.id,e.parentId,e.type])}function Ln(e,t){let n=t?.type===`page`?x(t.content).html:null,r=e.type===`page`?x(e.content).html:null,i=t&&n!==null&&r!==null?`${t.id}\u0000${e.id}`:null,[a,o]=(0,E.useState)(null),s=i&&n!==null&&r!==null?At(n,r):void 0;(0,E.useEffect)(()=>{if(!i||n===null||r===null||At(n,r)!==void 0)return;let e=!1,t=()=>{if(e)return;let t=jt(n,r);e||o({key:i,diff:t})},a=window;if(typeof a.requestIdleCallback==`function`){let n=a.requestIdleCallback(t,{timeout:400});return()=>{e=!0,a.cancelIdleCallback?.(n)}}let s=setTimeout(t,0);return()=>{e=!0,clearTimeout(s)}},[i,n,r]);let c=s===void 0?a&&a.key===i?a.diff:void 0:s;return{changes:(0,E.useMemo)(()=>t&&c?{base:t,diff:c,summary:It(c)}:null,[t,c]),pending:!!i&&c===void 0}}var Rn=(e,t=160)=>e.length>t?`${e.slice(0,t-1)}…`:e;function zn({summary:e,truncated:t}){return(0,Q.jsxs)(`span`,{className:`text-2xs text-text-secondary`,"data-testid":`page-change-summary-line`,"data-state":e.state,children:[Vt(e),t?` (Very large page: only the first part was compared.)`:``]})}function Bn({summary:e}){return(0,Q.jsxs)(`ul`,{className:`space-y-1`,"data-testid":`page-removed-list`,children:[e.removedSections.map(e=>(0,Q.jsxs)(`li`,{"data-testid":`page-removed-section`,children:[(0,Q.jsxs)(`span`,{className:`text-text-secondary`,children:[`Section `,(0,Q.jsx)(`span`,{className:`font-medium`,children:Lt(e.section)}),e.texts.length>0?` (${e.texts.length} ${e.noun})`:``]}),e.texts.length>0&&(0,Q.jsx)(Vn,{texts:e.texts})]},`s-${e.sectionId}`)),e.removed.map(e=>(0,Q.jsxs)(`li`,{"data-testid":`page-removed-group`,children:[(0,Q.jsxs)(`span`,{className:`text-text-secondary`,children:[e.count,` `,e.noun,` `,e.section?`under ${e.section}`:`at the top of the page`]}),(0,Q.jsx)(Vn,{texts:e.texts})]},`g-${e.sectionId}`))]})}function Vn({texts:e}){let t=e.slice(0,8);return(0,Q.jsxs)(`ul`,{className:`pl-3 text-text-muted`,children:[t.map((e,t)=>(0,Q.jsx)(`li`,{className:`line-through opacity-80 break-words`,children:Rn(e)},t)),e.length>t.length&&(0,Q.jsxs)(`li`,{children:[`and `,e.length-t.length,` more`]})]})}var Hn=[`open`,`addressed`,`orphaned`],Un={open:`Open`,addressed:`Addressed`,orphaned:`Orphaned`};function Wn(e,t){let n=new Map;for(let e of t){if(!e.parentCommentId)continue;let t=n.get(e.parentCommentId);t?t.push(e):n.set(e.parentCommentId,[e])}let r=[],i=new Set([e.id]),a=[...n.get(e.id)??[]];for(;a.length;){let e=a.shift();i.has(e.id)||(i.add(e.id),r.push(e),a.push(...n.get(e.id)??[]))}return r}var Gn={human:0,resolve:1,answer:2,revision:3};function Kn(e){if(!e)return;let t=Date.parse(e);return Number.isFinite(t)?t:void 0}function qn(e,t,n,r={}){let i=Kn(e.createdAt)??0,a=[{t:i,kind:`human`}];for(let e of t){let t=Kn(e.createdAt)??i;a.push({t,kind:e.author===`agent`?`answer`:`human`})}e.answeredByCommentId&&!t.some(t=>t.id===e.answeredByCommentId)&&a.push({t:i,kind:`answer`});let o=e.addressedIn;if(o&&Number.isInteger(o.version)&&o.version>0){let e=Kn(o.at)??Kn(r.revisionAt?.(o.artifactId))??i;a.push({t:e,kind:`revision`,version:o.version})}let s=Kn(e.humanResolvedAt);s!==void 0&&a.push({t:s,kind:`resolve`});let c=a[0];for(let e of a)(e.t>c.t||e.t===c.t&&Gn[e.kind]>Gn[c.kind])&&(c=e);return c.kind===`revision`?{kind:`addressed`,via:`revision`,version:c.version}:c.kind===`answer`?{kind:`addressed`,via:`answer`}:c.kind===`resolve`?{kind:`addressed`,via:`resolved`}:n?{kind:`orphaned`}:a.some(e=>e.kind!==`human`)?{kind:`open`,seen:e.acknowledged===!0,reopened:!0}:{kind:`open`,seen:e.acknowledged===!0}}function Jn(e){return e.kind}function Yn(e){return e.kind===`addressed`?`addressed`:`open`}function Xn(e){switch(e.kind){case`addressed`:return e.via===`revision`?{text:`Addressed in v${e.version}`,title:`The agent revised the page and named this comment as addressed in v${e.version}. Check the change yourself.`}:e.via===`answer`?{text:`Answered by the agent`,title:`The agent replied to this comment.`}:{text:`Resolved by you`,title:`You marked this resolved.`};case`orphaned`:return{text:`Not found in this version`,title:`The spot this comment points at is not on this version of the page, and nothing has addressed it.`};case`open`:return e.reopened?{text:`Reopened`,title:`You replied after the agent's answer, the revision that addressed it, or your own resolve, so it's open again.`}:e.seen?{text:`Seen by agent`,title:`The agent has read this comment (check_feedback) but hasn't answered it or named it addressed in a revision.`}:{text:`Open`,title:`Delivered to the session; the agent hasn't acted on it yet.`}}}function Zn(e,t,n,r={}){return e.map((e,i)=>{let a=Wn(e,t),o=n(e,i);return{comment:e,index:i,replies:a.length,missing:o,state:qn(e,a,o,r)}})}function Qn(e){let t={open:0,addressed:0,orphaned:0};for(let n of e)t[Jn(n.state)]++;return t}function $n({anchor:e}){let t=e.quote.trim();return(0,Q.jsxs)(`div`,{className:`space-y-0.5 text-2xs text-text-muted`,"data-testid":`page-anchor-context`,children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-1.5`,children:[(0,Q.jsx)(`span`,{className:`px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary`,children:pe(e.kind)}),t?(0,Q.jsxs)(`span`,{className:`text-text-primary italic break-words`,children:[`“`,t,`”`]}):(0,Q.jsx)(`code`,{className:`font-mono break-all`,children:e.locator})]}),e.table&&(e.table.row||e.table.col)&&(0,Q.jsxs)(`div`,{children:[e.table.row&&(0,Q.jsxs)(Q.Fragment,{children:[`Row `,(0,Q.jsx)(`span`,{className:`text-text-secondary`,children:e.table.row})]}),e.table.row&&e.table.col&&` · `,e.table.col&&(0,Q.jsxs)(Q.Fragment,{children:[`Column `,(0,Q.jsx)(`span`,{className:`text-text-secondary`,children:e.table.col})]})]}),e.nodeId&&(0,Q.jsxs)(`div`,{children:[`Node `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.nodeId})]}),e.href&&(0,Q.jsxs)(`div`,{className:`break-all`,children:[`Link to `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.href})]}),t&&(0,Q.jsxs)(`div`,{className:`break-all`,children:[`at `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.locator})]})]})}function er({n:e,state:t}){let n=t.kind===`addressed`?`bg-text-muted text-black`:t.kind===`orphaned`?`border border-dashed border-accent-amber text-accent-amber bg-transparent`:`bg-accent-amber text-black`;return(0,Q.jsx)(`span`,{"aria-hidden":`true`,className:`shrink-0 w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center ${n}`,"data-testid":`page-annotation-pin`,"data-state":t.kind,children:e})}var tr={open:`text-accent-blue`,addressed:`text-text-muted`,orphaned:`text-accent-amber`};function nr({entries:e,counts:t,filter:n,onFilter:r,highlightId:i,revealNonce:a,focusRow:o,onSelect:s,fromVersion:c,liveStances:l,variant:u}){let d=(0,E.useRef)(null),f=(0,E.useId)();if((0,E.useEffect)(()=>{if(!a||!i)return;let e=Array.from(d.current?.querySelectorAll(`[data-comment-id]`)??[]).find(e=>e.getAttribute(`data-comment-id`)===i);e?.scrollIntoView?.({block:`nearest`,behavior:`smooth`}),o&&e?.focus?.({preventScroll:!0})},[a]),e.length===0)return null;let p=n===`all`?e:e.filter(e=>Jn(e.state)===n),m=[...Hn,`all`];return(0,Q.jsxs)(`section`,{className:`space-y-1.5`,"data-testid":`page-annotations`,"data-variant":u,"aria-label":`Comments on the page`,children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-x-2 gap-y-1`,children:[(0,Q.jsx)(`h3`,{className:`text-2xs font-semibold text-text-muted uppercase tracking-wide`,children:`On the page`}),(0,Q.jsx)(`div`,{className:`flex flex-wrap gap-1`,role:`group`,"aria-label":`Filter comments`,"data-testid":`page-queue-filters`,children:m.map(i=>{let a=i===`all`?e.length:t[i],o=i===`all`?`All`:Un[i];return(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>r(i),"aria-pressed":n===i,className:`px-1.5 py-0.5 rounded border text-2xs ${n===i?`border-accent-blue bg-accent-blue-dim/40 text-text-primary`:`border-border-default text-text-secondary hover:bg-surface-elevated`}`,"data-testid":`page-queue-filter-${i}`,children:[o,` `,(0,Q.jsx)(`span`,{className:`tabular-nums`,children:a})]},i)})})]}),p.length===0?(0,Q.jsx)(`p`,{className:`text-2xs text-text-muted italic`,"data-testid":`page-queue-empty`,children:n===`open`?`Nothing open: every comment has been addressed or is no longer on the page.`:n===`addressed`?`Nothing addressed yet.`:`Every comment's spot is on this version.`}):(0,Q.jsx)(`ol`,{className:`space-y-1.5`,ref:d,children:p.map(({comment:e,index:t,state:n,replies:r,missing:a})=>{let o=e.target.htmlAnchor,u=Xn(n),d=e.id===i,p=c(e);return(0,Q.jsxs)(`li`,{children:[(0,Q.jsx)(`span`,{className:`sr-only`,id:`${f}-state-${t}`,children:u.title}),(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>s(t),"aria-current":d?`true`:void 0,"aria-describedby":`${f}-state-${t}`,className:`w-full text-left flex gap-2 p-2 rounded border hover:bg-surface-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${d?`border-accent-blue ring-1 ring-accent-blue bg-accent-blue-dim/20`:`border-border-default`} ${n.kind===`addressed`?`opacity-75`:``}`,"data-testid":`page-annotation`,"data-comment-id":e.id,"data-state":n.kind,children:[(0,Q.jsx)(er,{n:t+1,state:n}),(0,Q.jsxs)(`span`,{className:`flex-1 min-w-0 space-y-1`,children:[(0,Q.jsxs)(`span`,{className:`sr-only`,children:[`Comment `,t+1,`.`]}),(0,Q.jsxs)(`span`,{className:`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs`,children:[(0,Q.jsx)(`span`,{className:`font-semibold ${tr[Jn(n)]}`,title:u.title,"data-testid":n.kind===`orphaned`?`page-anchor-missing`:`page-annotation-state`,children:u.text}),r>0&&(0,Q.jsxs)(`span`,{className:`text-text-muted`,"data-testid":`page-annotation-replies`,children:[r,` `,r===1?`reply`:`replies`]}),p!=null&&(0,Q.jsxs)(`span`,{className:`text-text-muted italic`,children:[`from v`,p]})]}),(0,Q.jsx)($n,{anchor:o}),e.ruleOut&&l.has(e.ruleOut.description)&&(0,Q.jsxs)(`span`,{className:`block text-2xs text-accent-red`,"data-testid":`page-annotation-ruled-out`,children:[`Ruled out: Claude won't present a page that still contains “`,e.ruleOut.description,`”`]}),e.ruleOut&&!l.has(e.ruleOut.description)&&(0,Q.jsx)(`span`,{className:`block text-2xs text-text-muted`,"data-testid":`page-annotation-ruled-out-retired`,children:`Was ruled out; that stance has since been retired`}),a&&n.kind!==`orphaned`&&(0,Q.jsx)(`span`,{className:`block text-2xs text-text-muted`,"data-testid":`page-anchor-gone`,children:`Its spot is no longer on this version of the page.`}),(0,Q.jsx)(`span`,{className:`block text-xs text-text-primary line-clamp-3`,children:e.content})]})]})]},e.id)})})]})}function rr({artifactId:e,anchor:t,ruledOut:n,onRecorded:o}){let c=le(),l=te(t.quote),u=l.ok?l.key:null,d=l.ok?null:v[l.reason],[f,p]=(0,E.useState)(!1),[m,h]=(0,E.useState)(``);ce(`page-rule-out:${e}:${t.locator}`,m);let[g,_]=(0,E.useState)(!1),[y,b]=(0,E.useState)(null),[x,ee]=(0,E.useState)(null),S=o?n??null:x??n??null,ne=(0,E.useRef)(null),C=(0,E.useRef)(!1);(0,E.useEffect)(()=>{!f&&C.current&&(C.current=!1,ne.current?.focus())},[f]);let re=()=>{C.current=!0,p(!1),h(``),b(null)},ie=m.trim(),ae=async()=>{if(!(c||g||!ie||!u)){_(!0),b(null);try{let n=s.getState().owningSession(e),c=await i(`${r()}/api/artifacts/${encodeURIComponent(e)}/rule-out`,{method:`POST`,headers:a(n),body:JSON.stringify({htmlAnchor:t,reason:ie})}),l=null;try{l=await c.json()}catch{}l?.comment?.id&&s.getState().addComment(l.comment),ee(l?.description??u),o?.(l?.description??u),p(!1),h(``)}catch(e){b(e instanceof Error?e.message:`Couldn't save that. Try again.`)}finally{_(!1)}}};if(S)return(0,Q.jsxs)(`p`,{className:`text-2xs text-accent-red`,role:`status`,"data-testid":`page-rule-out-recorded`,children:[`✓ Ruled out “`,S,`”. Claude won't present a page that still contains this text in this project. You can retire it in the Ledger.`]});if(!f)return(0,Q.jsxs)(`span`,{className:`inline-flex flex-wrap items-center justify-end gap-1.5`,children:[d&&(0,Q.jsx)(`span`,{className:`text-2xs text-text-muted`,"data-testid":`page-rule-out-unavailable`,children:d}),(0,Q.jsx)(`button`,{ref:ne,type:`button`,onClick:()=>p(!0),disabled:!u,title:d??`Remember this text as rejected, so Claude won't present a page that still contains it in this project`,className:`px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-accent-red hover:bg-accent-red-dim/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`,children:`Rule this out`})]});let w=`page-rule-out-reason-${e}`;return(0,Q.jsxs)(`div`,{role:`group`,"aria-label":`Rule this out`,className:`w-full p-2 bg-surface-secondary border border-accent-red/30 rounded-lg`,"data-testid":`page-rule-out-panel`,onKeyDown:e=>{e.key===`Escape`&&!e.defaultPrevented&&(e.preventDefault(),re())},children:[(0,Q.jsxs)(`label`,{htmlFor:w,className:`block text-2xs text-text-muted mb-1.5`,children:[`Rule out “`,(0,Q.jsx)(`span`,{className:`text-text-primary`,children:u}),`”? Claude won't present a page that still contains this text in this project. It only applies to pages, and this page's status doesn't change (you can retire the stance later in the Ledger). Why are you ruling it out? (required)`]}),(0,Q.jsx)(`textarea`,{id:w,rows:2,autoFocus:!0,value:m,onChange:e=>h(e.target.value),onKeyDown:e=>{e.key===`Enter`&&(e.metaKey||e.ctrlKey)&&(e.preventDefault(),ae()),e.key===`Escape`&&(e.preventDefault(),re())},placeholder:`Your reason (Claude sees it when the gate refuses this text)…`,className:`w-full px-2 py-1.5 bg-surface-primary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none`}),y&&(0,Q.jsx)(`p`,{className:`mt-1 text-2xs text-accent-red`,role:`alert`,children:y}),(0,Q.jsxs)(`div`,{className:`flex gap-1.5 mt-1.5 justify-end`,children:[(0,Q.jsx)(`button`,{type:`button`,onClick:re,className:`px-2 py-1 text-2xs text-text-muted hover:text-text-secondary cursor-pointer`,children:`Cancel`}),(0,Q.jsx)(`button`,{type:`button`,title:c??(ie?void 0:`Say why first`),onClick:()=>void ae(),disabled:g||!!c||!ie,className:`px-2 py-1 text-2xs text-text-inverse bg-accent-red hover:bg-accent-red/80 rounded press-scale cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`,children:`Rule it out`})]})]})}var ir=1152;function ar(e,t){let[n,r]=(0,E.useState)(!1);return(0,E.useLayoutEffect)(()=>{let n=e.current;if(!n||typeof ResizeObserver!=`function`)return;let i=()=>r(n.getBoundingClientRect().width>=t);i();let a=new ResizeObserver(i);return a.observe(n),()=>a.disconnect()},[e,t]),n}var or=(e,t,n)=>Math.min(Math.max(e,t),Math.max(t,n)),sr=320;function cr(e){let t=e.trim().replace(/\s+/g,` `);return t.length>200?`${t.slice(0,200)}…`:t}var lr={script:D,sanitize:k,prepare:it},ur=[];function dr(){let e=typeof navigator<`u`&&navigator.platform||``;return/Mac|iPhone|iPad|iPod/.test(e)?`⌘I`:`Ctrl+I`}function fr(e){return(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&(e.key===`i`||e.key===`I`)}function pr(e){return e.filter(e=>fe(`page`,e)).slice().sort((e,t)=>e.createdAt.localeCompare(t.createdAt))}function mr({artifact:e}){let t=x(e.content),n=(0,E.useRef)(null),r=o(e=>e.active),i=me(e.status,r),a=i===`closed`||i===`frozen`,l=b(e.fileWatch),u=(0,E.useMemo)(()=>new Set((b(e.fileWatch).recorded?.orphaned??[]).map(e=>e.commentId)),[e.fileWatch]),d=de(e.id),{rows:f,remember:p}=xe(s(t=>t.owningSession(e.id))),m=(0,E.useMemo)(()=>new Set(f.map(e=>e.description)),[f]),h=(0,E.useMemo)(()=>pr(d),[d]),g=(0,E.useMemo)(()=>h.map(e=>e.id).join(`\0`),[h]),v=(0,E.useMemo)(()=>_(g)??`0`,[g]),ee=(0,E.useMemo)(()=>h.map(e=>e.target.htmlAnchor),[h]),te=(0,E.useMemo)(()=>h.map(e=>e.id),[h]),S=s(e=>e.artifacts),ne=(0,E.useMemo)(()=>({revisionAt:e=>S.find(t=>t.id===e)?.createdAt}),[S]),C=h.map(e=>Yn(qn(e,Wn(e,d),!1,ne))).join(`,`),ae=(0,E.useMemo)(()=>C?C.split(`,`):[],[C]),[w,se]=(0,E.useState)(null),T=(0,E.useRef)(w);T.current=w;let[ce,le]=(0,E.useState)(0),[fe,pe]=(0,E.useState)(!1),_e=(0,E.useRef)(null),[ve,Ce]=(0,E.useState)(0),we=(0,E.useRef)(null),D=(0,E.useRef)(e.id);D.current=e.id;let Te=(0,E.useCallback)(e=>!e||e!==n.current||!e.isConnected||document.activeElement!==e||e.closest(`[inert]`)?!1:s.getState().selectedArtifactId===D.current,[]),Ee=(0,E.useRef)(Te);Ee.current=Te;let[De,Oe]=(0,E.useState)(null),ke=De&&De.forId===e.id&&De.key===v?De.found:null,[O,Ae]=(0,E.useState)(!1),k=(0,E.useMemo)(()=>Zn(h,d,(e,t)=>ke?ke[t]===!1:u.has(e.id),ne),[h,d,ke,u,ne]),je=(0,E.useMemo)(()=>Qn(k),[k]),[Me,A]=(0,E.useState)(null),j=Me??(je.open>0?`open`:`all`),[Ne,Pe]=(0,E.useState)(null),[Fe,Ie]=(0,E.useState)({nonce:0,focus:!1}),[M,Le]=(0,E.useState)(null),Re=(0,E.useRef)(k);Re.current=k;let ze=(0,E.useRef)(j);ze.current=j;let Be=(0,E.useRef)(null),N=ar(Be,ir),Ve=(0,E.useRef)(N);Ve.current=N;let He=(0,E.useRef)(null),[Ue,We]=(0,E.useState)(null);(0,E.useLayoutEffect)(()=>{if(!M)return;let e=He.current,t=()=>{let t=n.current;if(!e||!t)return We(null);let r=e.getBoundingClientRect(),i=t.getBoundingClientRect();We({top:i.top-r.top,left:i.left-r.left,width:i.width,height:i.height})};if(t(),!e||typeof ResizeObserver!=`function`)return;let r=new ResizeObserver(t);return r.observe(e),()=>r.disconnect()},[M,N,O]);let[P,Ge]=(0,E.useState)(null),[Ke,qe]=(0,E.useState)(-1),[F,Je]=(0,E.useState)([]),[Ye,Xe]=(0,E.useState)(null),[Ze,Qe]=(0,E.useState)(null);(0,E.useEffect)(()=>{Ge(null),qe(-1),Je([]),Xe(null),Qe(null)},[e.id]);let[I,L]=(0,E.useState)(!0),R=In(e),[$e,et]=(0,E.useState)(null),z=($e&&$e.forId===e.id?R.find(e=>e.artifact.id===$e.baseId):void 0)??R[0],{changes:B,pending:tt}=Ln(e,z?.artifact),V=B?.diff.marks??ur,[H,U]=(0,E.useState)(!0),[nt,rt]=(0,E.useState)(null),[it,at]=(0,E.useState)(-1);(0,E.useEffect)(()=>{rt(null),at(-1)},[V]);let W=(0,E.useCallback)(e=>{n.current?.contentWindow?.postMessage(e,`*`)},[]),ot=(0,E.useCallback)(()=>W(dn(ee,ae,te,v)),[W,ee,ae,te,v]),st=(0,E.useCallback)(()=>W({dp:`mode`,annotate:I,scripts:O}),[W,I,O]),ct=(0,E.useCallback)(()=>W(Xt(V,H&&V.length>0)),[W,V,H]),G=(0,E.useRef)({sendPins:ot,sendMode:st,sendChanges:ct});G.current={sendPins:ot,sendMode:st,sendChanges:ct};let lt=(0,E.useRef)(!0);lt.current=I;let K=(0,E.useRef)(O);K.current=O;let q=(0,E.useRef)(null),ut=(0,E.useId)();(0,E.useEffect)(()=>{function t(t){let r=n.current,i=r?.contentWindow,o=Ht(t,i);if(o){if(a||!lt.current||!Ee.current(r))return;_e.current=r,se({...o,version:e.version}),pe(!1),le(e=>e+1),Ce(e=>e+1);return}if(Kt(t,i)){G.current.sendMode(),G.current.sendPins(),G.current.sendChanges();return}if(qt(t,i)){!a&&!K.current&&Ee.current(r)&&L(e=>!e);return}let s=Gt(t,i);if(s){Oe({forId:D.current,key:s.key??``,found:s.found}),K.current||Qe({forId:D.current,key:s.key??``,found:s.found});return}let c=fn(t,i);if(c!==null){if(K.current)return;let e=Re.current.find(e=>e.comment.id===c);if(!e)return;let t=Jn(e.state);ze.current!==`all`&&ze.current!==t&&A(t),Pe(e.comment.id),Ie(e=>({nonce:e.nonce+1,focus:Ee.current(r)}));return}let l=mn(t,i);if(l){if(K.current)return;Le(l.id===null?null:l);return}let u=nn(t,i);if(u){K.current||Ge(u);return}let d=rn(t,i);if(d!==null){K.current||qe(d);return}let f=sn(t,i);if(f){K.current||(Je(f.asks),Xe({forId:D.current,key:f.key??``,list:f.pinAsks}));return}let p=Zt(t,i);p&&!K.current&&rt(p)}return window.addEventListener(`message`,t),()=>window.removeEventListener(`message`,t)},[e.version,a]),(0,E.useEffect)(()=>{if(a)return;function e(e){if(e.defaultPrevented||e.repeat||!fr(e))return;let t=e.target,n=t?.tagName;if(n===`INPUT`||n===`TEXTAREA`||n===`SELECT`||t?.isContentEditable===!0)return;let r=q.current;!r||!r.isConnected||r.closest(`[inert]`)||s.getState().selectedArtifactId===D.current&&(e.preventDefault(),L(e=>!e))}return window.addEventListener(`keydown`,e),()=>window.removeEventListener(`keydown`,e)},[a]),(0,E.useEffect)(()=>{ot()},[ot]),(0,E.useEffect)(()=>{st()},[st]),(0,E.useEffect)(()=>{ct()},[ct]),(0,E.useEffect)(()=>{Oe(null),rt(null),Le(null)},[O]),(0,E.useEffect)(()=>{Pe(null),Le(null),A(null)},[e.id]),(0,E.useEffect)(()=>{if(!(!ve||!Te(_e.current))&&(we.current?.querySelector(`textarea`)?.focus?.({preventScroll:!0}),!Ve.current&&T.current)){we.current?.scrollIntoView?.({block:`nearest`});let{version:e,...t}=T.current;W({dp:`focus`,anchor:t,block:`end`})}},[ve,Te,W]);let J=(0,E.useCallback)(e=>Ae(e),[]),dt=e=>{let t=V.length;if(t)for(let n=1;n<=t;n++){let r=(((it<0?e===1?-1:0:it)+e*n)%t+t)%t;if(!(nt&&nt[r]===!1)){at(r),W({dp:`focus-change`,index:r});return}}},ft=nt?nt.filter(Boolean).length:V.length,pt=B?B.diff.changeMarksTotal+B.diff.hintMarksTotal:0,mt=!!z&&(x(z.artifact.content).summary??``).trim()!==(t.summary??``).trim(),ht=e.version>1&&!l.recorded?e.agentReasoning?.trim():``,gt=t=>{let n=ee[t];n&&(W(N?{dp:`focus`,index:t}:{dp:`focus`,index:t,block:`end`}),Pe(h[t]?.id??null),a||(_e.current=null,se({...n,version:e.version}),pe(!0),le(e=>e+1)))},Y=P?.headings??[],_t=(0,E.useMemo)(()=>{let e=P?.headings.length??0,t=Array(e).fill(0),n=Array(e).fill(0);return P?(P.pins.length===h.length&&h.forEach((e,n)=>{let r=P.pins[n];r<0||k[n]?.state.kind!==`open`||(t[r]=(t[r]??0)+1)}),P.changes.length===V.length&&P.changes.forEach(e=>{e>=0&&(n[e]=(n[e]??0)+1)}),{comments:t,changes:n}):{comments:t,changes:n}},[P,h,k,V]),vt=e=>{let t=Y[e];t&&(qe(e),W({dp:`focus-heading`,index:e,locator:t.locator}))},yt=(0,E.useMemo)(()=>{let t=new Set;for(let n of h)n.target.artifactId&&n.target.artifactId!==e.id&&t.add(n.target.artifactId);return t},[h,e.id]),bt=Fn((0,E.useMemo)(()=>[e,...R.map(e=>e.artifact).filter(e=>yt.has(e.id))],[e,R,yt]),F.length>0&&h.length>0),xt=(0,E.useMemo)(()=>{let t={artifactId:e.id,version:e.version},n=t=>t&&t.forId===e.id&&t.key===v?t:null,r=n(Ye)?.list??null,i=n(Ze)?.found??null,a=!!r&&r.length===h.length,o=bt(e.id),s=t=>t===e.id?void 0:bt(t);return F.map((e,n)=>{let c=e.id?o?.find(t=>t.id===e.id):void 0,l={...e,...c?.fullHash?{fullHash:c.fullHash}:{},...c?.childIds?{childIds:c.childIds}:{}};return h.some((e,o)=>y(e,t)?oe(l,e,t,{earlierAsks:s}):i&&i[o]===!1?!1:oe(l,e,t,{insideByFrame:a&&r[o]===n&&i?.[o]===!0}))})},[F,h,v,Ye,Ze,e.id,e.version,bt]),St=e=>{let t=F[e];t&&W({dp:`focus-ask`,index:e,locator:t.locator})},Ct=t=>{let n=F[t],r=n?cn(n):null;!n||!r||a||(W({dp:`focus-ask`,index:t,locator:n.locator}),_e.current=null,se({...r,version:e.version}),pe(!0),le(e=>e+1))},wt={headings:Y,commentCounts:_t.comments,changeCounts:H?_t.changes:[],active:Ke,onJump:vt},Tt=w?d.filter(e=>{if(ge(e.target.htmlAnchor,w))return!0;let t=h.find(t=>t.id===e.parentCommentId);return!!t&&ge(t.target.htmlAnchor,w)}):[],Et=()=>{se(null),n.current?.focus?.()},Dt=e=>{e.key!==`Escape`||e.defaultPrevented||(e.preventDefault(),e.stopPropagation(),Et())},Ot=w&&!a?(0,Q.jsxs)(`div`,{className:`p-3 rounded-lg border border-accent-blue/30 bg-surface-elevated space-y-2`,ref:we,role:`group`,"aria-label":`Comment composer`,onKeyDown:Dt,"data-testid":`page-anchor-composer`,"data-placement":N?`rail`:`below`,children:[(0,Q.jsxs)(`div`,{className:`flex items-start gap-2`,children:[(0,Q.jsx)(`div`,{className:`flex-1 min-w-0`,children:(0,Q.jsx)($n,{anchor:w})}),(0,Q.jsx)(`button`,{type:`button`,onClick:Et,title:`Close (Esc) and return to the page`,className:`text-2xs text-text-muted hover:text-text-secondary`,children:`Close`})]}),(0,Q.jsx)(he,{artifactId:e.id,comments:Tt,target:{htmlAnchor:w},roomy:!0,focusOnOpen:fe,placeholder:`Comment on this spot… (⌘⏎ to send, Esc to return to the page)`,textareaLabel:`Comment on the selected spot`,secondarySubmitLabel:`Ask`,secondarySubmitTitle:`Post as a question about this spot — the agent owes you an answer`},ce),(0,Q.jsx)(`div`,{className:`flex justify-end`,"data-testid":`page-rule-out`,children:(0,Q.jsx)(rr,{artifactId:e.id,anchor:w,ruledOut:(()=>{let e=ie(w.quote);return e&&m.has(e)?e:void 0})(),onRecorded:t=>p({description:t,sourceArtifactId:e.id})},ce)})]}):null,kt=t=>(0,Q.jsx)(nr,{entries:k,counts:je,filter:j,onFilter:A,highlightId:Ne,revealNonce:Fe.nonce,focusRow:Fe.focus,onSelect:gt,fromVersion:t=>c(S,t,e.id),liveStances:m,variant:t}),X=M?k.find(e=>e.comment.id===M.id):void 0,At=M&&X?{left:(Ue?.left??0)+or(M.at.x,0,(Ue?.width??0)-sr),top:(Ue?.top??0)+or(M.at.y+4,0,Ue?.height??M.at.y+4),maxWidth:sr}:void 0;return(0,Q.jsxs)(`div`,{className:`space-y-3`,"data-testid":`page-artifact`,ref:q,children:[t.summary&&(0,Q.jsx)(`div`,{className:`px-4 py-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg`,children:(0,Q.jsx)(ue,{text:t.summary,className:`prose-field text-sm text-text-primary space-y-2`})}),(t.sourcePath||t.concept)&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,children:[t.concept&&(0,Q.jsx)(be,{name:t.concept.name,explanation:t.concept.oneLineExplanation}),t.sourcePath&&(0,Q.jsxs)(`span`,{children:[`From `,(0,Q.jsx)(`code`,{className:`font-mono text-text-secondary`,children:t.sourcePath})]})]}),(ht||l.recorded||z)&&(0,Q.jsxs)(`div`,{className:`px-3 py-2 rounded-lg border border-accent-violet/30 bg-accent-violet/5 space-y-1.5`,"data-testid":`page-version-changes`,children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-baseline gap-x-3 gap-y-1`,children:[ht&&(0,Q.jsxs)(`p`,{className:`text-xs text-text-primary`,"data-testid":`page-revise-reason`,children:[(0,Q.jsxs)(`span`,{className:`font-semibold text-accent-violet`,children:[`Why v`,e.version,`:`]}),` `,ht]}),l.recorded&&(0,Q.jsxs)(`div`,{className:`text-2xs text-text-muted`,"data-testid":`page-file-recorded`,children:[`Recorded automatically from `,(0,Q.jsx)(`code`,{className:`font-mono text-text-secondary`,children:l.recorded.sourcePath}),` after a save, replacing v`,l.recorded.fromVersion,`.`,l.recorded.orphaned.length+(l.recorded.orphanedOverflow??0)>0&&(0,Q.jsxs)(Q.Fragment,{children:[` `,l.recorded.orphaned.length+(l.recorded.orphanedOverflow??0),` earlier comment(s) point at text that is no longer on the page.`]})]})]}),z&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,"data-testid":`page-changes-bar`,children:[(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>U(e=>!e),"aria-pressed":H,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,title:`Mark the blocks that are new, reworded or moved to another section since the version you compare with`,"data-testid":`page-changes-toggle`,children:[`Changes since v`,z.artifact.version,`: `,H?`on`:`off`]}),R.length>1&&(0,Q.jsxs)(`label`,{className:`inline-flex items-center gap-1`,children:[(0,Q.jsx)(`span`,{children:`Compare with`}),(0,Q.jsx)(`select`,{"aria-label":`Compare with`,value:z.artifact.id,onChange:t=>et({forId:e.id,baseId:t.target.value}),className:`bg-surface-elevated border border-border-default rounded px-1 py-0.5 text-text-secondary`,"data-testid":`page-compare-with`,children:R.map(e=>(0,Q.jsxs)(`option`,{value:e.artifact.id,children:[`v`,e.artifact.version,e.autoSave?` (auto-save)`:``]},e.artifact.id))})]}),tt&&(0,Q.jsx)(`span`,{"data-testid":`page-changes-pending`,children:`Comparing…`}),B&&H&&V.length>0&&(0,Q.jsxs)(`span`,{className:`inline-flex items-center gap-1`,"data-testid":`page-changes-nav`,children:[(0,Q.jsxs)(`span`,{"data-testid":`page-changes-count`,children:[ft,` `,ft===1?`highlight`:`highlights`,it>=0&&ft>0?` (at ${it+1})`:``]}),(0,Q.jsxs)(`span`,{className:`text-text-muted`,"data-testid":`page-changes-breakdown`,children:[`(`,B.diff.changeMarksTotal,` `,B.diff.changeMarksTotal===1?`change`:`changes`,B.diff.hintMarksTotal>0?` · ${B.diff.hintMarksTotal} author ${B.diff.hintMarksTotal===1?`hint`:`hints`}`:``,B.diff.unhighlightable>0?` · ${B.diff.unhighlightable} not highlightable`:``,pt>V.length?`; showing ${V.length} of ${pt}`:``,`)`]}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>dt(-1),disabled:ft===0,"aria-label":`Previous highlight`,className:`px-1 rounded border border-border-default hover:bg-surface-elevated disabled:opacity-40`,children:`‹`}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>dt(1),disabled:ft===0,"aria-label":`Next highlight`,className:`px-1 rounded border border-border-default hover:bg-surface-elevated disabled:opacity-40`,children:`›`})]}),B&&V.length===0&&B.diff.unhighlightable>0&&(0,Q.jsxs)(`span`,{"data-testid":`page-changes-unhighlightable`,children:[`(`,B.diff.unhighlightable,` `,B.diff.unhighlightable===1?`change`:`changes`,` not highlightable)`]}),B&&(0,Q.jsx)(zn,{summary:B.summary,truncated:B.diff.truncated}),mt&&(0,Q.jsx)(`span`,{"data-testid":`page-summary-changed`,children:`The summary above was updated too.`})]}),B&&(B.summary.removed.length>0||B.summary.removedSections.length>0)&&(0,Q.jsxs)(`details`,{className:`text-2xs`,"data-testid":`page-changes-removed`,children:[(0,Q.jsxs)(`summary`,{className:`cursor-pointer text-text-muted`,children:[`Removed since v`,B.base.version,` (not on the page any more)`]}),(0,Q.jsx)(`div`,{className:`pt-1`,children:(0,Q.jsx)(Bn,{summary:B.summary})})]})]}),l.refused&&!a&&(0,Q.jsxs)(`div`,{className:`px-3 py-2 rounded-lg border border-accent-amber/40 bg-accent-amber/10 text-xs text-text-primary`,role:`status`,"data-testid":`page-file-refused`,children:[`A later save to`,` `,(0,Q.jsx)(`code`,{className:`font-mono`,children:l.refused.sourcePath}),l.refused.cause===`gate`?(0,Q.jsxs)(Q.Fragment,{children:[` was not recorded: `,l.refused.message,`. You are still looking at v`,e.version,`.`]}):(0,Q.jsxs)(Q.Fragment,{children:[` could not be recorded: `,l.refused.message,`. You are still looking at v`,e.version,`.`]})]}),!a&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,"data-testid":`page-pointing-bar`,children:[(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>L(e=>!e),"aria-pressed":I,"aria-describedby":ut,"aria-keyshortcuts":`Control+I Meta+I`,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,title:(I?`Clicks point at the page (${dr()} to switch). Hold ⌘/Ctrl to let one click through; switch off to let every click reach the page.`:`Clicks reach the page (${dr()} to switch). Switch on to point at things.`)+` After Run, use this toggle or press ${dr()} outside the page.`,children:[I?`Pointing: on`:`Pointing: off`,(0,Q.jsx)(`kbd`,{className:`ml-1 font-mono text-[9px] text-text-muted`,children:dr()})]}),(0,Q.jsxs)(`span`,{id:ut,"data-testid":`page-pointing-hint`,children:[I?`Click anything on the page, or select text, to comment on that spot. In-page links, summaries, radio/checkbox tabs and form fields still work — Alt/Option-click to comment on one.`:`Pointing is off: clicks go to the page. Turn it on to comment on a spot.`,O&&` Scripts are running: to switch pointing, use this toggle or press ${dr()} outside the page.`]})]}),(0,Q.jsx)(Sn,{asks:F,answered:xt,readOnly:a,onJump:St,onReply:Ct}),(0,Q.jsxs)(`div`,{className:`@container`,ref:Be,"data-review-layout":N?`rail`:`below`,children:[Y.length>0&&(0,Q.jsx)(`div`,{className:`@3xl:hidden mb-2`,children:(0,Q.jsx)(bn,{...wt,variant:`disclosure`})}),(0,Q.jsxs)(`div`,{className:`grid gap-3 items-start grid-cols-1 ${Y.length>0?`@3xl:grid-cols-[14rem_minmax(0,1fr)]`:``}`,style:N?{gridTemplateColumns:`${Y.length>0?`14rem `:``}minmax(0,1fr) 18rem`}:void 0,"data-testid":`page-review-grid`,children:[Y.length>0&&(0,Q.jsx)(`div`,{className:`hidden @3xl:block self-stretch`,children:(0,Q.jsx)(bn,{...wt,variant:`rail`})}),(0,Q.jsxs)(`div`,{className:`min-w-0 relative`,ref:He,"data-testid":`page-frame-box`,children:[(0,Q.jsx)(ye,{html:t.html,maxBytes:re,staticFirst:!0,noun:`page`,frameClassName:`w-full h-[70vh] min-h-[420px] rounded border border-border-default bg-white`,annotation:lr,iframeRef:n,onRunningChange:J}),X&&(0,Q.jsxs)(`div`,{role:`tooltip`,className:`absolute z-20 pointer-events-none max-w-xs px-2 py-1.5 rounded border border-border-default bg-surface-elevated shadow-lg text-2xs space-y-0.5`,style:At,"data-testid":`page-pin-preview`,children:[(0,Q.jsxs)(`div`,{className:`flex items-center gap-1.5 text-text-muted`,children:[(0,Q.jsxs)(`span`,{className:`font-semibold text-text-secondary`,children:[`#`,X.index+1]}),(0,Q.jsx)(`span`,{children:Xn(X.state).text}),X.replies>0&&(0,Q.jsxs)(`span`,{children:[`· `,X.replies,` `,X.replies===1?`reply`:`replies`]})]}),(0,Q.jsx)(`p`,{className:`text-text-primary line-clamp-3 break-words`,children:cr(X.comment.content)})]})]}),(0,Q.jsxs)(`div`,{className:N?`sticky top-2 max-h-[calc(70vh+2rem)] overflow-y-auto space-y-3 pr-0.5`:`col-span-full space-y-3`,role:N?`complementary`:void 0,"aria-label":`Review`,"data-testid":`page-review-column`,"data-placement":N?`rail`:`below`,children:[Ot,kt(N?`rail`:`below`)]})]})]}),(0,Q.jsx)(Se,{artifact:e})]})}export{mr as PageArtifact};