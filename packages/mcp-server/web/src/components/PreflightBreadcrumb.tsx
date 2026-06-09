import { useEffect, useMemo, useRef, useState } from "react";
import { useLedgerStore, ensureLedgerSubscriptions } from "../stores/ledger";
import type { PreflightTrace } from "@deeppairing/shared";
import { apiBase, sessionHeaders } from "../lib/api";

/**
 * Y1' — "Cross-checked your N prior stances before proposing this."
 *
 * The most distinctive deepPairing mechanic — preflight against the
 * philosophy ledger — used to be invisible 99% of the session. The
 * hero block-toast fires only on a rejection match, so a user could
 * pair for an hour and never see the moat at work. PMF council round 2:
 * the breadcrumb makes the silent guard a steady drumbeat.
 *
 * Render rules (council round 2 amendments):
 * - HIDE entirely when no trace exists (older artifact, daemon-client
 *   store, or pre-Y1' install).
 * - HIDE when the trace recorded zero stances (a fresh ledger →
 *   "Cross-checked 0 prior stances" reads as "broken", not as "nothing
 *   to compare to"). When the user has accumulated stances, the line
 *   becomes meaningful.
 * - Click expands the considered concepts + near-misses inline; no
 *   modal, no navigation away from the artifact.
 *
 * Pairing-thesis copy (PMF council round 2 — over engineering chrome):
 *   "Cross-checked your N prior stances before proposing this."
 *   Near-miss line: "Almost flagged this — your past stance on `X` is adjacent."
 */

/**
 * AA6.5 — bootstrap-dismissed flag, scoped by projectRoot in localStorage.
 *
 * Pre-AA6.5 this lived in sessionStorage with a single global key, so:
 *   - Refreshing the browser re-showed the empty-ledger card every time
 *     (sessionStorage clears on tab close, which a refresh effectively is
 *     for this purpose). Seeing the same "your ledger is empty" twice
 *     reads as "broken", not "fresh start".
 *   - The flag was global across projects: dismissing in project A also
 *     dismissed in project B, so a user with multiple projects only
 *     learned about the moat in their first project.
 *
 * AA6.5 fix: localStorage (survives refresh) + key scoped by projectRoot
 * (each project re-onboards once). Plus an implicit dismiss when ANY
 * trace event with consideredCount > 0 lands — once the user has a
 * ledger, the bootstrap card is moot.
 */
const BOOTSTRAP_DISMISSED_KEY_PREFIX = "dp:preflight-bootstrap-dismissed:";

function bootstrapKey(projectRoot: string | null): string {
  return BOOTSTRAP_DISMISSED_KEY_PREFIX + (projectRoot ?? "_unscoped");
}

function readBootstrapDismissed(projectRoot: string | null): boolean {
  try { return localStorage.getItem(bootstrapKey(projectRoot)) === "1"; } catch { return false; }
}

function writeBootstrapDismissed(projectRoot: string | null): void {
  try { localStorage.setItem(bootstrapKey(projectRoot), "1"); } catch {}
}

/**
 * AA8 — visual tier classifier. PMF council Z review pushed back hard
 * on the always-on violet box: "with 50 artifacts that's 50 violet bars
 * saying 'trust me, I checked' — turns the moat into a status bar."
 * The deep dive's third-option resolution: scarcity = signal. Render
 * tiered:
 *
 *   "bootstrap" — empty-ledger onboarding card (existing AA6.5 copy).
 *   "signal"    — full violet card (current Z3 treatment) ONLY when
 *                 there's a near-miss OR a team-source concept was
 *                 weighed. These are the concrete pairing moments
 *                 worth dedicated chrome.
 *   "ambient"   — single muted line with the violet ◆ glyph but no
 *                 box, no border, no bg-tint. The drumbeat stays
 *                 (every artifact still surfaces "N stances shaped
 *                 this") but reads as provenance, not chrome.
 *
 * Pure helper so it's testable without rendering. Exported for the
 * tier-classification test below the component file.
 */
export type PreflightTier = "bootstrap" | "ambient" | "signal";

/**
 * DD6 + EE3 — escalate ambient → signal when a considered concept has
 * accumulated either:
 *   - ≥ CITATION_SIGNAL_THRESHOLD project-local citations (DD6), OR
 *   - ≥ GLOBAL_CITATION_SIGNAL_THRESHOLD cross-project citations (EE3).
 *
 * Pre-EE3 the rule was project-local only — directly contradicting the
 * cross-project moat positioning. PMF council: a stance the user has
 * rejected in 3 sister projects but never in this one rendered as
 * ambient, exactly the opposite of what the pitch promises. The
 * cross-project threshold is higher (5 vs 3) since global signal is
 * broader; the dual-rule means either path gets the violet card.
 */
const CITATION_SIGNAL_THRESHOLD = 3;
const GLOBAL_CITATION_SIGNAL_THRESHOLD = 5;

export interface ConceptCitationCount {
  /** Citations in this project. */
  project: number;
  /** Citations across all projects (EE3). */
  global: number;
}

export function classifyPreflightTier(
  trace: PreflightTrace,
  citationCounts?: Record<string, number | ConceptCitationCount>,
): PreflightTier {
  if (trace.consideredCount === 0) return "bootstrap";
  if (trace.nearMisses.length > 0) return "signal";
  if (trace.consideredConcepts.some((c) => c.source === "team")) return "signal";
  if (citationCounts) {
    for (const c of trace.consideredConcepts) {
      const entry = citationCounts[c.concept];
      // Back-compat: a bare number means project-local count only.
      const projectN = typeof entry === "number" ? entry : (entry?.project ?? 0);
      const globalN = typeof entry === "number" ? entry : (entry?.global ?? 0);
      if (projectN >= CITATION_SIGNAL_THRESHOLD) return "signal";
      if (globalN >= GLOBAL_CITATION_SIGNAL_THRESHOLD) return "signal";
    }
  }
  return "ambient";
}

interface PreflightBreadcrumbProps {
  artifactId: string;
}

export function PreflightBreadcrumb({ artifactId }: PreflightBreadcrumbProps) {
  const [trace, setTrace] = useState<PreflightTrace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  // AA6.5 — projectRoot scopes the bootstrap-dismissed flag (each
  // project re-onboards once). Read off the connection store via the
  // same window-bag pattern lib/api.ts uses, so this stays a leaf
  // component without subscribing to the whole zustand store.
  const projectRoot: string | null = (() => {
    if (typeof window === "undefined") return null;
    try {
      return (window as any).__dpConnectionStore?.getState?.()?.projectRoot ?? null;
    } catch { return null; }
  })();
  // AA6.5 — local mirror so the dismiss click re-renders THIS instance
  // (localStorage writes don't trigger re-render).
  const [bootstrapDismissed, setBootstrapDismissed] = useState<boolean>(
    () => readBootstrapDismissed(projectRoot),
  );

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setTrace(null);
    setOpen(false);
    fetch(`${apiBase()}/api/artifacts/${encodeURIComponent(artifactId)}/preflight-trace`, {
      headers: sessionHeaders(),
    })
      .then((r) => (r.ok ? r.json() : { trace: null }))
      .then((body) => {
        if (cancelled) return;
        setTrace(body?.trace ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    // Y1' — listen for the live broadcast so the breadcrumb appears the
    // moment the agent records a fresh trace, without an HTTP roundtrip.
    // AA6.5 — also implicit-dismiss the bootstrap when ANY trace event
    // with consideredCount > 0 lands (cross-artifact, not just this one).
    // Once the project has a non-empty trace, the user has a ledger; the
    // "your ledger is empty" copy is moot.
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { artifactId?: string; trace?: PreflightTrace }
        | undefined;
      if (!detail) return;
      if (detail.trace && (detail.trace.consideredCount ?? 0) > 0) {
        if (!readBootstrapDismissed(projectRoot)) {
          writeBootstrapDismissed(projectRoot);
          setBootstrapDismissed(true);
        }
      }
      if (detail.artifactId !== artifactId) return;
      if (detail.trace) setTrace(detail.trace);
    };
    window.addEventListener("dp:preflight-trace", handler as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener("dp:preflight-trace", handler as EventListener);
    };
  }, [artifactId, projectRoot]);

  // EE2 — citation counts come from the shared ledger store. Pre-EE2
  // each breadcrumb mounted its own /api/ledger/digest fetch + WS
  // listener; with 50 artifacts on screen + a fresh trace event, that
  // was 50 redundant network roundtrips per broadcast. Now one fetch,
  // one listener, all subscribers re-render via the Zustand selector.
  useEffect(() => {
    ensureLedgerSubscriptions();
  }, []);
  const topCitedStances = useLedgerStore((s) => s.digest?.topCitedStances);
  const citationCounts = useMemo<Record<string, ConceptCitationCount>>(() => {
    const map: Record<string, ConceptCitationCount> = {};
    for (const s of topCitedStances ?? []) {
      if (typeof s.concept !== "string") continue;
      const project = typeof s.citationCount === "number" ? s.citationCount : 0;
      // EE3 — globalCitationCount falls back to project count when the
      // server didn't ship the field (back-compat with pre-EE3 fixtures).
      const global = typeof s.globalCitationCount === "number" ? s.globalCitationCount : project;
      map[s.concept] = { project, global };
    }
    return map;
  }, [topCitedStances]);

  // EE9 — hysteresis latch. Must be declared BEFORE the early returns
  // so React's rules-of-hooks see a consistent call order across
  // renders. Once a breadcrumb classifies as signal in a given mount,
  // latch and never downgrade to ambient. Pre-EE9 a popular stance
  // hovering at threshold could flicker signal→ambient as
  // /api/ledger/digest's topCitedStances reordered when new traces
  // landed (CC4 live-refetch + DD6 citation map). Visually: chrome
  // (border, bg-tint, padding) appeared and disappeared on every
  // broadcast. Latch protects the user from the flap.
  const signalLatch = useRef(false);

  if (!loaded) return null;
  if (!trace) return null;

  // AA8 — three-tier render. See classifyPreflightTier above for rules.
  // DD6 — pass citationCounts so self-source ambient → signal escalates
  // when any considered concept has been cited ≥ 3 times in the project.
  const computedTier = classifyPreflightTier(trace, citationCounts);
  if (computedTier === "signal") signalLatch.current = true;
  const tier = signalLatch.current && computedTier === "ambient" ? "signal" : computedTier;

  // Bootstrap — empty-ledger onboarding (Z3 + AA6.5 copy + dismiss flow).
  if (tier === "bootstrap") {
    if (bootstrapDismissed) return null;
    return (
      <div
        role="status"
        aria-label="Empty philosophy ledger"
        className="border border-accent-violet/20 bg-accent-violet-dim/15 rounded px-3 py-2 mb-2 text-2xs text-text-secondary"
      >
        <div className="flex items-start gap-2">
          <span aria-hidden className="text-accent-violet shrink-0 mt-0.5">◆</span>
          <div className="flex-1">
            <div className="text-text-primary mb-0.5">
              Your philosophy ledger is empty.
            </div>
            <div className="leading-relaxed">
              Reject something — or add reasoning to a pick — and future
              proposals will get cross-checked against it. The breadcrumb
              shows up here when there's something to compare against.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              writeBootstrapDismissed(projectRoot);
              setBootstrapDismissed(true);
            }}
            className="text-text-muted hover:text-text-primary text-2xs px-1.5 py-0.5 rounded hover:bg-surface-hover transition-colors shrink-0"
            aria-label="Dismiss bootstrap message"
            title="Don't show this again this session"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  const n = trace.consideredCount;
  const hasDetails = trace.consideredConcepts.length > 0 || trace.nearMisses.length > 0;
  const nearMiss = trace.nearMisses[0];

  // Shared expand-on-click headline. Same affordance for both tiers; the
  // wrapping container differs (signal = violet box; ambient = bare row).
  const Headline = (
    <button
      type="button"
      onClick={() => hasDetails && setOpen((v) => !v)}
      className={`inline-flex items-center gap-1.5 ${
        hasDetails ? "cursor-pointer" : "cursor-default"
      } ${tier === "signal" ? "hover:text-accent-violet" : "hover:text-text-secondary"} transition-colors`}
      aria-expanded={hasDetails ? open : undefined}
      title={hasDetails ? "Click to see what was weighed" : "Preflight trace"}
    >
      <span aria-hidden className={tier === "signal" ? "text-accent-violet" : "text-accent-violet/60"}>◆</span>
      <span className={tier === "signal" ? "text-text-primary" : "text-text-muted"}>
        {n} prior {n === 1 ? "stance" : "stances"} shaped this proposal.
      </span>
      {hasDetails && (
        <span aria-hidden className="opacity-60">{open ? "▾" : "▸"}</span>
      )}
    </button>
  );

  // Considered-concepts + extra-near-miss expansion. Identical for both
  // tiers; the styling stays neutral so it works inside or outside the
  // violet card.
  // BB6 — clicking a concept opens the YourTasteDrawer at the ledger tab
  // and highlights the matching row. Closes the breadcrumb→ledger loop:
  // the breadcrumb says "considered N stances", the ledger now answers
  // "here's the same stance and N more citations of it" without the user
  // having to find the drawer button + scroll for a name match.
  const openLedgerForConcept = (concept: string) => {
    window.dispatchEvent(
      new CustomEvent("dp:open-your-taste", {
        detail: { initialTab: "ledger", highlightConcept: concept },
      }),
    );
  };

  const Expansion = open && hasDetails ? (
    <div className="mt-2 pl-4 space-y-1.5">
      {trace.consideredConcepts.length > 0 && (
        <div>
          <div className="text-text-secondary mb-1">Considered:</div>
          <ul className="space-y-0.5">
            {trace.consideredConcepts.map((c, i) => {
              // GG9 — surface the cross-project citation count to the
              // human, not just the agent. Pre-GG9 EE3/FF4 added
              // globalCitationCount to the digest + recall surface,
              // but the breadcrumb's "Considered" rows showed concept
              // name + reason only. Now: when counts > 0, render
              // "cited Nx here · Mx across projects" so the user can
              // see the moat compounding visibly. Reads zero-fetch
              // from citationCounts (already in scope from EE2/EE3).
              const counts = citationCounts[c.concept];
              const projectN = typeof counts === "object" ? counts.project : counts;
              const globalN = typeof counts === "object" ? counts.global : counts;
              const showCount =
                typeof projectN === "number" &&
                typeof globalN === "number" &&
                (projectN > 0 || globalN > 0);
              return (
                <li key={`c${i}`} className="flex items-start gap-2 flex-wrap">
                  <span
                    className={`shrink-0 px-1 py-px rounded text-[9px] uppercase tracking-wide ${
                      c.source === "team"
                        ? "bg-accent-blue-dim/40 text-accent-blue"
                        : "bg-surface-elevated text-text-muted"
                    }`}
                    title={c.source === "team" ? "From .deeppairing/team.json" : "From this session"}
                  >
                    {c.source}
                  </span>
                  <button
                    type="button"
                    onClick={() => openLedgerForConcept(c.concept)}
                    className="font-mono text-text-secondary hover:text-accent-violet underline-offset-2 hover:underline text-left"
                    title="Open this stance in the ledger view"
                  >
                    {c.concept}
                  </button>
                  {showCount && (
                    <span
                      className="text-2xs text-text-muted"
                      title="Citation counts within this project and across all your projects"
                    >
                      cited {projectN}× here{globalN! > projectN! ? ` · ${globalN}× across projects` : ""}
                    </span>
                  )}
                  {c.reason && (
                    <span className="text-text-muted opacity-80">— {c.reason}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {trace.nearMisses.length > 1 && (
        <div>
          <div className="text-accent-amber mb-1">Other near-misses:</div>
          <ul className="space-y-0.5">
            {trace.nearMisses.slice(1).map((n, i) => (
              <li key={`n${i}`} className="font-mono text-accent-amber/80">
                <button
                  type="button"
                  onClick={() => openLedgerForConcept(n.concept)}
                  className="hover:text-accent-violet underline-offset-2 hover:underline text-left"
                  title="Open this stance in the ledger view"
                >
                  {n.concept}
                </button>
                {n.reason && (
                  <span className="text-text-muted font-sans"> — {n.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  ) : null;

  // Signal tier — violet card. The near-miss line stays OUTSIDE the
  // expand toggle (concrete pairing moment, shouldn't be hidden by
  // default). Team-source-without-near-miss skips the amber line.
  if (tier === "signal") {
    return (
      <div className="border border-accent-violet/15 bg-accent-violet-dim/10 rounded px-3 py-2 mb-2 text-2xs text-text-secondary">
        {Headline}
        {nearMiss && (
          <div className="mt-1 pl-4 text-accent-amber/90">
            ↳ Almost flagged this — your past stance on{" "}
            <button
              type="button"
              onClick={() => openLedgerForConcept(nearMiss.concept)}
              className="font-mono text-accent-amber hover:text-accent-violet underline-offset-2 hover:underline"
              title="Open this stance in the ledger view"
            >
              {nearMiss.concept}
            </button>{" "}
            is adjacent.
            {nearMiss.reason && (
              <span className="text-text-muted"> ({nearMiss.reason})</span>
            )}
          </div>
        )}
        {Expansion}
      </div>
    );
  }

  // Ambient tier — single muted line, no box. The drumbeat lives here
  // (every artifact still surfaces N stances) but reads as provenance
  // rather than chrome. AA8 is the answer to PMF council's "50 violet
  // bars saying 'trust me'" objection.
  return (
    <div className="px-3 py-1 mb-2">
      {Headline}
      {Expansion}
    </div>
  );
}
