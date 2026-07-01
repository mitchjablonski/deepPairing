import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModal } from "../hooks/useModal";

/**
 * Renders agent-authored Mermaid source to an SVG. Lazy-loads the (sizable)
 * mermaid bundle on first use so it never costs anything until a plan actually
 * carries a diagram.
 *
 * FUZZY-SAFE by design: the agent writes the Mermaid, so the source can be
 * malformed. A render failure NEVER throws to the boundary — it falls back to
 * showing the raw source plus the parser error, so a bad diagram degrades to a
 * code block instead of blanking the plan. securityLevel "strict" makes mermaid
 * sanitize the SVG (DOMPurify) so agent text in node labels can't inject script.
 */
let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return m.default;
    });
  }
  return mermaidReady;
}

let renderSeq = 0;

/**
 * Best-effort repair for the Mermaid mistakes agents make most: `\n` where they
 * meant a line break, and node/edge labels with punctuation — `()`, `#`, `:`,
 * `;` — left UNQUOTED, which Mermaid rejects. Applied ONLY after the raw source
 * fails to parse, so a valid diagram is never touched; a still-broken repair
 * just falls through to the source-code fallback. The transform is validated
 * against the REAL Mermaid parser in mermaid-repair.realparse.test.ts (the
 * MermaidDiagram unit tests mock mermaid, so they only check the string output).
 */
export function repairMermaidSource(src: string): string {
  // Literal \n → <br/> (a real line break); normalize CRLF first.
  let s = src.replace(/\r\n/g, "\n").replace(/\\n/g, "<br/>");
  // Dotted edge with inline text — `A -.text.-> B` — quote the text but keep the
  // dotted style (don't collapse it to a solid edge and lose the agent's intent).
  s = s.replace(/-\.\s*([^.|][^.]*?)\s*\.->/g, (_m, t: string) =>
    t.includes('"') ? `-.${t}.->` : `-."${t.trim()}".->`,
  );
  // Quote labels containing chars Mermaid rejects unquoted, per delimiter.
  const NEEDS = /[()#:;<]/;
  // The negative lookaheads keep the repair from STARTING a match on a shape
  // sub-delimiter — cylinder `[( )]`, parallelogram `[/ /]`, trapezoid `[/ \]`,
  // subroutine `[[ ]]`, hexagon `{{ }}`. Without them a shape whose label has
  // `()`/`<` would be re-quoted as a plain rectangle: a *wrong-but-parseable*
  // render, worse than the source fallback. Guarded, those shapes fall through
  // to source (benign); plain rectangles / rhombus / edge labels still repair.
  s = s.replace(/\[(?![([/\\])([^[\]"']*?)\]/g, (m, i: string) => (NEEDS.test(i) ? `["${i.trim()}"]` : m));
  s = s.replace(/\{(?![{])([^{}"']*?)\}/g, (m, i: string) => (NEEDS.test(i) ? `{"${i.trim()}"}` : m));
  s = s.replace(/\|([^|"']*?)\|/g, (m, i: string) => (NEEDS.test(i) ? `|"${i.trim()}"|` : m));
  return s;
}

export function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  // True when the raw source failed but repairMermaidSource made it render.
  const [repaired, setRepaired] = useState(false);
  // Fullscreen lightbox — a diagram squeezed into a narrow column (e.g. one of
  // 3-4 decision options side by side) is unreadable; "Expand" opens it big.
  const [fullscreen, setFullscreen] = useState(false);
  // The lightbox is a modal: useModal gives it presence-suppression, focus
  // trap+restore, role/aria-modal, and Esc — active only while fullscreen.
  const { dialogProps } = useModal({ active: fullscreen, onClose: () => setFullscreen(false) });
  // Stable per-instance id prefix so concurrent diagrams don't collide.
  const idPrefix = useRef(`dp-mmd-${++renderSeq}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    setRepaired(false);
    const src = (source ?? "").trim();
    if (!src) {
      setError("empty diagram");
      return;
    }
    (async () => {
      const mermaid = await loadMermaid();
      try {
        const { svg } = await mermaid.render(`${idPrefix.current}-${++renderSeq}`, src);
        if (!cancelled) setSvg(svg);
        return;
      } catch (firstErr: any) {
        // Fuzzy-safe repair pass: agents commonly ship unquoted-punctuation
        // labels / `\n` breaks. Try once with a repaired source before giving up.
        const fixed = repairMermaidSource(src);
        if (fixed !== src) {
          try {
            const { svg } = await mermaid.render(`${idPrefix.current}-${++renderSeq}`, fixed);
            if (!cancelled) {
              setSvg(svg);
              setRepaired(true);
            }
            return;
          } catch {
            /* repair didn't help — fall through to the source fallback */
          }
        }
        if (!cancelled) setError(firstErr?.message ?? String(firstErr));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="space-y-1.5">
        <div className="text-2xs text-accent-amber">
          Couldn’t render this diagram ({error.split("\n")[0]}) — showing the source.
        </div>
        <pre className="text-2xs font-mono bg-surface-code rounded p-2 overflow-x-auto whitespace-pre text-text-secondary">
          {source}
        </pre>
      </div>
    );
  }

  if (svg == null) {
    return <div className="text-2xs text-text-muted py-3 text-center">Rendering diagram…</div>;
  }

  return (
    <div className="space-y-1">
      <div
        className="dp-mermaid overflow-x-auto flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
        // mermaid output is sanitized at securityLevel "strict".
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => setFullscreen(true)}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs font-medium text-text-secondary border border-white/10 hover:text-text-primary hover:bg-white/[0.06] hover:border-white/20 transition-colors"
          title="View this diagram fullscreen"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="shrink-0">
            <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
          </svg>
          Expand
        </button>
        <button
          onClick={() => setShowSource((s) => !s)}
          className="text-[10px] text-text-muted hover:text-text-secondary px-1"
        >
          {showSource ? "Hide source" : "View source"}
        </button>
        {repaired && (
          <span
            className="text-[10px] text-text-muted italic"
            title="The agent's Mermaid had unquoted labels or \n line breaks; auto-formatted so it renders. 'View source' shows the original."
          >
            · auto-formatted
          </span>
        )}
      </div>
      {showSource && (
        <pre className="text-2xs font-mono bg-surface-code rounded p-2 overflow-x-auto whitespace-pre text-text-secondary">
          {source}
        </pre>
      )}
      {fullscreen &&
        createPortal(
          // z-50 matches the app's modal tier (toasts sit at z-[60] ABOVE modals
          // on purpose, so a failure toast raised over the lightbox stays visible).
          <div
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6"
            onClick={() => setFullscreen(false)}
          >
            <div
              {...dialogProps}
              aria-label="Diagram — fullscreen"
              className="relative bg-surface-primary border border-white/10 rounded-lg shadow-2xl p-6 sm:p-8 max-w-[96vw] max-h-[94vh] overflow-auto flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setFullscreen(false)}
                aria-label="Close fullscreen diagram"
                className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-white/10 transition-colors z-10"
              >
                ✕
              </button>
              {/* Same sanitized SVG string as the inline copy. Note: mermaid ids
                  (incl. arrowhead <marker> defs) are duplicated across the two
                  copies; url(#id) resolves to the first in document order (the
                  always-mounted inline copy), so this copy's arrowheads render
                  fine as long as the inline one stays mounted (it always does).
                  Fit the WHOLE diagram to the screen: target ~80vh tall (big +
                  crisp — it's vector) with width following the aspect ratio and
                  capped at the viewport so it never overflows or clips. The `!`
                  beats mermaid's own inline max-width. */}
              <div
                className="dp-mermaid-full [&_svg]:!h-[80vh] [&_svg]:!w-auto [&_svg]:!max-w-[88vw]"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
