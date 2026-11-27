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
import { annotatorScript } from "../pageAnnotator";
import { acceptDiagnosticsReport } from "../pageAnchorMessages";

const DOC = "0123456789abcdef0123456789abcdef";
const posted: any[] = [];
let realPost: typeof window.postMessage;

beforeAll(() => {
  // `parent` is this window in jsdom: record what the annotator posts.
  realPost = window.postMessage;
  window.postMessage = ((msg: unknown) => {
    posted.push(msg);
  }) as typeof window.postMessage;
  const s = document.createElement("script");
  s.setAttribute("data-probe", "annotator");
  s.textContent = annotatorScript(DOC);
  document.head.appendChild(s);
  // A "page script" that runs after the annotator, as agent script does after Run.
  if (!posted.some((m) => m?.dp === "ready")) window.dispatchEvent(new Event("load"));
});
afterAll(() => {
  window.postMessage = realPost;
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
      window.dispatchEvent(new ErrorEvent("error", { message: "TypeError: boom", error: { name: "TypeError" } }));
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      JSON.stringify = realStringify;
      delete proto.toJSON;
    }
    const diag = posted.filter((m) => m?.dp === "diagnostics");
    expect(diag.length).toBeGreaterThan(0);
    expect(diag.at(-1).doc).toBe(DOC);
    expect(seen.join(",")).not.toContain(DOC);
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
