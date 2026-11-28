// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true}}
/**
 * #727 — post-Run forged diagnostics. The annotator is the first script in
 * the frame document and carries the per-srcdoc id the parent requires on
 * ready/diagnostics. After Run the page's own scripts execute; they must not
 * be able to read that id, or they could post a forged diagnostics message
 * the parent would accept. Evaluated as a REAL inline <script> (own file: the
 * full script installs window listeners with no uninstall handle).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { annotatorScript, ANNOTATOR_CORE_SOURCE, ANNOTATOR_MAIN_SOURCE } from "../pageAnnotator";
import { acceptDiagnosticsReport } from "../pageAnchorMessages";

const DOC = "0123456789abcdef0123456789abcdef";
const posted: any[] = [];
let realPost: typeof window.postMessage;

// happy-dom has no Event.isTrusted. Test-level shim: an event is trusted only
// when the test plays the BROWSER (browserDispatch); anything else, like a
// page's own dispatchEvent, is isTrusted === false, as in a real browser.
const trusted = new WeakSet<Event>();
function browserDispatch(target: EventTarget, ev: Event) {
  trusted.add(ev);
  target.dispatchEvent(ev);
}
function scriptErrorEvent(name: string) {
  return new ErrorEvent("error", { message: `${name}: boom`, error: { name } });
}
function cspEvent(directive: string) {
  const ev = new Event("securitypolicyviolation") as Event & { effectiveDirective?: string };
  ev.effectiveDirective = directive;
  return ev;
}
const settle = () => new Promise((r) => setTimeout(r, 400));
const lastDiag = () => posted.filter((m) => m?.dp === "diagnostics").at(-1);

// The annotator's own listeners, recorded as it boots, so a test can play the
// browser invoking them directly (with no happy-dom dispatch in between).
const listeners: Record<string, EventListener[]> = {};
function record(target: EventTarget) {
  const add = target.addEventListener;
  target.addEventListener = function (this: EventTarget, type: string, fn: any, opts?: any) {
    (listeners[type] ??= []).push(fn as EventListener);
    return add.call(this, type, fn, opts);
  } as typeof target.addEventListener;
  return () => { target.addEventListener = add; };
}

beforeAll(() => {
  Object.defineProperty(Event.prototype, "isTrusted", {
    configurable: true,
    get(this: Event) { return trusted.has(this); },
  });
  // `parent` is this window here: record what the annotator posts (index
  // assignment, so a test's Array.prototype patch can't disturb the recorder).
  realPost = window.postMessage;
  window.postMessage = ((msg: unknown) => {
    posted[posted.length] = msg;
  }) as typeof window.postMessage;
  const s = document.createElement("script");
  s.setAttribute("data-probe", "annotator");
  s.textContent = annotatorScript(DOC);
  const unW = record(window), unD = record(document);
  document.head.appendChild(s);
  unW();
  unD();
  // A "page script" that runs after the annotator, as agent script does after Run.
  if (!posted.some((m) => m?.dp === "ready")) window.dispatchEvent(new Event("load"));
});
afterAll(() => {
  window.postMessage = realPost;
  delete (Event.prototype as { isTrusted?: unknown }).isTrusted;
});

describe("annotator scrubs its document id before page script can run (#727)", () => {
  it("boots and still stamps the injected id on ready (closure keeps it)", () => {
    expect(posted.find((m) => m?.dp === "ready")?.doc).toBe(DOC);
  });

  it("removes its own <script> node: the id is nowhere in the DOM", () => {
    expect(document.querySelector("script[data-probe=annotator]")).toBeNull();
    for (const sc of Array.from(document.scripts)) expect(sc.textContent ?? "").not.toContain(DOC);
    expect(document.documentElement.outerHTML).not.toContain(DOC);
    for (const el of Array.from(document.querySelectorAll("*"))) {
      for (const a of Array.from(el.attributes)) expect(a.value).not.toContain(DOC);
    }
  });

  it("leaves no global carrying the id", () => {
    const w = window as unknown as Record<string, unknown>;
    expect(w.DP_DOC).toBeUndefined();
    expect(w.docId).toBeUndefined();
    for (const k of Object.getOwnPropertyNames(window)) {
      let v: unknown;
      try { v = w[k]; } catch { continue; }
      if (typeof v === "string") expect(v).not.toContain(DOC);
    }
  });

  it("a page-patched JSON.stringify / Object.prototype.toJSON never sees the id on a diagnostics report", async () => {
    const seen: string[] = [];
    const realStringify = JSON.stringify;
    const proto = Object.prototype as unknown as { toJSON?: unknown };
    JSON.stringify = function (this: unknown, v: unknown, ...rest: unknown[]) {
      try { seen.push(String((v as { doc?: unknown })?.doc ?? "")); } catch { /* ignore */ }
      return (realStringify as (...a: unknown[]) => string)(v, ...rest);
    } as typeof JSON.stringify;
    Object.defineProperty(proto, "toJSON", {
      configurable: true,
      value: function (this: { doc?: unknown }) { seen.push(String(this?.doc ?? "")); return this; },
    });
    try {
      browserDispatch(window, scriptErrorEvent("TypeError"));
      await settle();
    } finally {
      JSON.stringify = realStringify;
      delete proto.toJSON;
    }
    const diag = posted.filter((m) => m?.dp === "diagnostics");
    expect(diag.length).toBeGreaterThan(0);
    expect(diag.at(-1).doc).toBe(DOC);
    expect(seen.join(",")).not.toContain(DOC);
  });

  it("ignores synthetic (page-dispatched) error, rejection and CSP events", async () => {
    const before = lastDiag();
    window.dispatchEvent(scriptErrorEvent("RangeError"));
    const rej = new Event("unhandledrejection") as Event & { reason?: unknown };
    rej.reason = new Error("forged");
    window.dispatchEvent(rej);
    document.dispatchEvent(cspEvent("img-src"));
    await settle();
    expect(lastDiag()).toEqual(before);
    expect(JSON.stringify(posted)).not.toMatch(/RangeError|forged|img-src/);
  });

  it("a patched Array.prototype (sort/slice/push/indexOf, index setter, species) can't change the posted keys", async () => {
    const AP = Array.prototype as any;
    const saved = { sort: AP.sort, slice: AP.slice, push: AP.push, indexOf: AP.indexOf, constructor: AP.constructor };
    // Genuine baseline first: two CSP blocks, out of allowlist order.
    browserDispatch(document, cspEvent("connect-src"));
    browserDispatch(document, cspEvent("img-src"));
    await settle();
    expect(lastDiag().blocked).toEqual([{ key: "img-src", count: 1 }, { key: "connect-src", count: 1 }]);
    const evil = function (this: unknown[]) { return [{ key: "frame-ancestors", count: 9999 }]; };
    let setterHits = 0;
    const onError = listeners.error?.[0] as EventListener, onCsp = listeners.securitypolicyviolation?.[0] as EventListener;
    expect(typeof onError).toBe("function");
    expect(typeof onCsp).toBe("function");
    try {
      AP.sort = evil;
      AP.slice = evil;
      AP.push = function () { return 0; };
      AP.indexOf = function () { return 0; };
      AP.constructor = { [Symbol.species]: function () { return [{ key: "forged", count: 1 }]; } };
      Object.defineProperty(AP, "0", { configurable: true, set() { setterHits++; }, get() { return { key: "forged", count: 1 }; } });
      // The browser invokes the annotator's listeners with trusted events;
      // the handlers, the report, the dedupe and the ranking all run patched.
      onCsp({ isTrusted: true, effectiveDirective: "img-src" } as unknown as Event);
      onError({ isTrusted: true, message: "RangeError: deep", error: { name: "RangeError" } } as unknown as Event);
      await settle();
    } finally {
      delete AP[0];
      Object.assign(AP, saved);
    }
    const d = lastDiag();
    expect(d.doc).toBe(DOC);
    expect(d.blocked).toEqual([{ key: "img-src", count: 2 }, { key: "connect-src", count: 1 }]);
    expect(d.scriptErrors.classes).toEqual([{ key: "TypeError", count: 1 }, { key: "RangeError", count: 1 }]);
    expect(d.scriptErrors.samples).toEqual(["TypeError: boom", "RangeError: deep"]);
    expect(setterHits).toBe(0);
  });

  it("patched String/RegExp builtins can't relabel a trusted CSP or error event, or skip redaction", async () => {
    const count = (l: { key: string; count: number }[] | undefined, k: string) => l?.find((x) => x.key === k)?.count ?? 0;
    const before = lastDiag();
    const onError = listeners.error?.[0] as EventListener, onCsp = listeners.securitypolicyviolation?.[0] as EventListener;
    const SP = String.prototype as any, RP = RegExp.prototype as any;
    const saved = { toLowerCase: SP.toLowerCase, replace: SP.replace, split: SP.split, trim: SP.trim, exec: RP.exec, symReplace: RP[Symbol.replace] };
    try {
      SP.toLowerCase = function () { return "img-src"; };
      SP.replace = function (this: string) { return String(this); };
      SP.split = function () { return ["img-src"]; };
      RP.exec = function () { return null; };
      RP[Symbol.replace] = function (s: string) { return s; };
      onCsp({ isTrusted: true, effectiveDirective: "Connect-Src extra" } as unknown as Event);
      onError({ isTrusted: true, message: "RangeError: fetch https://user:pw@evil.example/a?k=1 failed", error: {} } as unknown as Event);
    } finally {
      Object.assign(SP, { toLowerCase: saved.toLowerCase, replace: saved.replace, split: saved.split, trim: saved.trim });
      RP.exec = saved.exec;
      RP[Symbol.replace] = saved.symReplace;
    }
    await settle();
    const d = lastDiag();
    expect(count(d.blocked, "connect-src")).toBe(count(before?.blocked, "connect-src") + 1);
    expect(count(d.blocked, "img-src")).toBe(count(before?.blocked, "img-src"));
    expect(count(d.scriptErrors.classes, "RangeError")).toBe(count(before?.scriptErrors.classes, "RangeError") + 1);
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/evil\.example|user:pw/);
    expect(d.scriptErrors.samples).toContain("RangeError: fetch [url] failed");
  });

  it("a patched WeakSet.prototype.has can't defeat the per-element resource dedupe", async () => {
    const onError = listeners.error?.[0] as EventListener;
    const img = document.createElement("img");
    img.setAttribute("src", "missing.png");
    document.body.appendChild(img);
    const before = lastDiag()?.resources?.find((x: { key: string }) => x.key === "img src")?.count ?? 0;
    const WP = WeakSet.prototype as any;
    const savedHas = WP.has;
    try {
      WP.has = function () { return false; };
      onError({ isTrusted: true, target: img } as unknown as Event);
      onError({ isTrusted: true, target: img } as unknown as Event);
    } finally {
      WP.has = savedHas;
    }
    await settle();
    expect(lastDiag().resources.find((x: { key: string }) => x.key === "img src")?.count).toBe(before + 1);
  });

  it('both shipped sources start with "use strict" (no fn.arguments / CallSite walk to the id closure)', () => {
    expect(ANNOTATOR_CORE_SOURCE.trimStart().startsWith('"use strict";')).toBe(true);
    expect(ANNOTATOR_MAIN_SOURCE.trimStart().startsWith('"use strict";')).toBe(true);
  });

  it("a forged diagnostics message without the id is rejected by the parent's parser or doc check", () => {
    const forged = {
      dp: "diagnostics",
      scriptErrors: { count: 1, samples: ["fake"], classes: [{ key: "TypeError", count: 1 }] },
      rejections: { count: 0, samples: [], classes: [] },
      resources: [],
      blocked: [],
    };
    const frame = window;
    const accept = (data: unknown) => acceptDiagnosticsReport({ source: frame, data } as Pick<MessageEvent, "source" | "data">, frame);
    // The genuine report is accepted and names this document.
    expect(accept(posted.filter((m) => m?.dp === "diagnostics").at(-1))?.doc).toBe(DOC);
    // No id at all: the schema refuses it.
    expect(accept(forged)).toBeNull();
    // A guessed id parses but names another document: the parent's
    // current-document check (doc === frameDocRef.current) drops it.
    expect(accept({ ...forged, doc: "ffffffffffffffffffffffffffffffff" })?.doc).not.toBe(DOC);
  });
});
