import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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

export function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  // Fullscreen lightbox — a diagram squeezed into a narrow column (e.g. one of
  // 3-4 decision options side by side) is unreadable; "Expand" opens it big.
  const [fullscreen, setFullscreen] = useState(false);
  // Stable per-instance id prefix so concurrent diagrams don't collide.
  const idPrefix = useRef(`dp-mmd-${++renderSeq}`);

  // Esc closes the lightbox (backdrop click + the ✕ button also close it).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    const src = (source ?? "").trim();
    if (!src) {
      setError("empty diagram");
      return;
    }
    (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(`${idPrefix.current}-${++renderSeq}`, src);
        if (!cancelled) setSvg(svg);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
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
      </div>
      {showSource && (
        <pre className="text-2xs font-mono bg-surface-code rounded p-2 overflow-x-auto whitespace-pre text-text-secondary">
          {source}
        </pre>
      )}
      {fullscreen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Diagram — fullscreen"
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setFullscreen(false)}
          >
            <div
              className="relative bg-surface-primary border border-white/10 rounded-lg shadow-2xl p-8 flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setFullscreen(false)}
                aria-label="Close fullscreen diagram"
                className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-white/10 transition-colors z-10"
              >
                ✕
              </button>
              {/* Fit the WHOLE diagram to the screen: target ~80vh tall (big +
                  crisp — it's vector) with width following the aspect ratio and
                  capped at the viewport so it never overflows or clips. The `!`
                  beats mermaid's own inline max-width. */}
              <div
                className="dp-mermaid-full [&_svg]:!h-[80vh] [&_svg]:!w-auto [&_svg]:!max-w-[92vw]"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
