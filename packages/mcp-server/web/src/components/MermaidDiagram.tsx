import { useEffect, useRef, useState } from "react";

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
  // Stable per-instance id prefix so concurrent diagrams don't collide.
  const idPrefix = useRef(`dp-mmd-${++renderSeq}`);

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
      <button
        onClick={() => setShowSource((s) => !s)}
        className="text-[10px] text-text-muted hover:text-text-secondary"
      >
        {showSource ? "Hide source" : "View source"}
      </button>
      {showSource && (
        <pre className="text-2xs font-mono bg-surface-code rounded p-2 overflow-x-auto whitespace-pre text-text-secondary">
          {source}
        </pre>
      )}
    </div>
  );
}
