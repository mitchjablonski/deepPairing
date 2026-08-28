import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@deeppairing/shared";
import { createPortal } from "react-dom";
import { useModal } from "../hooks/useModal";
import { DiagramRegionLayer, RegionCommentsFallback } from "./DiagramRegionLayer";
import { useArtifactStore } from "../stores/artifact";
import { usePreferencesStore } from "../stores/preferences";

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
// #189 — the non-theme mermaid config, applied once on load AND merged on every
// per-theme re-init below. `theme` is deliberately NOT here — it's chosen per
// render from the CURRENT app theme so light-theme cards don't get dark-filled
// nodes on a white surface.
const MERMAID_BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict" as const,
  fontFamily: "inherit",
  // On a bad diagram mermaid otherwise injects its OWN "Syntax error" bomb
  // graphic into document.body, which leaks to the bottom of the page —
  // pure noise, since we already show a clean fallback AND report the
  // failure to the agent (#176). With this set mermaid THROWS instead of
  // drawing it, and the existing catch below handles the throw (fallback +
  // report) unchanged. It also makes mermaid self-clean its temp layout
  // node before throwing (belt: we also remove ours in the catch).
  suppressErrorRendering: true,
};

/** #189 — map the app's resolved theme to a mermaid built-in theme. mermaid's
 *  "default" theme paints light node fills + dark text (legible on white cards);
 *  "dark" paints dark fills + light text (legible on the dark surface). */
export function mermaidThemeFor(appTheme: "light" | "dark"): "default" | "dark" {
  return appTheme === "light" ? "default" : "dark";
}

/** The resolved (never "system") app theme, read from the <html data-theme>
 *  attribute the preferences store stamps. Falls back to dark. */
function resolvedAppTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      m.default.initialize({ ...MERMAID_BASE_CONFIG, theme: mermaidThemeFor(resolvedAppTheme()) });
      return m.default;
    });
  }
  return mermaidReady;
}

let renderSeq = 0;

/**
 * BELT — orphan cleanup. `mermaid.render(id, src)` appends a temp layout node —
 * `#d<id>` (an enclosing div) wrapping `#<id>` (the svg) — to document.body to
 * measure the diagram. On a SUCCESSFUL render, and (with suppressErrorRendering)
 * on a THROW, mermaid removes it itself. This is a defensive net for the throw
 * paths in case a future mermaid change leaves the node behind: removing the
 * enclosing `d`-prefixed div takes its child svg with it; we drop the bare svg id
 * too for safety. Scoped to the EXACT id this component minted, so no unrelated
 * diagram's node is ever touched.
 */
function removeMermaidOrphan(id: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(`d${id}`)?.remove();
  document.getElementById(id)?.remove();
}

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

export function MermaidDiagram({
  source,
  region,
  report,
}: {
  source: string;
  // #140 — when present, the diagram becomes region-commentable (drag a rect /
  // pick a node). Passed ONLY for the interactive artifact view; a decision
  // preview or revision diff omits it and the diagram behaves exactly as before.
  // #173 — `optionId` (present only for a decision focused view) rides through
  // to the region layer so the comment anchors to optionId + visualId + region.
  region?: { artifactId: string; visualId: string; optionId?: string };
  // #176 (Option A) — when present, a GENUINE render failure (the #163 repair
  // pass also failed) POSTs a lightweight report so the agent learns the
  // diagram is broken. Ids + title only; the source is NEVER sent. Omitted for
  // contexts with no stable artifact/visual id (nothing to key a report on).
  report?: { artifactId: string; visualId: string; title?: string };
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // Q4 review (H1) — portal target for the region layer's flow chrome. State,
  // not a ref, so the layer re-renders into it the moment the node is attached.
  const [chromeHost, setChromeHost] = useState<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  // #189 — re-render the diagram when the app theme flips so mermaid re-themes
  // (dark fills on the dark surface, light fills on white cards). "system"
  // resolves through the <html data-theme> attr; subscribing to the store's
  // theme selector is what re-runs the render effect on a manual toggle. (A live
  // OS-level scheme change while theme==="system" re-themes on the next mount,
  // not instantly — an accepted edge, no cheap reactive signal for it.)
  const appTheme = usePreferencesStore((s) => s.theme);
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
  // #176 — true once a GENUINE failure has been reported to the agent, so the
  // fallback can show a subtle "reported" note. Reset per source below.
  const [reported, setReported] = useState(false);
  // #176 — dedupe: report ONCE per (artifactId, visualId, source), never per
  // re-render. Keyed by that tuple so a NEW source (or a re-presented visual)
  // reports afresh but a StrictMode double-invoke / re-render does not re-POST.
  const reportedKeyRef = useRef<string | null>(null);
  // #176 — `report` is a fresh object literal each render; hold it in a ref so
  // the render effect can read the CURRENT ids without listing `report` in its
  // deps (which would re-run — and reset — the whole render on every parent
  // re-render). Values are stable; only the object identity churns.
  const reportRef = useRef(report);
  reportRef.current = report;
  // #189 (Fix 2) — the source this component last STARTED rendering. A
  // theme-only re-render (same source, new appTheme) must keep the previous SVG
  // on screen while mermaid re-themes, so it never flashes the "Rendering…"
  // blank — which would unmount DiagramRegionLayer and drop an OPEN region
  // composer (unsent text + focus). Only a genuine SOURCE change clears state.
  const lastSourceRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sourceChanged = lastSourceRef.current !== source;
    lastSourceRef.current = source;
    // Clear render state only when the SOURCE changed. For a theme-only
    // re-render we leave svg/error/repaired/reported intact and swap the new
    // svg in when it arrives (below), so the diagram never blanks between themes.
    if (sourceChanged) {
      setSvg(null);
      setError(null);
      setRepaired(false);
      setReported(false);
    }
    // #176 — report a genuine render failure exactly once for this source. The
    // repair path is deliberately NOT reported (a successful auto-format isn't a
    // failure the agent must act on) — only the terminal error branches call it.
    const fireReport = (msg: string) => {
      const r = reportRef.current;
      if (!r || cancelled) return;
      const key = `${r.artifactId}|${r.visualId}|${source}`;
      // #189 (Fix 3) — a theme toggle re-runs the effect and re-fires the report
      // for an unchanged broken source. The dedupe still suppresses the re-POST,
      // but it must NOT drop the "Reported to the agent" note: it WAS reported,
      // so re-assert the flag the sourceChanged reset (skipped here) left alone.
      if (reportedKeyRef.current === key) { setReported(true); return; }
      reportedKeyRef.current = key;
      setReported(true);
      void useArtifactStore.getState().reportRenderFailure(r.artifactId, r.visualId, msg, r.title);
    };
    const src = (source ?? "").trim();
    if (!src) {
      setError("empty diagram");
      fireReport("empty diagram");
      return;
    }
    (async () => {
      const mermaid = await loadMermaid();
      // #189 — re-apply the CURRENT theme before rendering. mermaid's config is
      // global + singleton; initialize merges, so this flips only the theme
      // (base config stays). Every diagram shares the app theme, so the last
      // writer before a render wins — which is exactly this render's theme.
      mermaid.initialize({ ...MERMAID_BASE_CONFIG, theme: mermaidThemeFor(resolvedAppTheme()) });
      const rawId = `${idPrefix.current}-${++renderSeq}`;
      try {
        const { svg } = await mermaid.render(rawId, src);
        // setError(null) covers the theme-only path where we skipped the top
        // reset: a now-successful render must not stay masked by a stale error.
        if (!cancelled) { setSvg(svg); setError(null); setRepaired(false); }
        return;
      } catch (firstErr) {
        // suppressErrorRendering makes mermaid THROW here (no bomb graphic) and
        // self-clean its temp node — remove ours too as a belt (scoped to our id).
        removeMermaidOrphan(rawId);
        // Fuzzy-safe repair pass: agents commonly ship unquoted-punctuation
        // labels / `\n` breaks. Try once with a repaired source before giving up.
        const fixed = repairMermaidSource(src);
        if (fixed !== src) {
          const fixedId = `${idPrefix.current}-${++renderSeq}`;
          try {
            const { svg } = await mermaid.render(fixedId, fixed);
            if (!cancelled) {
              setSvg(svg);
              setRepaired(true);
              setError(null);
            }
            return;
          } catch {
            /* repair didn't help — fall through to the source fallback */
            removeMermaidOrphan(fixedId);
          }
        }
        if (!cancelled) {
          const msg = errorMessage(firstErr);
          setError(msg);
          // Genuine unrenderable diagram (raw failed AND the repair, if any,
          // failed) — tell the agent. Send only the first line of the error so
          // a multi-line parser dump can't smuggle much, and the daemon still
          // secret-scans it.
          fireReport(String(msg).split("\n")[0] ?? "render failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // appTheme drives a re-render+re-theme on a manual theme toggle (#189).
  }, [source, appTheme]);

  if (error) {
    return (
      <div className="space-y-1.5">
        <div className="text-2xs text-accent-amber">
          Couldn’t render this diagram ({error.split("\n")[0]}) — showing the source.
        </div>
        {/* #176 — minimal, honest signal that the agent will hear about this. */}
        {reported && (
          <div className="text-[10px] text-text-muted italic">
            Reported to the agent — it’ll fix the diagram source and re-present.
          </div>
        )}
        <pre className="text-2xs font-mono bg-surface-code rounded p-2 overflow-x-auto whitespace-pre text-text-secondary">
          {source}
        </pre>
        {/* Degradation: the diagram fell back to source, so there's nothing to
            drag over — but any region comments posted on an earlier (rendered)
            version must still be visible as text, never lost or crashed. */}
        {region && <RegionCommentsFallback artifactId={region.artifactId} visualId={region.visualId} />}
      </div>
    );
  }

  if (svg == null) {
    // #231 (round-10 UX #2) — mermaid's bundle lazy-loads + lays out on first
    // open, a 4-6s gap that used to show a bare "Rendering diagram…" line. A
    // diagram-SHAPED shimmer skeleton reads as "a diagram is coming" (not a
    // stall) and holds the layout so the card doesn't jump when the SVG lands.
    // Same bordered "well" as the rendered diagram; .animate-shimmer is
    // theme-aware (surface CSS vars) and static under prefers-reduced-motion.
    return (
      <div
        className="dp-mermaid-skeleton bg-surface-primary border border-border-default rounded-md p-4"
        role="status"
        aria-label="Rendering diagram…"
      >
        <span className="sr-only">Rendering diagram…</span>
        {/* A loose flowchart silhouette: three node blocks joined by edges. */}
        <div className="flex flex-col items-center gap-3" aria-hidden="true">
          <div className="animate-shimmer rounded-md h-8 w-2/5" />
          <div className="animate-shimmer rounded h-4 w-px min-h-[16px]" />
          <div className="flex items-start justify-center gap-8 w-full">
            <div className="animate-shimmer rounded-md h-8 w-1/3" />
            <div className="animate-shimmer rounded-md h-8 w-1/3" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Q4 (round-12 UX #1) — the control row sits ABOVE the canvas. Measured
          on a 13-node flowchart: the SVG rendered 718×1954px, so Expand and
          View source — the two controls that FIX an oversized diagram — landed
          1416px below the fold. You had to scroll past the problem to reach
          its remedy. Controls first, canvas second: both are reachable without
          scrolling regardless of how tall the diagram is. */}
      <div className="dp-mermaid-controls flex items-center gap-2">
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
      {/* Q4 — max-h-[60vh] + overflow-auto. Before, the ONLY cap was
          max-w-full: a 13-node flowchart grew its card to the SVG's natural
          1954px and pushed every following section (IMPLEMENTATION STEPS et
          al) three screens down. The diagram now scrolls INSIDE its well and
          the page below stays where you left it; Expand (above) is the escape
          hatch when 60vh isn't enough.

          The SCROLL container is the outer box and the region overlay lives
          INSIDE it, sharing one coordinate space with the canvas: the overlay
          is absolutely positioned against the inner `relative` wrapper, which
          is sized to the FULL diagram (not the 60vh viewport), so region
          highlights and the drag capture zone scroll with the diagram instead
          of drifting off it. Putting the cap on the host itself (with the
          overlay outside) would have desynced them — DiagramRegionLayer
          measures the SVG's rect against the overlay's parent and only
          re-measures on resize, never on scroll.

          The bounded "well" chrome (surface-primary + border-default) moves
          out here with the scrollport so it still frames the diagram as a
          distinct surface inside the bg-surface-secondary visual card ("can't
          tell where the diagram starts and ends, so selection might end
          early"). Both tokens are theme-aware: dark = a visibly darker inset
          well, light = a white panel with a real gray border (white/[0.06]
          borders vanish in the light theme). Mermaid paints its own node
          fills/text, so the bg only shows through between nodes. */}
      <div
        // Q4 — a scrollable region must be reachable by keyboard (axe
        // scrollable-region-focusable): the cap can hide diagram that a
        // mouse-less reader would otherwise never reach. role=group (not
        // region) keeps it OUT of the landmark set — one landmark per diagram
        // would flood the rotor on a multi-visual artifact.
        tabIndex={0}
        role="group"
        aria-label="Diagram — scrollable"
        // Q4 review (H2) — marks this box as the clipping viewport for anything
        // measuring against it (DiagramRegionLayer's popover clamp + scroll
        // listener). Generic attribute, not a mermaid class, so a future capped
        // host opts in the same way.
        data-dp-scrollport=""
        className="dp-mermaid-well overflow-auto max-h-[60vh] bg-surface-primary border border-border-default rounded-md"
      >
        <div className="relative">
          <div
            ref={hostRef}
            className="dp-mermaid flex justify-center [&_svg]:max-w-full [&_svg]:h-auto p-2"
            // mermaid output is sanitized at securityLevel "strict".
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          {region && (
            <DiagramRegionLayer
              artifactId={region.artifactId}
              visualId={region.visualId}
              optionId={region.optionId}
              svg={svg}
              hostRef={hostRef}
              chromeHost={chromeHost}
            />
          )}
        </div>
      </div>
      {/* Q4 review (H1/M3) — the region layer's FLOW chrome (the ⌨ keyboard
          node-picker, the locator list, the narrow-viewport block composer)
          lands here, OUTSIDE the capped scrollport. Inside it, all three were
          clipped: measured 817-834px below the visible well at rest, and every
          locator click scrolled the well — carrying the list you clicked out of
          view, so navigating cost a scroll round-trip each time. Rendered
          unconditionally (cheap empty div) so the portal target exists on the
          first commit and the chrome never flashes in the wrong place. */}
      {region && <div ref={setChromeHost} className="dp-mermaid-chrome" />}
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
