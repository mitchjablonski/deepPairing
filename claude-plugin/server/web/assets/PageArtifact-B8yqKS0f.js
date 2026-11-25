import{a as e}from"./chunk-BEqpzyXh.js";import{t}from"./react-BD_ANHAE.js";import{t as n}from"./jsx-runtime-DOlcsXOY.js";import{n as r,o as i,s as a}from"./api-HWtMma59.js";import{S as o,h as s}from"./artifact-BFW_wifK.js";import{B as c,C as l,D as u,E as d,G as f,K as p,P as m,Q as h,S as g,T as _,_t as v,b as y,dt as b,ft as x,gt as S,ht as C,mt as w,pt as T,ut as E,v as ee,w as te,x as ne,y as D}from"./dist-BoEKPaRz.js";import{f as re,t as O}from"./useOfflineReason-3-CS2T34.js";import{C as ie,T as ae,_ as oe,g as k,j as se,m as ce,v as le}from"./index-GvOpDFai.js";import{t as ue}from"./PrototypeFrame-B4Qg5VKA.js";import{t as de}from"./ConceptBadge-BoXl3WkE.js";import{r as fe}from"./NeverSuggestControl-oqwJ2t0a.js";import{t as pe}from"./ArtifactStatusActions-DPzx7Rsq.js";var A=e(t(),1),me=String.raw`
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
`,j=String.raw`
"use strict";
var annotate = true, scripts = false, suppressClick = false, hoverBox = null, layer = null;
var current = [], lastFound = null, pending = 0, pinEls = [];
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
function onMove(e) { paintHover(targetEl(e), !!e.altKey, !!(e.ctrlKey || e.metaKey)); }
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
function drawPins() {
  var l = ensureLayer();
  var olds = l.querySelectorAll("dp-annotator-pin");
  for (var i = 0; i < olds.length; i++) olds[i].remove();
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
    post({ dp: "pins-status", found: found });
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
  var amsg = { dp: "asks", asks: asks, pinAsks: pinAsks };
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
    reconcile(true);
    scheduleOutline();
  } else if (d.dp === "focus") {
    focusPin(d.index);
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
`,he=`(function(){try{var core=(function(document,window){`+me+`
})(document,window);(function(document,window,parent,core){`+j+`
})(document,window,window.parent,core);}catch(e){}})();`,M=new Set(g);function ge(e){let t=e.replace(/[\x00-\x20\x7f-\x9f]/g,``).toLowerCase();return t.startsWith(`javascript:`)||t.startsWith(`vbscript:`)||t.startsWith(`data:text/html`)||t.startsWith(`data:application/xhtml`)}function _e(e){for(let t of Array.from(e.attributes)){let n=t.name.toLowerCase();if(n.startsWith(`on`)){e.removeAttribute(t.name);continue}(n===`srcdoc`||ge(t.value))&&e.removeAttribute(t.name)}}var ve=[`class`,`dir`,`lang`,`style`];function N(e){return!/url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding|\\/i.test(e)}function ye(e){let t={};if(!e)return t;for(let n of ve){let r=e.getAttribute(n);r==null||r===``||n===`dir`&&!/^(ltr|rtl|auto)$/i.test(r.trim())||n===`style`&&!N(r)||(t[n]=r)}return t}function P(e){let t=[],n=e.documentElement?[e.documentElement]:[];for(;n.length;){let e=n.pop();t.push(e);let r=e.childNodes;for(let e=r.length-1;e>=0;e--){let t=r[e];t.nodeType===1&&n.push(t)}}return t}function be(e){if(typeof DOMParser>`u`)return{html:``,htmlAttrs:{},bodyAttrs:{}};let t=new DOMParser().parseFromString(e,`text/html`);for(let e of P(t))M.has(e.localName.toLowerCase())&&e.remove();for(let e of Array.from(t.querySelectorAll(`script`)))e.remove();for(let e of Array.from(t.getElementsByTagNameNS(`*`,`script`)))e.remove();for(let e of Array.from(t.querySelectorAll(`meta`)))(e.getAttribute(`http-equiv`)??``).trim().toLowerCase()===`refresh`&&e.remove();for(let e of P(t)){let t=e.localName.toLowerCase();t!==`set`&&!t.startsWith(`animate`)||(Array.from(e.attributes).find(e=>e.name.toLowerCase()===`attributename`)?.value??``).toLowerCase().includes(`href`)&&e.remove()}for(let e of P(t))_e(e);return{html:t.head.innerHTML+t.body.innerHTML,htmlAttrs:ye(t.documentElement),bodyAttrs:ye(t.body)}}var F=2e4,xe=50,I=32,Se=80,Ce=new Set([`h1`,`h2`,`h3`,`h4`,`h5`,`h6`,`p`,`li`,`tr`,`figure`,`pre`,`blockquote`,`dt`,`dd`,`summary`,`caption`,`button`,`label`,`legend`]),L=new Set([`h1`,`h2`,`h3`,`h4`,`h5`,`h6`]),R=new Set([`div`,`section`,`article`,`aside`,`header`,`footer`,`main`,`nav`,`details`]),we=new Set(`a.abbr.b.bdi.bdo.cite.code.data.del.dfn.em.font.i.ins.kbd.mark.q.s.samp.small.span.strong.sub.sup.time.u.var.wbr.img.svg`.split(`.`));function z(e){return e.replace(/\s+/g,` `).trim()}function B(e){return e===` `||e===`
`||e===`	`||e===`\r`||e===`\f`}function V(e){return!!e&&!!e.closest(`script,style,noscript,template,iframe,frame,frameset,object,embed,applet,portal,dp-annotator-layer`)}var H=e=>e===`td`||e===`th`;function Te(e){for(let t=e.previousElementSibling;t;t=t.previousElementSibling)if(H(t.localName.toLowerCase()))return!0;return!1}var U={submit:`Submit`,reset:`Reset`,button:``},Ee=new Set([``,`text`,`search`,`email`,`url`,`tel`,`number`]);function W(e){let t=(e.getAttribute(`type`)??``).trim().toLowerCase();return Object.prototype.hasOwnProperty.call(U,t)?e.getAttribute(`value`)??U[t]:Ee.has(t)?e.getAttribute(`value`)??``:``}var G=class{text=``;lastSpace=!0;space(){this.lastSpace||=(this.text+=` `,!0)}cell(){this.space(),this.text+=`| `,this.lastSpace=!0}chars(e,t=1/0){for(let n=0;n<e.length;n++){let r=e.charAt(n);if(B(r)?this.space():(this.text+=r,this.lastSpace=!1),this.text.length>t)return!0}return!1}element(e,t=1/0){let n=e.localName.toLowerCase();if(n===`br`)this.space();else if(H(n))Te(e)&&this.cell();else if(n===`input`)return this.chars(W(e),t);return!1}};function De(e){let t=z(e.getAttribute(`alt`)||e.getAttribute(`aria-label`)||e.getAttribute(`title`)||e.getAttribute(`value`)||``);if(!t){let n=e.getElementsByTagName(`img`);for(let e=0;e<n.length&&!t;e++)V(n[e])||(t=z(n[e].getAttribute(`alt`)||``))}return t}function Oe(e,t=280){let n=e.ownerDocument.createTreeWalker(e,5),r=new G,i;for(;i=n.nextNode();){if(i.nodeType===1){if(V(i))continue;if(r.element(i,t))break;continue}if(!V(i.parentElement)&&r.chars(i.nodeValue??``,t))break}let a=z(r.text);return a||=De(e),a.length>t?a.slice(0,t):a}function K(e){if(typeof DOMParser>`u`)return null;try{return new DOMParser().parseFromString(e,`text/html`)}catch{return null}}var ke=3;function q(e,t=F){let n=e.body??e.documentElement;if(!n)return{blocks:[],truncated:!1};let r=Array.from(n.getElementsByTagName(`*`)),i=new Map,a=new Map,o=new Set;for(let e=r.length-1;e>=0;e--){let t=r[e],n=t.localName.toLowerCase();if(V(t))continue;let s=i.get(t)??0,c=Ce.has(n)||R.has(n)&&s===0;c&&o.add(t);let l=s+(c?1:0),u=(a.get(t)??0)+(L.has(n)?1:0);t.parentElement&&(l&&i.set(t.parentElement,(i.get(t.parentElement)??0)+l),u&&a.set(t.parentElement,(a.get(t.parentElement)??0)+u))}let s=[],c=new Map,l=e=>{for(let t=e;t;t=t.parentElement)if(o.has(t))return t;return null},u=e=>{let t=e;for(;t&&t!==n&&we.has(t.localName.toLowerCase());)t=t.parentElement;return t??n},d=null,f=0,p=e.createTreeWalker(n,5),m,h=e=>{let t=u(e);return(!d||d.el!==t)&&(d={el:t,buf:new G,pos:f,synthetic:!0},s.push(d)),d};for(;m=p.nextNode();){if(f++,m.nodeType===1){let e=m;if(V(e))continue;let t=e.localName.toLowerCase();if(o.has(e)){let t={el:e,buf:new G,pos:f,synthetic:!1};s.push(t),c.set(e,t)}if(!we.has(t)&&t!==`br`&&t!==`input`&&(d=null),t===`br`||H(t)||t===`input`){let n=l(e.parentElement);n?c.get(n).buf.element(e):(t===`input`?W(e).trim():d)&&h(e.parentElement).buf.element(e)}continue}let e=m.parentElement;if(V(e))continue;let t=m.nodeValue??``,n=l(e);if(n){c.get(n).buf.chars(t);continue}!t.trim()&&!d||h(e).buf.chars(t)}s.sort((e,t)=>e.pos-t.pos);let g=[],_=``,v=-1,y=!1,b=[],x=``;for(let e of s){let n=e.el,r=z(e.buf.text);if(!r&&!e.synthetic){let e=n.getElementsByTagName(`img`);for(let t=0;t<e.length&&!r;t++)V(e[t])||(r=z(e[t].getAttribute(`alt`)||``))}if(!r)continue;if(g.length>=t){y=!0;break}let o=n.localName.toLowerCase(),s=!e.synthetic&&L.has(o);if(s){_=r.length>Se?`${r.slice(0,Se-1)}…`:r,v=g.length;let e=Number(o.slice(1));for(;b.length&&b[b.length-1].level>=e;)b.pop();b.push({level:e,text:_}),x=b.map(e=>e.text).join(` › `)}let c={tag:o,text:r,section:_,sectionId:v,sectionPath:x,heading:s,el:n};e.synthetic&&(c.synthetic=!0,(o===`body`||o===`html`||o===`main`||(i.get(n)??0)>ke||(a.get(n)??0)>1)&&(c.unlocatable=!0)),g.push(c)}return{blocks:g,truncated:y}}function Ae(e){let t=e.body??e.documentElement;if(!t)return``;let n=e.createTreeWalker(t,5),r=new G,i;for(;i=n.nextNode();){if(i.nodeType===1){let e=i;if(V(e))continue;let t=e.localName.toLowerCase();(Ce.has(t)||R.has(t))&&r.space(),r.element(e);continue}V(i.parentElement)||r.chars(i.nodeValue??``)}return z(r.text)}function je(e){let t=[],n=Array(e.length).fill(-1);for(let r=0;r<e.length;r++){let i=0,a=t.length;for(;i<a;){let n=i+a>>1;e[t[n]]<e[r]?i=n+1:a=n}i>0&&(n[r]=t[i-1]),t[i]=r}let r=[],i=t.length?t[t.length-1]:-1;for(;i!==-1;)r.push(i),i=n[i];return r.reverse()}function Me(e,t,n,r,i,a,o){let s=n-t,c=a-i,l=c+1,u=new Uint32Array((s+1)*l);for(let n=s-1;n>=0;n--)for(let a=c-1;a>=0;a--)u[n*l+a]=e[t+n]===r[i+a]?u[(n+1)*l+a+1]+1:Math.max(u[(n+1)*l+a],u[n*l+a+1]);let d=0,f=0;for(;d<s&&f<c;)e[t+d]===r[i+f]?(o.push([t+d,i+f]),d++,f++):u[(d+1)*l+f]>=u[d*l+f+1]?d++:f++}function Ne(e,t,n,r,i,a,o){let s=new Map;for(let r=t;r<n;r++){let t=s.get(e[r]);t?t.idx.push(r):s.set(e[r],{idx:[r],p:0})}let c=t-1;for(let e=i;e<a;e++){let t=s.get(r[e]);if(t){for(;t.p<t.idx.length&&t.idx[t.p]<=c;)t.p++;t.p<t.idx.length&&(c=t.idx[t.p],t.p++,o.push([c,e]))}}}function J(e,t,n,r,i,a,o,s){for(;t<n&&i<a&&e[t]===r[i];)s.push([t++,i++]);let c=[];for(;t<n&&i<a&&e[n-1]===r[a-1];)c.push([--n,--a]);if(t<n&&i<a)if((n-t)*(a-i)<=12e4)Me(e,t,n,r,i,a,s);else{let c=new Map;for(let r=t;r<n;r++){let t=c.get(e[r]);t?t.ca++:c.set(e[r],{ca:1,cb:0,ia:r})}let l=[],u=[];for(let e=i;e<a;e++){let t=c.get(r[e]);t&&t.cb++}for(let e=i;e<a;e++){let t=c.get(r[e]);t&&t.ca===1&&t.cb===1&&(l.push(e),u.push(t.ia))}if(u.length===0||o>=I)Ne(e,t,n,r,i,a,s);else{let c=t,d=i;for(let t of je(u)){let n=u[t],i=l[t];J(e,c,n,r,d,i,o+1,s),s.push([n,i]),c=n+1,d=i+1}J(e,c,n,r,d,a,o+1,s)}}for(let e=c.length-1;e>=0;e--)s.push(c[e])}function Pe(e,t){let n=[];return J(e,0,e.length,t,0,t.length,0,n),n}var Fe=e=>`${e.tag}\u0001${e.text}`;function Ie(e,t){let n=e.map(Fe),r=t.map(Fe),i=Pe(n,r),a=new Uint8Array(n.length),o=new Uint8Array(r.length);for(let[e,t]of i)a[e]=1,o[t]=1;let s=[...i],c=new Map;for(let e=0;e<n.length;e++){if(a[e])continue;let t=c.get(n[e]);t?t.push(e):c.set(n[e],[e])}let l=new Set;for(let e=0;e<r.length;e++){if(o[e])continue;let t=c.get(r[e]);if(!t||!t.length)continue;let n=t.shift();a[n]=1,o[e]=1,s.push([n,e]),l.add(e)}let u=new Map,d=[],f=new Map,p=[[-1,-1],...i,[n.length,r.length]];for(let n=0;n+1<p.length;n++){let[r,i]=p[n],[s,c]=p[n+1],l=[],m=[];for(let e=r+1;e<s;e++)a[e]||l.push(e);for(let e=i+1;e<c;e++)o[e]||m.push(e);if(!l.length&&!m.length)continue;let h=new Set,g=(n,r)=>{h.add(n),u.set(r,{kind:`changed`,block:t[r],previous:e[n]}),e[n].heading&&t[r].heading&&f.set(n,r)},_=new Map;for(let t of l){let n=e[t],r=`${n.tag}\u0001${n.heading?``:n.section}`,i=_.get(r);i?i.push(t):_.set(r,[t])}let v=[];for(let e of m){let n=t[e],r=_.get(`${n.tag}\u0001${n.heading?``:n.section}`),i;for(;r&&r.length&&i===void 0;){let e=r.shift();h.has(e)||(i=e)}i===void 0?v.push(e):g(i,e)}let y=l.filter(e=>!h.has(e)),b=Math.min(y.length,v.length);for(let n=0;n<b;n++){let r=y[n],i=v[n];e[r].tag===t[i].tag&&g(r,i)}for(let e of v)u.has(e)||u.set(e,{kind:`added`,block:t[e]});for(let t of l)h.has(t)||d.push(e[t])}for(let[n,r]of s)e[n].heading&&t[r].heading&&f.set(n,r);let m=(e,t)=>e.sectionId<0||t.sectionId<0?e.sectionId<0&&t.sectionId<0:f.get(e.sectionId)===t.sectionId,h=0;for(let[n,r]of s){let i=e[n],a=t[r];if(a.heading){l.has(r)&&h++;continue}m(i,a)?l.has(r)&&h++:u.set(r,{kind:`moved`,block:a,previous:i})}return{changes:[...u.entries()].sort((e,t)=>e[0]-t[0]).map(([,e])=>e),removed:d,moved:h}}function Le(e,t){let n=new Map,r=[];for(let{el:i,kind:a}of t){let t=i.localName.toLowerCase(),o=n.get(t);if(!o){o=new Map;let r=new Map,i=e.getElementsByTagName(t);for(let e=0;e<i.length;e++){let t=i[e];if(V(t))continue;let n=Oe(t),a=r.get(n)??0;r.set(n,a+1),o.set(t,{text:n,occurrence:a})}n.set(t,o)}let s=o.get(i);!s||!s.text||r.push({kind:a,tag:t,text:s.text,occurrence:s.occurrence})}return r}var Y=[];function Re(e,t){return Y.find(n=>n.oldHtml===e&&n.newHtml===t)?.diff}function ze(e,t){let n=Y.find(n=>n.oldHtml===e&&n.newHtml===t);if(n)return n.diff;let r=Be(e,t);return Y.unshift({oldHtml:e,newHtml:t,diff:r}),Y.length>4&&Y.pop(),r}function Be(e,t){let n=K(e),r=K(t);if(!n||!r)return null;let i=e===t,a=q(n),o=q(r),s=i?{changes:[],removed:[],moved:0}:Ie(a.blocks,o.blocks),c=s.changes.length===0&&s.removed.length===0&&s.moved===0,l=!i&&c&&Ae(n)!==Ae(r),u=[],d=new Set,f=0;for(let e of s.changes){let t=e.block.el;if(!t||e.block.unlocatable){f++;continue}d.has(t)||(d.add(t),u.push({el:t,kind:e.kind}))}let p=[];for(let e of Array.from(r.querySelectorAll(`[data-dp-changed]`)).slice(0,xe))d.has(e)||V(e)||(d.add(e),p.push({el:e,kind:`hinted`}));let m=[...u,...p].slice(0,300);return{...s,truncated:a.truncated||o.truncated,identical:i,textChangedOutsideBlocks:l,marks:Le(r,m),changeMarksTotal:u.length,hintMarksTotal:p.length,unhighlightable:f}}var Ve={p:[`paragraph`,`paragraphs`],li:[`list item`,`list items`],tr:[`table row`,`table rows`],pre:[`code block`,`code blocks`],blockquote:[`quote`,`quotes`],figure:[`figure`,`figures`],dt:[`term`,`terms`],dd:[`definition`,`definitions`]};function He(e,t){let[n,r]=Ve[e.size===1?[...e][0]:``]??[`block`,`blocks`];return t===1?n:r}var Ue=``;function We(e){let t=[],n=[],r=[];for(let n of e.changes)n.kind===`added`&&n.block.heading&&!t.includes(n.block.section)&&t.push(n.block.section);for(let i of e.changes){if(i.kind===`moved`&&i.previous){let e=i.previous.section===i.block.section;r.push({text:i.block.text,from:e&&i.previous.sectionPath||i.previous.section,to:e&&i.block.sectionPath||i.block.section})}let e=i.block.section;t.includes(e)||n.includes(e)||n.push(e)}let i=new Set(e.removed.filter(e=>e.heading).map(e=>e.sectionId)),a=new Map;for(let t of e.removed)t.heading&&a.set(t.sectionId,{section:t.section,sectionId:t.sectionId,texts:[],noun:``,tags:new Set});let o=new Map;for(let t of e.removed){if(t.heading)continue;if(i.has(t.sectionId)){let e=a.get(t.sectionId);e.texts.push(t.text),e.tags.add(t.tag);continue}let e=o.get(t.sectionId);e||o.set(t.sectionId,e={section:t.section,tags:new Set,texts:[]}),e.tags.add(t.tag),e.texts.push(t.text)}let s=[...a.values()].map(({tags:e,...t})=>({...t,noun:He(e,t.texts.length)})),c=[...o.entries()].map(([e,t])=>({section:t.section,sectionId:e,count:t.texts.length,noun:He(t.tags,t.texts.length),texts:t.texts}));return{state:e.changes.length>0||e.removed.length>0||e.moved>0?`changes`:e.identical?`identical`:e.textChangedOutsideBlocks?`outside-blocks`:`markup-only`,changedSections:n,addedSections:t,removedSections:s,removed:c,movedAcross:r,movedCount:e.moved,changeCount:e.changes.length}}function X(e){return e===Ue?`Top of page`:e}function Ge(e,t=6){let n=e.slice(0,t).map(X);return e.length>t?`${n.join(`, `)} and ${e.length-t} more`:n.join(`, `)}function Ke(e,t=60){return e.length>t?`${e.slice(0,t-1)}…`:e}var qe={identical:`Page content unchanged.`,"markup-only":`No change found in the compared text (attributes, styling and live form state aren't compared).`,"outside-blocks":`Text changed outside recognised blocks.`};function Je(e){if(e.state!==`changes`)return qe[e.state];let t=[];if(e.changedSections.length&&t.push(`Changed: ${Ge(e.changedSections)}`),e.addedSections.length&&t.push(`Added: ${Ge(e.addedSections)}`),e.movedAcross.length){let n=e.movedAcross.slice(0,3).map(e=>`“${Ke(e.text)}” from ${X(e.from)} to ${X(e.to)}`);e.movedAcross.length>3&&n.push(`${e.movedAcross.length-3} more`),t.push(`Moved: ${n.join(`, `)}`)}let n=[];for(let t of e.removedSections.slice(0,4))n.push(`section ${X(t.section)}${t.texts.length?` (${t.texts.length} ${t.noun})`:``}`);e.removedSections.length>4&&n.push(`${e.removedSections.length-4} more sections`);for(let t of e.removed.slice(0,4))n.push(`${t.count} ${t.noun} ${t.section===Ue?`at the top of the page`:`under ${t.section}`}`);return e.removed.length>4&&n.push(`more in ${e.removed.length-4} other sections`),n.length&&t.push(`Removed: ${n.join(`, `)}`),e.movedCount&&t.push(`${e.movedCount} ${e.movedCount===1?`block`:`blocks`} moved`),t.join(`; `)}function Z(e,t){if(!t||e.source!==t)return null;let n=e.data;return!n||typeof n!=`object`||Array.isArray(n)?null:n}function Ye(e,t){let n=Z(e,t);if(!n||n.dp!==`anchor`)return null;let r=p.safeParse(n.anchor);return r.success?r.data:null}var Xe=500;function Ze(e,t){let n=Z(e,t);if(!n||n.dp!==`pins-status`)return null;let r=n.found;return!Array.isArray(r)||r.length>Xe||!r.every(e=>typeof e==`boolean`)?null:r}function Qe(e,t){let n=Z(e,t);return!!n&&n.dp===`ready`}function $e(e,t){let n=Z(e,t);return!!n&&n.dp===`toggle-pointing`}var et=C({kind:E([`added`,`changed`,`moved`,`hinted`]),tag:S().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/),text:S().min(1).max(280),occurrence:w().int().min(0).max(1e6)}).strict(),tt=C({dp:T(`changes`),marks:b(et).max(300),show:x()}).strict();function nt(e,t){let n=[];for(let t of e.slice(0,300)){let e=et.safeParse(t);e.success&&n.push(e.data)}return tt.parse({dp:`changes`,marks:n,show:t})}function rt(e,t){let n=Z(e,t);if(!n||n.dp!==`changes-status`)return null;let r=n.found;return!Array.isArray(r)||r.length>300||!r.every(e=>typeof e==`boolean`)?null:r}var it=S().min(1).max(f.locator),at=w().int().min(-1).max(199),ot=C({level:v([T(1),T(2),T(3)]),text:S().min(1).max(120),locator:it}).strict(),st=C({dp:T(`outline`),headings:b(ot).max(200),pins:b(at).max(500),changes:b(at).max(300)}).strict().superRefine((e,t)=>{for(let[n,r]of[[`pins`,e.pins],[`changes`,e.changes]])r.some(t=>t>=e.headings.length)&&t.addIssue({code:`custom`,path:[n],message:`section index out of range`})});function ct(e,t){let n=Z(e,t);if(!n||n.dp!==`outline`)return null;let r=st.safeParse(n);return r.success?r.data:null}function lt(e,t){let n=Z(e,t);if(!n||n.dp!==`outline-active`)return null;let r=at.safeParse(n.index);return r.success?r.data:null}var ut=C({kind:E([`decision`,`question`]),text:S().max(D.text),locator:it,id:S().min(1).max(D.id).optional()}).strict(),dt=C({dp:T(`asks`),asks:b(ut).max(D.max),pinAsks:b(w().int().min(-1).max(D.max-1)).max(500)}).strict().superRefine((e,t)=>{e.pinAsks.some(t=>t>=e.asks.length)&&t.addIssue({code:`custom`,path:[`pinAsks`],message:`ask index out of range`})});function ft(e,t){let n=Z(e,t);if(!n||n.dp!==`asks`)return null;let r=dt.safeParse(n);return r.success?r.data:null}function pt(e){let t=p.safeParse({kind:`element`,locator:e.locator,quote:e.text});return t.success?t.data:null}var Q=n(),mt=(e,t,n)=>`${e} ${e===1?t:n}`;function ht(e,t){return e.map((n,r)=>{let i=t[r]??0,a=i;for(let i=r+1;i<e.length&&e[i].level>n.level;i++)a+=t[i]??0;return{total:a,own:i}})}function gt(e,t,n){if(e.total===0)return``;let r=e.total-e.own;return r>0?`${mt(e.total,t,n)} (${e.own} in this section, ${r} in subsections)`:mt(e.total,t,n)}function _t({headings:e,commentCounts:t,changeCounts:n,active:r,onJump:i,variant:a}){let o=Math.min(...e.map(e=>e.level)),s=ht(e,t),c=ht(e,n);return(0,Q.jsx)(`ol`,{className:`space-y-0.5`,"data-testid":`page-outline-list-${a}`,children:e.map((e,t)=>{let n=s[t].total,a=c[t].total,l=t===r,u=[e.text,gt(s[t],`open comment`,`open comments`),gt(c[t],`changed block`,`changed blocks`),l?`you are here`:``].filter(Boolean).join(`, `);return(0,Q.jsx)(`li`,{style:{paddingLeft:`${(e.level-o)*.75}rem`},children:(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>i(t),"aria-current":l?`location`:void 0,"aria-label":`Go to ${u}`,title:e.text,className:`w-full flex items-center gap-1.5 text-left px-1.5 py-0.5 rounded text-2xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${l?`bg-accent-blue-dim/40 text-text-primary font-semibold border-l-2 border-accent-blue`:`text-text-secondary hover:bg-surface-elevated border-l-2 border-transparent`}`,"data-testid":`page-outline-entry`,"data-level":e.level,children:[(0,Q.jsx)(`span`,{className:`flex-1 min-w-0 truncate`,children:e.text}),n>0&&(0,Q.jsx)(`span`,{"aria-hidden":`true`,className:`shrink-0 px-1 rounded-full bg-accent-amber text-[10px] font-semibold text-black`,"data-testid":`page-outline-comments`,children:n}),a>0&&(0,Q.jsxs)(`span`,{"aria-hidden":`true`,className:`shrink-0 px-1 rounded-full border border-accent-violet/60 text-[10px] font-semibold text-accent-violet`,"data-testid":`page-outline-changes`,children:[`~`,a]})]})},t)})})}function vt(e,t,n){let r=e>=0?n[e]:void 0;return r?`Section ${e+1} of ${t}: ${r.text}`:`Top of the page (${mt(t,`section`,`sections`)})`}function yt(e){let{headings:t,active:n,variant:r}=e;if(t.length===0)return null;let i=vt(n,t.length,t);return r===`disclosure`?(0,Q.jsxs)(`details`,{className:`rounded-lg border border-border-default text-2xs`,"data-testid":`page-outline-disclosure`,children:[(0,Q.jsxs)(`summary`,{className:`cursor-pointer px-2 py-1 text-text-secondary`,children:[`Outline `,(0,Q.jsxs)(`span`,{className:`text-text-muted`,children:[`· `,i]})]}),(0,Q.jsx)(`nav`,{"aria-label":`Page outline`,className:`px-1 pb-1.5 max-h-64 overflow-y-auto`,children:(0,Q.jsx)(_t,{...e})})]}):(0,Q.jsxs)(`nav`,{"aria-label":`Page outline`,className:`sticky top-2 max-h-[70vh] overflow-y-auto rounded-lg border border-border-default p-1.5 space-y-1`,"data-testid":`page-outline-rail`,children:[(0,Q.jsx)(`div`,{className:`px-1.5 text-2xs font-semibold text-text-muted uppercase tracking-wide`,children:`Outline`}),(0,Q.jsx)(`div`,{className:`px-1.5 text-[10px] text-text-muted`,"data-testid":`page-outline-progress`,children:i}),(0,Q.jsx)(_t,{...e})]})}var bt={decision:`Decide`,question:`Question`};function xt({asks:e,answered:t,readOnly:n,onJump:r,onReply:i}){if(e.length===0)return null;let a=t.filter(Boolean).length,o=e.length-a;return(0,Q.jsxs)(`section`,{"aria-label":`Wants from you: ${e.length} ${e.length===1?`ask`:`asks`}, ${o} open`,className:`rounded-lg border border-accent-amber/40 bg-accent-amber/5 px-3 py-2 space-y-1.5`,"data-testid":`page-asks`,children:[(0,Q.jsxs)(`h3`,{className:`flex flex-wrap items-baseline gap-2 text-xs font-semibold text-text-primary`,children:[(0,Q.jsxs)(`span`,{children:[`Wants from you (`,e.length,`)`]}),(0,Q.jsxs)(`span`,{className:`text-2xs font-normal text-text-muted`,"data-testid":`page-asks-tally`,children:[o,` open · `,a,` answered`]})]}),(0,Q.jsx)(`ul`,{className:`space-y-1 max-h-60 overflow-y-auto`,children:e.map((e,a)=>{let o=t[a]===!0,s=e.text.trim()||(e.id?`#${e.id}`:`(no text)`);return(0,Q.jsxs)(`li`,{className:`flex flex-wrap items-start gap-2 text-2xs ${o?`opacity-70`:``}`,"data-testid":`page-ask`,"data-answered":o?`true`:`false`,children:[(0,Q.jsx)(`span`,{className:`shrink-0 px-1.5 py-0.5 rounded font-semibold ${e.kind===`decision`?`bg-accent-violet/15 text-accent-violet`:`bg-accent-blue-dim/40 text-accent-blue`}`,children:bt[e.kind]}),(0,Q.jsx)(`span`,{className:`flex-1 min-w-0 text-xs text-text-primary break-words line-clamp-2`,children:s}),(0,Q.jsx)(`span`,{className:`shrink-0 ${o?`text-accent-green`:`text-accent-amber`}`,"data-testid":`page-ask-state`,children:o?`Answered`:`Open`}),(0,Q.jsxs)(`span`,{className:`shrink-0 inline-flex gap-1`,children:[(0,Q.jsx)(`button`,{type:`button`,onClick:()=>r(a),"aria-label":`Show on the page: ${s}`,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,children:`Jump`}),!n&&(0,Q.jsx)(`button`,{type:`button`,onClick:()=>i(a),"aria-label":`Reply to: ${s}`,className:`px-1.5 py-0.5 rounded border border-accent-blue/40 hover:bg-accent-blue-dim/30 text-accent-blue`,children:`Reply`})]})]},`${a}-${e.locator}`)})})]})}var St=`[${y}], [${ne}]`,Ct=`script,style,noscript,template`,wt=g.join(`,`),Tt=50,Et=`${Ct},title,${wt}`;function Dt(e){return(e.getAttribute(`alt`)||e.getAttribute(`aria-label`)||e.getAttribute(`title`)||e.getAttribute(`value`)||``).replace(/\s+/g,` `).trim()}function Ot(e,t){let n=e.ownerDocument.createTreeWalker(e,4),r=new ee,i=``,a=!0;for(let e=n.nextNode();e;e=n.nextNode()){let n=e.parentElement,o=e.nodeValue??``;if(n&&n.closest(Et)||r.push(o),!(i.length>t||n&&n.closest(Ct))){for(let e of o)if(/\s/.test(e)?a||=(i+=` `,!0):(i+=e,a=!1),i.length>t)break}}let o=i.replace(/\s+/g,` `).trim(),s=Dt(e);o||=s;let c=r.digest()??(s?l(s):void 0);return{text:o.length>t?o.slice(0,t):o,...c?{fullHash:c}:{}}}function kt(e){let t=K(e);if(!t)return null;let n=[];for(let e of Array.from(t.querySelectorAll(St))){if(n.length>=D.max)break;if(e.closest(wt))continue;let t=e.id;if(!t||t.length>D.id)continue;let r=[];for(let t of Array.from(e.querySelectorAll(`[id]`))){if(r.length>=Tt)break;t.closest(St)===e&&t.id&&t.id.length<=D.id&&r.push(t.id)}n.push({id:t,...Ot(e,D.text),...r.length?{childIds:r}:{}})}return n}var $=new Map,At=50;function jt(e){if(!$.has(e))return;let t=$.get(e);return $.delete(e),$.set(e,t),t}function Mt(e,t){let n=jt(e);if(n!==void 0)return n;let r=kt(t);return $.set(e,r),$.size>At&&$.delete($.keys().next().value),r}function Nt(e,t){let n=t?e.map(e=>e.id).join(`\0`):``,[r,i]=(0,A.useState)(0);return(0,A.useEffect)(()=>{if(!n)return;let t=e.filter(e=>jt(e.id)===void 0);if(t.length===0)return;let r=!1,a=()=>{if(!r){for(let e of t)Mt(e.id,m(e.content).html);r||i(e=>e+1)}},o=window;if(typeof o.requestIdleCallback==`function`){let e=o.requestIdleCallback(a,{timeout:400});return()=>{r=!0,o.cancelIdleCallback?.(e)}}let s=setTimeout(a,0);return()=>{r=!0,clearTimeout(s)}},[n]),(0,A.useMemo)(()=>{let e=new Set(n?n.split(`\0`):[]);return t=>e.has(t)?jt(t)??void 0:void 0},[n,r])}function Pt(e){let t=s(e=>e.artifacts);return(0,A.useMemo)(()=>{let n=[];if(e.type!==`page`)return n;let r=new Set([e.id]),i=e.parentId;for(;i&&!r.has(i);){r.add(i);let e=t.find(e=>e.id===i);if(!e||e.type!==`page`)break;n.push({artifact:e,autoSave:!!c(e.fileWatch).recorded}),i=e.parentId}return n},[t,e.id,e.parentId,e.type])}function Ft(e,t){let n=t?.type===`page`?m(t.content).html:null,r=e.type===`page`?m(e.content).html:null,i=t&&n!==null&&r!==null?`${t.id}\u0000${e.id}`:null,[a,o]=(0,A.useState)(null),s=i&&n!==null&&r!==null?Re(n,r):void 0;(0,A.useEffect)(()=>{if(!i||n===null||r===null||Re(n,r)!==void 0)return;let e=!1,t=()=>{if(e)return;let t=ze(n,r);e||o({key:i,diff:t})},a=window;if(typeof a.requestIdleCallback==`function`){let n=a.requestIdleCallback(t,{timeout:400});return()=>{e=!0,a.cancelIdleCallback?.(n)}}let s=setTimeout(t,0);return()=>{e=!0,clearTimeout(s)}},[i,n,r]);let c=s===void 0?a&&a.key===i?a.diff:void 0:s;return{changes:(0,A.useMemo)(()=>t&&c?{base:t,diff:c,summary:We(c)}:null,[t,c]),pending:!!i&&c===void 0}}var It=(e,t=160)=>e.length>t?`${e.slice(0,t-1)}…`:e;function Lt({summary:e,truncated:t}){return(0,Q.jsxs)(`span`,{className:`text-2xs text-text-secondary`,"data-testid":`page-change-summary-line`,"data-state":e.state,children:[Je(e),t?` (Very large page: only the first part was compared.)`:``]})}function Rt({summary:e}){return(0,Q.jsxs)(`ul`,{className:`space-y-1`,"data-testid":`page-removed-list`,children:[e.removedSections.map(e=>(0,Q.jsxs)(`li`,{"data-testid":`page-removed-section`,children:[(0,Q.jsxs)(`span`,{className:`text-text-secondary`,children:[`Section `,(0,Q.jsx)(`span`,{className:`font-medium`,children:X(e.section)}),e.texts.length>0?` (${e.texts.length} ${e.noun})`:``]}),e.texts.length>0&&(0,Q.jsx)(zt,{texts:e.texts})]},`s-${e.sectionId}`)),e.removed.map(e=>(0,Q.jsxs)(`li`,{"data-testid":`page-removed-group`,children:[(0,Q.jsxs)(`span`,{className:`text-text-secondary`,children:[e.count,` `,e.noun,` `,e.section?`under ${e.section}`:`at the top of the page`]}),(0,Q.jsx)(zt,{texts:e.texts})]},`g-${e.sectionId}`))]})}function zt({texts:e}){let t=e.slice(0,8);return(0,Q.jsxs)(`ul`,{className:`pl-3 text-text-muted`,children:[t.map((e,t)=>(0,Q.jsx)(`li`,{className:`line-through opacity-80 break-words`,children:It(e)},t)),e.length>t.length&&(0,Q.jsxs)(`li`,{children:[`and `,e.length-t.length,` more`]})]})}function Bt({artifactId:e,anchor:t,ruledOut:n,onRecorded:o}){let c=O(),l=d(t.quote),u=l.ok?l.key:null,f=l.ok?null:_[l.reason],[p,m]=(0,A.useState)(!1),[h,g]=(0,A.useState)(``);re(`page-rule-out:${e}:${t.locator}`,h);let[v,y]=(0,A.useState)(!1),[b,x]=(0,A.useState)(null),[S,C]=(0,A.useState)(null),w=o?n??null:S??n??null,T=(0,A.useRef)(null),E=(0,A.useRef)(!1);(0,A.useEffect)(()=>{!p&&E.current&&(E.current=!1,T.current?.focus())},[p]);let ee=()=>{E.current=!0,m(!1),g(``),x(null)},te=h.trim(),ne=async()=>{if(!(c||v||!te||!u)){y(!0),x(null);try{let n=s.getState().owningSession(e),c=await i(`${r()}/api/artifacts/${encodeURIComponent(e)}/rule-out`,{method:`POST`,headers:a(n),body:JSON.stringify({htmlAnchor:t,reason:te})}),l=null;try{l=await c.json()}catch{}l?.comment?.id&&s.getState().addComment(l.comment),C(l?.description??u),o?.(l?.description??u),m(!1),g(``)}catch(e){x(e instanceof Error?e.message:`Couldn't save that. Try again.`)}finally{y(!1)}}};if(w)return(0,Q.jsxs)(`p`,{className:`text-2xs text-accent-red`,role:`status`,"data-testid":`page-rule-out-recorded`,children:[`✓ Ruled out “`,w,`”. Claude won't present a page that still contains this text in this project. You can retire it in the Ledger.`]});if(!p)return(0,Q.jsxs)(`span`,{className:`inline-flex flex-wrap items-center justify-end gap-1.5`,children:[f&&(0,Q.jsx)(`span`,{className:`text-2xs text-text-muted`,"data-testid":`page-rule-out-unavailable`,children:f}),(0,Q.jsx)(`button`,{ref:T,type:`button`,onClick:()=>m(!0),disabled:!u,title:f??`Remember this text as rejected, so Claude won't present a page that still contains it in this project`,className:`px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-accent-red hover:bg-accent-red-dim/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`,children:`Rule this out`})]});let D=`page-rule-out-reason-${e}`;return(0,Q.jsxs)(`div`,{role:`group`,"aria-label":`Rule this out`,className:`w-full p-2 bg-surface-secondary border border-accent-red/30 rounded-lg`,"data-testid":`page-rule-out-panel`,children:[(0,Q.jsxs)(`label`,{htmlFor:D,className:`block text-2xs text-text-muted mb-1.5`,children:[`Rule out “`,(0,Q.jsx)(`span`,{className:`text-text-primary`,children:u}),`”? Claude won't present a page that still contains this text in this project. It only applies to pages, and this page's status doesn't change (you can retire the stance later in the Ledger). Why are you ruling it out? (required)`]}),(0,Q.jsx)(`textarea`,{id:D,rows:2,autoFocus:!0,value:h,onChange:e=>g(e.target.value),onKeyDown:e=>{e.key===`Enter`&&(e.metaKey||e.ctrlKey)&&(e.preventDefault(),ne()),e.key===`Escape`&&(e.preventDefault(),ee())},placeholder:`Your reason (Claude sees it when the gate refuses this text)…`,className:`w-full px-2 py-1.5 bg-surface-primary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none`}),b&&(0,Q.jsx)(`p`,{className:`mt-1 text-2xs text-accent-red`,role:`alert`,children:b}),(0,Q.jsxs)(`div`,{className:`flex gap-1.5 mt-1.5 justify-end`,children:[(0,Q.jsx)(`button`,{type:`button`,onClick:ee,className:`px-2 py-1 text-2xs text-text-muted hover:text-text-secondary cursor-pointer`,children:`Cancel`}),(0,Q.jsx)(`button`,{type:`button`,title:c??(te?void 0:`Say why first`),onClick:()=>void ne(),disabled:v||!!c||!te,className:`px-2 py-1 text-2xs text-text-inverse bg-accent-red hover:bg-accent-red/80 rounded press-scale cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`,children:`Rule it out`})]})]})}var Vt={script:he,sanitize:be},Ht=[];function Ut(){let e=typeof navigator<`u`&&navigator.platform||``;return/Mac|iPhone|iPad|iPod/.test(e)?`⌘I`:`Ctrl+I`}function Wt(e){return(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&(e.key===`i`||e.key===`I`)}function Gt(e){return e.filter(e=>oe(`page`,e)).slice().sort((e,t)=>e.createdAt.localeCompare(t.createdAt))}function Kt({anchor:e}){let t=e.quote.trim();return(0,Q.jsxs)(`div`,{className:`space-y-0.5 text-2xs text-text-muted`,"data-testid":`page-anchor-context`,children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-1.5`,children:[(0,Q.jsx)(`span`,{className:`px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary`,children:k(e.kind)}),t?(0,Q.jsxs)(`span`,{className:`text-text-primary italic break-words`,children:[`“`,t,`”`]}):(0,Q.jsx)(`code`,{className:`font-mono break-all`,children:e.locator})]}),e.table&&(e.table.row||e.table.col)&&(0,Q.jsxs)(`div`,{children:[e.table.row&&(0,Q.jsxs)(Q.Fragment,{children:[`Row `,(0,Q.jsx)(`span`,{className:`text-text-secondary`,children:e.table.row})]}),e.table.row&&e.table.col&&` · `,e.table.col&&(0,Q.jsxs)(Q.Fragment,{children:[`Column `,(0,Q.jsx)(`span`,{className:`text-text-secondary`,children:e.table.col})]})]}),e.nodeId&&(0,Q.jsxs)(`div`,{children:[`Node `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.nodeId})]}),e.href&&(0,Q.jsxs)(`div`,{className:`break-all`,children:[`Link to `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.href})]}),t&&(0,Q.jsxs)(`div`,{className:`break-all`,children:[`at `,(0,Q.jsx)(`code`,{className:`font-mono`,children:e.locator})]})]})}function qt({artifact:e}){let t=m(e.content),n=(0,A.useRef)(null),r=o(e=>e.active),i=se(e.status,r),a=i===`closed`||i===`frozen`,l=c(e.fileWatch),d=(0,A.useMemo)(()=>new Set((c(e.fileWatch).recorded?.orphaned??[]).map(e=>e.commentId)),[e.fileWatch]),f=ae(e.id),{rows:p,remember:g}=fe(s(t=>t.owningSession(e.id))),_=(0,A.useMemo)(()=>new Set(p.map(e=>e.description)),[p]),v=(0,A.useMemo)(()=>Gt(f),[f]),y=(0,A.useMemo)(()=>v.map(e=>e.target.htmlAnchor),[v]),[b,x]=(0,A.useState)(null),[S,C]=(0,A.useState)(0),[w,T]=(0,A.useState)(!1),E=(0,A.useRef)(null),[ee,ne]=(0,A.useState)(0),D=(0,A.useRef)(null),re=(0,A.useRef)(e.id);re.current=e.id;let O=(0,A.useCallback)(e=>!e||e!==n.current||!e.isConnected||document.activeElement!==e||e.closest(`[inert]`)?!1:s.getState().selectedArtifactId===re.current,[]),oe=(0,A.useRef)(O);oe.current=O;let[k,me]=(0,A.useState)(null),[j,he]=(0,A.useState)(!1),[M,ge]=(0,A.useState)(null),[_e,ve]=(0,A.useState)(-1),[N,ye]=(0,A.useState)([]),[P,be]=(0,A.useState)([]);(0,A.useEffect)(()=>{ge(null),ve(-1),ye([]),be([])},[e.id]);let[F,xe]=(0,A.useState)(!0),I=Pt(e),[Se,Ce]=(0,A.useState)(null),L=(Se&&Se.forId===e.id?I.find(e=>e.artifact.id===Se.baseId):void 0)??I[0],{changes:R,pending:we}=Ft(e,L?.artifact),z=R?.diff.marks??Ht,[B,V]=(0,A.useState)(!0),[H,Te]=(0,A.useState)(null),[U,Ee]=(0,A.useState)(-1);(0,A.useEffect)(()=>{Te(null),Ee(-1)},[z]);let W=(0,A.useCallback)(e=>{n.current?.contentWindow?.postMessage(e,`*`)},[]),G=(0,A.useCallback)(()=>W({dp:`pins`,anchors:y}),[W,y]),De=(0,A.useCallback)(()=>W({dp:`mode`,annotate:F,scripts:j}),[W,F,j]),Oe=(0,A.useCallback)(()=>W(nt(z,B&&z.length>0)),[W,z,B]),K=(0,A.useRef)({sendPins:G,sendMode:De,sendChanges:Oe});K.current={sendPins:G,sendMode:De,sendChanges:Oe};let ke=(0,A.useRef)(!0);ke.current=F;let q=(0,A.useRef)(j);q.current=j;let Ae=(0,A.useRef)(null),je=(0,A.useId)();(0,A.useEffect)(()=>{function t(t){let r=n.current,i=r?.contentWindow,o=Ye(t,i);if(o){if(a||!ke.current||!oe.current(r))return;E.current=r,x({...o,version:e.version}),T(!1),C(e=>e+1),ne(e=>e+1);return}if(Qe(t,i)){K.current.sendMode(),K.current.sendPins(),K.current.sendChanges();return}if($e(t,i)){!a&&!q.current&&oe.current(r)&&xe(e=>!e);return}let s=Ze(t,i);if(s){me(s);return}let c=ct(t,i);if(c){q.current||ge(c);return}let l=lt(t,i);if(l!==null){q.current||ve(l);return}let u=ft(t,i);if(u){q.current||(ye(u.asks),be(u.pinAsks));return}let d=rt(t,i);d&&!q.current&&Te(d)}return window.addEventListener(`message`,t),()=>window.removeEventListener(`message`,t)},[e.version,a]),(0,A.useEffect)(()=>{if(a)return;function e(e){if(e.defaultPrevented||e.repeat||!Wt(e))return;let t=e.target,n=t?.tagName;if(n===`INPUT`||n===`TEXTAREA`||n===`SELECT`||t?.isContentEditable===!0)return;let r=Ae.current;!r||!r.isConnected||r.closest(`[inert]`)||s.getState().selectedArtifactId===re.current&&(e.preventDefault(),xe(e=>!e))}return window.addEventListener(`keydown`,e),()=>window.removeEventListener(`keydown`,e)},[a]),(0,A.useEffect)(()=>{G()},[G]),(0,A.useEffect)(()=>{De()},[De]),(0,A.useEffect)(()=>{Oe()},[Oe]),(0,A.useEffect)(()=>{me(null),Te(null)},[j]),(0,A.useEffect)(()=>{!ee||!O(E.current)||D.current?.querySelector(`textarea`)?.focus?.()},[ee,O]);let Me=(0,A.useCallback)(e=>he(e),[]),Ne=e=>{let t=z.length;if(t)for(let n=1;n<=t;n++){let r=(((U<0?e===1?-1:0:U)+e*n)%t+t)%t;if(!(H&&H[r]===!1)){Ee(r),W({dp:`focus-change`,index:r});return}}},J=H?H.filter(Boolean).length:z.length,Pe=R?R.diff.changeMarksTotal+R.diff.hintMarksTotal:0,Fe=!!L&&(m(L.artifact.content).summary??``).trim()!==(t.summary??``).trim(),Ie=e.version>1&&!l.recorded?e.agentReasoning?.trim():``,Le=t=>{let n=y[t];n&&(W({dp:`focus`,index:t}),a||(E.current=null,x({...n,version:e.version}),T(!0),C(e=>e+1)))},Y=M?.headings??[],Re=(0,A.useMemo)(()=>{let e=M?.headings.length??0,t=Array(e).fill(0),n=Array(e).fill(0);return M?(M.pins.length===v.length&&v.forEach((e,n)=>{let r=M.pins[n];r<0||e.humanResolvedAt||k&&k[n]===!1||(t[r]=(t[r]??0)+1)}),M.changes.length===z.length&&M.changes.forEach(e=>{e>=0&&(n[e]=(n[e]??0)+1)}),{comments:t,changes:n}):{comments:t,changes:n}},[M,v,k,z]),ze=e=>{let t=Y[e];t&&(ve(e),W({dp:`focus-heading`,index:e,locator:t.locator}))},Be=(0,A.useMemo)(()=>{let t=new Set;for(let n of v)n.target.artifactId&&n.target.artifactId!==e.id&&t.add(n.target.artifactId);return t},[v,e.id]),Ve=Nt((0,A.useMemo)(()=>[e,...I.map(e=>e.artifact).filter(e=>Be.has(e.id))],[e,I,Be]),N.length>0&&Be.size>0),He=(0,A.useMemo)(()=>{let t={artifactId:e.id,version:e.version},n=P.length===v.length,r=Ve(e.id),i=t=>t===e.id?void 0:Ve(t);return N.map((e,a)=>{let o=e.id?r?.find(t=>t.id===e.id)?.fullHash:void 0,s={...e,...o?{fullHash:o}:{}};return v.some((e,r)=>k&&k[r]===!1?!1:te(s,e,t,{insideByFrame:n&&P[r]===a&&k?.[r]===!0,earlierAsks:i}))})},[N,v,P,k,e.id,e.version,Ve]),Ue=e=>{let t=N[e];t&&W({dp:`focus-ask`,index:e,locator:t.locator})},We=t=>{let n=N[t],r=n?pt(n):null;!n||!r||a||(W({dp:`focus-ask`,index:t,locator:n.locator}),E.current=null,x({...r,version:e.version}),T(!0),C(e=>e+1))},X={headings:Y,commentCounts:Re.comments,changeCounts:B?Re.changes:[],active:_e,onJump:ze},Ge=b?f.filter(e=>{if(le(e.target.htmlAnchor,b))return!0;let t=v.find(t=>t.id===e.parentCommentId);return!!t&&le(t.target.htmlAnchor,b)}):[];return(0,Q.jsxs)(`div`,{className:`space-y-3`,"data-testid":`page-artifact`,ref:Ae,children:[t.summary&&(0,Q.jsx)(`div`,{className:`px-4 py-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg`,children:(0,Q.jsx)(ie,{text:t.summary,className:`prose-field text-sm text-text-primary space-y-2`})}),(t.sourcePath||t.concept)&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,children:[t.concept&&(0,Q.jsx)(de,{name:t.concept.name,explanation:t.concept.oneLineExplanation}),t.sourcePath&&(0,Q.jsxs)(`span`,{children:[`From `,(0,Q.jsx)(`code`,{className:`font-mono text-text-secondary`,children:t.sourcePath})]})]}),(Ie||l.recorded||L)&&(0,Q.jsxs)(`div`,{className:`px-3 py-2 rounded-lg border border-accent-violet/30 bg-accent-violet/5 space-y-1.5`,"data-testid":`page-version-changes`,children:[(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-baseline gap-x-3 gap-y-1`,children:[Ie&&(0,Q.jsxs)(`p`,{className:`text-xs text-text-primary`,"data-testid":`page-revise-reason`,children:[(0,Q.jsxs)(`span`,{className:`font-semibold text-accent-violet`,children:[`Why v`,e.version,`:`]}),` `,Ie]}),l.recorded&&(0,Q.jsxs)(`div`,{className:`text-2xs text-text-muted`,"data-testid":`page-file-recorded`,children:[`Recorded automatically from `,(0,Q.jsx)(`code`,{className:`font-mono text-text-secondary`,children:l.recorded.sourcePath}),` after a save, replacing v`,l.recorded.fromVersion,`.`,l.recorded.orphaned.length+(l.recorded.orphanedOverflow??0)>0&&(0,Q.jsxs)(Q.Fragment,{children:[` `,l.recorded.orphaned.length+(l.recorded.orphanedOverflow??0),` earlier comment(s) point at text that is no longer on the page.`]})]})]}),L&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,"data-testid":`page-changes-bar`,children:[(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>V(e=>!e),"aria-pressed":B,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,title:`Mark the blocks that are new, reworded or moved to another section since the version you compare with`,"data-testid":`page-changes-toggle`,children:[`Changes since v`,L.artifact.version,`: `,B?`on`:`off`]}),I.length>1&&(0,Q.jsxs)(`label`,{className:`inline-flex items-center gap-1`,children:[(0,Q.jsx)(`span`,{children:`Compare with`}),(0,Q.jsx)(`select`,{"aria-label":`Compare with`,value:L.artifact.id,onChange:t=>Ce({forId:e.id,baseId:t.target.value}),className:`bg-surface-elevated border border-border-default rounded px-1 py-0.5 text-text-secondary`,"data-testid":`page-compare-with`,children:I.map(e=>(0,Q.jsxs)(`option`,{value:e.artifact.id,children:[`v`,e.artifact.version,e.autoSave?` (auto-save)`:``]},e.artifact.id))})]}),we&&(0,Q.jsx)(`span`,{"data-testid":`page-changes-pending`,children:`Comparing…`}),R&&B&&z.length>0&&(0,Q.jsxs)(`span`,{className:`inline-flex items-center gap-1`,"data-testid":`page-changes-nav`,children:[(0,Q.jsxs)(`span`,{"data-testid":`page-changes-count`,children:[J,` `,J===1?`highlight`:`highlights`,U>=0&&J>0?` (at ${U+1})`:``]}),(0,Q.jsxs)(`span`,{className:`text-text-muted`,"data-testid":`page-changes-breakdown`,children:[`(`,R.diff.changeMarksTotal,` `,R.diff.changeMarksTotal===1?`change`:`changes`,R.diff.hintMarksTotal>0?` · ${R.diff.hintMarksTotal} author ${R.diff.hintMarksTotal===1?`hint`:`hints`}`:``,R.diff.unhighlightable>0?` · ${R.diff.unhighlightable} not highlightable`:``,Pe>z.length?`; showing ${z.length} of ${Pe}`:``,`)`]}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>Ne(-1),disabled:J===0,"aria-label":`Previous highlight`,className:`px-1 rounded border border-border-default hover:bg-surface-elevated disabled:opacity-40`,children:`‹`}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>Ne(1),disabled:J===0,"aria-label":`Next highlight`,className:`px-1 rounded border border-border-default hover:bg-surface-elevated disabled:opacity-40`,children:`›`})]}),R&&z.length===0&&R.diff.unhighlightable>0&&(0,Q.jsxs)(`span`,{"data-testid":`page-changes-unhighlightable`,children:[`(`,R.diff.unhighlightable,` `,R.diff.unhighlightable===1?`change`:`changes`,` not highlightable)`]}),R&&(0,Q.jsx)(Lt,{summary:R.summary,truncated:R.diff.truncated}),Fe&&(0,Q.jsx)(`span`,{"data-testid":`page-summary-changed`,children:`The summary above was updated too.`})]}),R&&(R.summary.removed.length>0||R.summary.removedSections.length>0)&&(0,Q.jsxs)(`details`,{className:`text-2xs`,"data-testid":`page-changes-removed`,children:[(0,Q.jsxs)(`summary`,{className:`cursor-pointer text-text-muted`,children:[`Removed since v`,R.base.version,` (not on the page any more)`]}),(0,Q.jsx)(`div`,{className:`pt-1`,children:(0,Q.jsx)(Rt,{summary:R.summary})})]})]}),l.refused&&!a&&(0,Q.jsxs)(`div`,{className:`px-3 py-2 rounded-lg border border-accent-amber/40 bg-accent-amber/10 text-xs text-text-primary`,role:`status`,"data-testid":`page-file-refused`,children:[`A later save to`,` `,(0,Q.jsx)(`code`,{className:`font-mono`,children:l.refused.sourcePath}),l.refused.cause===`gate`?(0,Q.jsxs)(Q.Fragment,{children:[` was not recorded: `,l.refused.message,`. You are still looking at v`,e.version,`.`]}):(0,Q.jsxs)(Q.Fragment,{children:[` could not be recorded: `,l.refused.message,`. You are still looking at v`,e.version,`.`]})]}),!a&&(0,Q.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2 text-2xs text-text-muted`,"data-testid":`page-pointing-bar`,children:[(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>xe(e=>!e),"aria-pressed":F,"aria-describedby":je,"aria-keyshortcuts":`Control+I Meta+I`,className:`px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary`,title:(F?`Clicks point at the page (${Ut()} to switch). Hold ⌘/Ctrl to let one click through; switch off to let every click reach the page.`:`Clicks reach the page (${Ut()} to switch). Switch on to point at things.`)+` After Run, use this toggle or press ${Ut()} outside the page.`,children:[F?`Pointing: on`:`Pointing: off`,(0,Q.jsx)(`kbd`,{className:`ml-1 font-mono text-[9px] text-text-muted`,children:Ut()})]}),(0,Q.jsxs)(`span`,{id:je,"data-testid":`page-pointing-hint`,children:[F?`Click anything on the page, or select text, to comment on that spot. In-page links, summaries, radio/checkbox tabs and form fields still work — Alt/Option-click to comment on one.`:`Pointing is off: clicks go to the page. Turn it on to comment on a spot.`,j&&` Scripts are running: to switch pointing, use this toggle or press ${Ut()} outside the page.`]})]}),(0,Q.jsx)(xt,{asks:N,answered:He,readOnly:a,onJump:Ue,onReply:We}),(0,Q.jsxs)(`div`,{className:`@container`,children:[Y.length>0&&(0,Q.jsx)(`div`,{className:`@3xl:hidden mb-2`,children:(0,Q.jsx)(yt,{...X,variant:`disclosure`})}),(0,Q.jsxs)(`div`,{className:`flex items-start gap-3`,children:[Y.length>0&&(0,Q.jsx)(`div`,{className:`hidden @3xl:block w-56 shrink-0 self-stretch`,children:(0,Q.jsx)(yt,{...X,variant:`rail`})}),(0,Q.jsx)(`div`,{className:`flex-1 min-w-0`,children:(0,Q.jsx)(ue,{html:t.html,maxBytes:h,staticFirst:!0,noun:`page`,frameClassName:`w-full h-[70vh] min-h-[420px] rounded border border-border-default bg-white`,annotation:Vt,iframeRef:n,onRunningChange:Me})})]})]}),b&&!a&&(0,Q.jsxs)(`div`,{className:`p-3 rounded-lg border border-accent-blue/30 bg-surface-elevated space-y-2`,ref:D,"data-testid":`page-anchor-composer`,children:[(0,Q.jsxs)(`div`,{className:`flex items-start gap-2`,children:[(0,Q.jsx)(`div`,{className:`flex-1 min-w-0`,children:(0,Q.jsx)(Kt,{anchor:b})}),(0,Q.jsx)(`button`,{type:`button`,onClick:()=>x(null),className:`text-2xs text-text-muted hover:text-text-secondary`,children:`Close`})]}),(0,Q.jsx)(ce,{artifactId:e.id,comments:Ge,target:{htmlAnchor:b},roomy:!0,focusOnOpen:w,placeholder:`Comment on this spot… (⌘⏎ to send)`,textareaLabel:`Comment on the selected spot`,secondarySubmitLabel:`Ask`,secondarySubmitTitle:`Post as a question about this spot — the agent owes you an answer`},S),(0,Q.jsx)(`div`,{className:`flex justify-end`,"data-testid":`page-rule-out`,children:(0,Q.jsx)(Bt,{artifactId:e.id,anchor:b,ruledOut:(()=>{let e=u(b.quote);return e&&_.has(e)?e:void 0})(),onRecorded:t=>g({description:t,sourceArtifactId:e.id})},S)})]}),v.length>0&&(0,Q.jsxs)(`div`,{className:`space-y-1.5`,"data-testid":`page-annotations`,children:[(0,Q.jsx)(`h3`,{className:`text-2xs font-semibold text-text-muted uppercase tracking-wide`,children:`On the page`}),(0,Q.jsx)(`ol`,{className:`space-y-1.5`,children:v.map((e,t)=>{let n=e.target.htmlAnchor,r=k?k[t]===!1:d.has(e.id);return(0,Q.jsx)(`li`,{children:(0,Q.jsxs)(`button`,{type:`button`,onClick:()=>Le(t),className:`w-full text-left flex gap-2 p-2 rounded border border-border-default hover:bg-surface-elevated`,"data-testid":`page-annotation`,children:[(0,Q.jsx)(`span`,{className:`shrink-0 w-5 h-5 rounded-full bg-accent-amber text-[11px] font-semibold text-black flex items-center justify-center`,children:t+1}),(0,Q.jsxs)(`span`,{className:`flex-1 min-w-0 space-y-1`,children:[(0,Q.jsx)(Kt,{anchor:n}),e.ruleOut&&_.has(e.ruleOut.description)&&(0,Q.jsxs)(`span`,{className:`block text-2xs text-accent-red`,"data-testid":`page-annotation-ruled-out`,children:[`Ruled out: Claude won't present a page that still contains “`,e.ruleOut.description,`”`]}),e.ruleOut&&!_.has(e.ruleOut.description)&&(0,Q.jsx)(`span`,{className:`block text-2xs text-text-muted`,"data-testid":`page-annotation-ruled-out-retired`,children:`Was ruled out; that stance has since been retired`}),r&&(0,Q.jsx)(`span`,{className:`block text-2xs text-accent-amber`,"data-testid":`page-anchor-missing`,children:`Not found in this version`}),(0,Q.jsx)(`span`,{className:`block text-xs text-text-primary line-clamp-3`,children:e.content})]})]})},e.id)})})]}),(0,Q.jsx)(pe,{artifact:e})]})}export{qt as PageArtifact};