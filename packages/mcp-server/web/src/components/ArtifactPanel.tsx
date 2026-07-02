import { useMemo, useState, useEffect, useRef, lazy, Suspense } from "react";
// B5 — `m` + LazyMotion (App loads domAnimation) instead of the full
// `motion` component: drops ~40kB gzip of animation features nothing uses
// from the ENTRY bundle. Same animations.
import { m, AnimatePresence } from "motion/react";
import { apiGet, apiBase } from "../lib/api";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { usePreferencesStore, SIDEBAR_WIDTHS } from "../stores/preferences";
import { useReplayStore } from "../stores/replay";
import { useConnectionStore } from "../stores/connection";
import { useIsNarrowViewport } from "../hooks/useMediaQuery";
// D6 (P2) — the artifact renderers are LAZY: statically importing all seven
// kept them (and, via their coerce*Content imports, the whole Zod runtime)
// in the entry chunk. Each renderer now code-splits with its coercers; the
// entry drops ~30-40kB gz and Zod leaves it entirely (the C6a regression).
const ResearchArtifact = lazy(() => import("./artifacts/ResearchArtifact").then((m) => ({ default: m.ResearchArtifact })));
const PlanArtifact = lazy(() => import("./artifacts/PlanArtifact").then((m) => ({ default: m.PlanArtifact })));
const RevisionDiff = lazy(() => import("./RevisionDiff").then((m) => ({ default: m.RevisionDiff })));
const DecisionArtifactView = lazy(() => import("./DecisionCard").then((m) => ({ default: m.DecisionArtifactView })));
const CodeChangeArtifact = lazy(() => import("./artifacts/CodeChangeArtifact").then((m) => ({ default: m.CodeChangeArtifact })));
const ReasoningCard = lazy(() => import("./artifacts/ReasoningCard").then((m) => ({ default: m.ReasoningCard })));
const SpecArtifact = lazy(() => import("./artifacts/SpecArtifact").then((m) => ({ default: m.SpecArtifact })));
import { CommentThread } from "./CommentThread";
import { ArtifactIcon } from "./icons/ArtifactIcons";
import { FirstRunWalkthrough } from "./WalkthroughCards";
import { CausalChain } from "./CausalChain";
import { ErrorBoundary } from "./ErrorBoundary";
import { PreflightBreadcrumb } from "./PreflightBreadcrumb";

const statusDots: Record<string, string> = {
  // B1 — draft is the one status that NEEDS the human, yet it was styled as the
  // quietest dot in the sidebar (dimmer than approved/rejected). Amber matches
  // the "Your turn" pill so a glance shows where your turn lives; `revised`
  // shares amber deliberately — both mean "awaiting your review".
  draft: "bg-accent-amber",
  reviewing: "bg-accent-blue",
  approved: "bg-accent-green",
  revised: "bg-accent-amber",
  rejected: "bg-accent-red",
  superseded: "bg-text-muted opacity-40",
  retracted: "bg-text-muted opacity-60",
  obsolete: "bg-text-muted opacity-40",
};

const statusColors: Record<string, string> = {
  // B1 — amber to match the sidebar dot + the Your-turn pill (draft = needs
  // you; it was the quietest badge while being the loudest call to action).
  draft: "bg-accent-amber-dim text-accent-amber",
  reviewing: "bg-accent-blue-dim text-accent-blue",
  approved: "bg-accent-green-dim text-accent-green",
  revised: "bg-accent-amber-dim text-accent-amber",
  rejected: "bg-accent-red-dim text-accent-red",
  superseded: "bg-surface-elevated text-text-muted",
  retracted: "bg-surface-elevated text-text-muted",
  obsolete: "bg-surface-elevated text-text-muted",
};

/**
 * Non-color status glyph. Paired with `statusDots` colors, this gives every
 * artifact TWO differentiators — shape + color — so status is legible
 * colorblind-friendly and without ambient highlighting.
 */
const statusGlyph: Record<string, string> = {
  draft: "●",      // solid dot — unreviewed
  reviewing: "⧗",  // hourglass — in-flight
  approved: "✓",   // check — done
  revised: "↻",    // cycle — back to the agent
  rejected: "✗",   // cross — dead
  superseded: "⇈", // double up — replaced by newer version
  retracted: "↩",  // return arrow — agent backed out
  obsolete: "⊘",   // circled slash — overcome by new information
};

const statusLabels: Record<string, string> = {
  draft: "Draft, awaiting review",
  reviewing: "Under review",
  approved: "Approved",
  revised: "Revision requested",
  rejected: "Rejected",
  superseded: "Superseded by newer version",
  retracted: "Retracted by agent",
  obsolete: "Overcome by new information",
};

const typeLabels: Record<string, string> = {
  research: "Research",
  spec: "Specs",
  plan: "Plans",
  decision: "Decisions",
  code_change: "Code",
  reasoning: "Reasoning",
};

function RelatedArtifacts({ ids }: { ids: string[] }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const related = ids.map((id) => artifacts.find((a) => a.id === id)).filter(Boolean) as Artifact[];

  if (related.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-2xs text-text-muted">Related:</span>
      {related.map((a) => (
        <button
          key={a.id}
          onClick={() => selectArtifact(a.id)}
          className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface-elevated border border-border-subtle
                     rounded text-2xs text-text-secondary hover:border-accent-blue hover:text-accent-blue transition-colors"
        >
          <ArtifactIcon type={a.type} className="w-3 h-3" />
          {a.title}
        </button>
      ))}
    </div>
  );
}

function EditableTitle({ artifact }: { artifact: Artifact }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.title);
  const renameArtifact = useArtifactStore((s) => s.renameArtifact);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== artifact.title) {
      renameArtifact(artifact.id, trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
          if (e.key === "Escape") { setDraft(artifact.title); setEditing(false); }
        }}
        autoFocus
        className="text-sm font-semibold text-text-primary leading-[1.2] bg-surface-secondary border border-accent-blue rounded px-1.5 py-0.5
                   focus:outline-none focus:ring-1 focus:ring-accent-blue min-w-[200px]"
      />
    );
  }

  return (
    <h3
      className="text-sm font-semibold text-text-primary leading-[1.2] cursor-pointer hover:text-accent-blue transition-colors"
      onClick={() => { setDraft(artifact.title); setEditing(true); }}
      title="Click to rename"
    >
      {artifact.title}
    </h3>
  );
}

function ArtifactDetail({ artifact }: { artifact: Artifact }) {
  const contentWidth = usePreferencesStore((s) => s.contentWidth);
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];
  const generalComments = comments.filter(
    (c) =>
      c.target.lineNumber == null &&
      c.target.findingIndex == null &&
      c.target.stepIndex == null &&
      c.target.lineStart == null,
  );

  return (
    <m.div
      key={artifact.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
      // X10 — scoping attribute used by scrollToAnchor() to disambiguate
      // anchors when two artifacts are on the page during transitions.
      data-artifact-id={artifact.id}
      className={`flex-1 overflow-y-auto p-4 space-y-4 scroll-shadow w-full ${
        contentWidth === "constrained" ? "max-w-4xl mx-auto" : ""
      }`}
    >
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ArtifactIcon type={artifact.type} className="text-text-secondary" />
          <EditableTitle artifact={artifact} />
          <span className={`px-1.5 py-0.5 text-2xs font-medium rounded ${statusColors[artifact.status]}`}>
            {/* U6 — friendly label + glyph, matching the sidebar; not the raw
                enum ("superseded"/"reviewing"). */}
            {statusGlyph[artifact.status] ? `${statusGlyph[artifact.status]} ` : ""}
            {statusLabels[artifact.status] ?? artifact.status}
          </span>
          {artifact.version > 1 && (
            <span className="text-2xs text-text-muted">v{artifact.version}</span>
          )}
        </div>
        {artifact.agentReasoning && (
          <p className="text-xs text-text-muted italic">{artifact.agentReasoning}</p>
        )}
      </div>

      {/* D6 — lazy chunk boundary. MUST wrap every lazy component below
          (RevisionDiff included — review lesson: a suspension outside the
          boundary suspends the whole tree with no fallback). */}
      <Suspense fallback={<div className="h-24 rounded bg-surface-elevated animate-pulse" aria-label="Loading artifact view" role="status" />}>
      {/* Revision diff — when this artifact supersedes a prior version, show
          what changed (anchored to the agent's revise reason) so the human
          sees their feedback land instead of eyeballing v2 against memory. */}
      <RevisionDiff artifact={artifact} />

      {/* Z3 — preflight breadcrumb hoisted ABOVE the type-specific renderer
          so the moat frames the proposal instead of footnoting it. PMF
          council Y review: the single line that distinguishes deepPairing
          from Cursor 3 was the LAST thing the user saw, after they'd
          already decided. Now it's the first thing under the header. */}
      <PreflightBreadcrumb artifactId={artifact.id} />

      {/* Causal chain — shows artifact relationships */}
      <CausalChain />

      {/* Related artifacts */}
      {artifact.relatedArtifactIds && artifact.relatedArtifactIds.length > 0 && (
        <RelatedArtifacts ids={artifact.relatedArtifactIds} />
      )}

      {/* Type-specific renderer */}
      {artifact.type === "research" && <ResearchArtifact artifact={artifact} />}
      {artifact.type === "spec" && <SpecArtifact artifact={artifact} />}
      {artifact.type === "plan" && <PlanArtifact artifact={artifact} />}
      {artifact.type === "reasoning" && <ReasoningCard artifact={artifact} />}
      {artifact.type === "code_change" && (
        <CodeChangeArtifact artifact={artifact} />
      )}
      {artifact.type === "decision" && <DecisionArtifactView artifact={artifact} />}
      </Suspense>

      {/* General comments */}
      <div className="pt-3 border-t border-border-default">
        <h4 className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
          Comments
        </h4>
        <CommentThread artifactId={artifact.id} comments={generalComments} />
      </div>
    </m.div>
  );
}

type SidebarGrouping = "type" | "timeline" | "flow";

// Persist the picked grouping across reloads (Flow is the fresh-tab default).
const GROUPING_KEY = "dp-sidebar-grouping";
function readGrouping(): SidebarGrouping {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return "flow";
  try {
    const v = localStorage.getItem(GROUPING_KEY);
    return v === "type" || v === "timeline" || v === "flow" ? v : "flow";
  } catch { return "flow"; }
}
function writeGrouping(g: SidebarGrouping): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try { localStorage.setItem(GROUPING_KEY, g); } catch { /* best-effort */ }
}

/** Build causal-chain groups from relatedArtifactIds */
function buildFlowGroups(artifacts: Artifact[]): Map<string, Artifact[]> {
  const groups = new Map<string, Artifact[]>();
  const assigned = new Set<string>();

  // Find root artifacts (not referenced by anyone else's relatedArtifactIds)
  const referenced = new Set<string>();
  for (const a of artifacts) {
    for (const rid of a.relatedArtifactIds ?? []) referenced.add(rid);
  }

  // Build chains starting from roots
  for (const a of artifacts) {
    if (assigned.has(a.id)) continue;
    if (referenced.has(a.id)) continue; // Not a root — will be picked up by its parent

    const chain: Artifact[] = [a];
    assigned.add(a.id);

    // Follow forward references
    const queue = [...(a.relatedArtifactIds ?? [])];
    // Also find artifacts that reference this one
    for (const other of artifacts) {
      if (other.relatedArtifactIds?.includes(a.id) && !assigned.has(other.id)) {
        queue.push(other.id);
      }
    }

    for (const rid of queue) {
      const related = artifacts.find((x) => x.id === rid);
      if (related && !assigned.has(related.id)) {
        chain.push(related);
        assigned.add(related.id);
        // Continue following references
        for (const nextId of related.relatedArtifactIds ?? []) {
          if (!assigned.has(nextId)) queue.push(nextId);
        }
      }
    }

    const label = a.title.length > 30 ? a.title.slice(0, 28) + "..." : a.title;
    groups.set(label, chain);
  }

  // Add any orphans
  const orphans = artifacts.filter((a) => !assigned.has(a.id));
  if (orphans.length > 0) {
    groups.set("Other", orphans);
  }

  return groups;
}

/** How many most-recent artifacts the sidebar shows before collapsing the
 *  rest behind a "Show N older" toggle (keeps a deep session scannable). */
const SIDEBAR_RECENT_LIMIT = 10;

/** Sidebar artifact list with grouping modes */
function ArtifactSidebar({
  typeGroups,
  artifacts,
  selectedArtifactId,
  unreadIds,
  collapsed,
  width,
  onToggle,
}: {
  typeGroups: Map<string, Artifact[]>;
  artifacts: Artifact[];
  selectedArtifactId: string | null;
  unreadIds: string[];
  collapsed: boolean;
  width: number;
  onToggle: () => void;
}) {
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  // Flow (causal chain) is the fresh-tab default — once a project is deep,
  // grouping by type scatters a finding → plan → change thread across buckets.
  // The user's pick persists across reloads.
  const [grouping, setGroupingState] = useState<SidebarGrouping>(() => readGrouping());
  const setGrouping = (g: SidebarGrouping) => { writeGrouping(g); setGroupingState(g); };

  // Build groups based on selected mode
  const groups = useMemo((): Map<string, Artifact[]> => {
    if (grouping === "type") return typeGroups;
    if (grouping === "timeline") {
      const sorted = [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return new Map([["All Artifacts", sorted]]);
    }
    return buildFlowGroups(artifacts);
  }, [grouping, typeGroups, artifacts]);

  // Keep the sidebar from becoming a wall of scroll on a deep session: show
  // only the most-recent N artifacts by default, collapse the rest behind a
  // "Show N older" toggle. The currently-selected artifact is always kept
  // visible even if it's old, so the list never hides where you are.
  const [showAllOlder, setShowAllOlder] = useState(false);
  const recentIds = useMemo(() => {
    const ids = new Set(
      [...artifacts]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, SIDEBAR_RECENT_LIMIT)
        .map((a) => a.id),
    );
    if (selectedArtifactId) ids.add(selectedArtifactId);
    return ids;
  }, [artifacts, selectedArtifactId]);
  const olderCount = artifacts.filter((a) => !recentIds.has(a.id)).length;
  const visibleGroups = useMemo(() => {
    if (showAllOlder || olderCount === 0) return groups;
    const filtered = new Map<string, Artifact[]>();
    for (const [label, items] of groups) {
      const kept = items.filter((a) => recentIds.has(a.id));
      if (kept.length) filtered.set(label, kept);
    }
    return filtered;
  }, [groups, showAllOlder, olderCount, recentIds]);

  return (
    <div
      className={`shrink-0 border-r border-border-default bg-surface-secondary overflow-y-auto transition-all duration-[180ms] ease-out ${
        collapsed ? "w-12" : ""
      }`}
      style={collapsed ? undefined : { width }}
    >
      {/* Collapse toggle + grouping selector */}
      <div className="flex items-center justify-between">
        <button
          onClick={onToggle}
          className="flex items-center justify-center py-1.5 px-2 text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            {collapsed ? (
              <path d="M4 2l4 4-4 4" />
            ) : (
              <path d="M8 2L4 6l4 4" />
            )}
          </svg>
        </button>

        {/* Grouping mode selector */}
        {!collapsed && (
          <div className="flex items-center gap-0.5 pr-2">
            {(["type", "flow", "timeline"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setGrouping(mode)}
                className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
                  grouping === mode
                    ? "bg-surface-hover text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
                title={mode === "type" ? "Group by type" : mode === "flow" ? "Group by causal chain" : "Chronological timeline"}
              >
                {mode === "type" ? "Type" : mode === "flow" ? "Flow" : "Time"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* "Show older" sits at the TOP so the recent items below it stay the
          focus — you scan down to the latest, not past a wall of old ones. */}
      {!collapsed && olderCount > 0 && (
        <button
          onClick={() => setShowAllOlder((v) => !v)}
          className="w-full text-left px-3 py-1.5 text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors select-none border-b border-border-subtle"
        >
          {showAllOlder ? "▴ Show fewer" : `▾ Show ${olderCount} older`}
        </button>
      )}

      {/* Grouped artifact list */}
      {Array.from(visibleGroups.entries()).map(([label, items]) => (
        <div key={label}>
          {/* Section header */}
          {!collapsed && (
            <div className="flex items-center gap-1.5 px-3 py-1 text-2xs font-semibold text-text-muted uppercase tracking-wide">
              {grouping === "type" && <ArtifactIcon type={label} className="w-3 h-3" />}
              {grouping === "type" ? (typeLabels[label] ?? label) : label}
              <span className="opacity-50">{items.length}</span>
            </div>
          )}

          {/* Items */}
          {items.map((a) => {
            const isSelected = a.id === selectedArtifactId;
            const isUnread = unreadIds.includes(a.id);

            return (
              <button
                key={a.id}
                onClick={() => selectArtifact(a.id)}
                className={`w-full flex items-center gap-2 transition-all duration-[180ms] ease-out ${
                  collapsed ? "justify-center px-1 py-1.5" : "px-3 py-1.5 text-left"
                } ${
                  isSelected
                    ? "bg-surface-hover border-l-2 border-l-accent-blue"
                    : "border-l-2 border-l-transparent hover:bg-surface-hover/50"
                }`}
                title={a.title}
              >
                {collapsed ? (
                  <div className="relative" title={`${typeLabels[a.type] ?? a.type} — ${statusLabels[a.status] ?? a.status}`}>
                    <ArtifactIcon type={a.type} className={`w-4 h-4 ${isSelected ? "text-accent-blue" : "text-text-muted"}`} />
                    {isUnread && (
                      <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent-blue" />
                    )}
                    <span
                      aria-label={statusLabels[a.status]}
                      className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full flex items-center justify-center text-[8px] leading-none ${statusDots[a.status]} text-white`}
                    >
                      {statusGlyph[a.status] ?? "•"}
                    </span>
                  </div>
                ) : (
                  <>
                    <ArtifactIcon
                      type={a.type}
                      className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-accent-blue" : "text-text-muted"}`}
                    />
                    <span className={`text-2xs truncate flex-1 ${
                      isSelected ? "text-text-primary font-medium" : "text-text-secondary"
                    } ${a.status === "retracted" ? "line-through opacity-60" : ""}`}>
                      {a.title}
                    </span>
                    <span
                      aria-label={statusLabels[a.status]}
                      title={statusLabels[a.status]}
                      className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] leading-none ${statusDots[a.status]} text-white`}
                    >
                      {statusGlyph[a.status] ?? "•"}
                    </span>
                    {isUnread && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent-blue shrink-0" />
                    )}
                  </>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}



/**
 * Multi-agent bar: loads artifacts from other active sessions and merges
 * them into the local store so everything appears in one UI.
 */
function MultiAgentSync() {
  const addArtifact = useArtifactStore((s) => s.addArtifact);
  const addComment = useArtifactStore((s) => s.addComment);
  const artifacts = useArtifactStore((s) => s.artifacts);
  // C1 — reuse the session list App already polls into the connection store
  // (every 10s) instead of running a SECOND 5s /api/active-sessions poll here.
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  // C1 review — refreshSessions sets a NEW array identity every 10s poll even
  // when unchanged; depending on the array tore down + recreated the 5s
  // interval each time. Key the effect on the id list's VALUE instead.
  const sessionKey = activeSessions.map((s) => s.sessionId).join(",");
  const knownSessionIds = useMemo(() => new Set(artifacts.map((a) => a.sessionId)), [artifacts]);
  // C1 — a session with ZERO artifacts is never "known" (knownSessionIds
  // derives from artifact sessionIds), so pre-C1 it was refetched every 5s
  // forever — each hit running getFullState() server-side. The refetch is
  // still needed (it's how another session's FIRST artifact gets discovered:
  // session-scoped tabs don't receive other sessions' WS events), so back it
  // off to 30s per empty session instead of dropping it.
  const lastAttemptRef = useRef<Map<string, number>>(new Map());
  const EMPTY_SESSION_RETRY_MS = 30_000;

  useEffect(() => {
    // E7 — one controller per effect generation; every tick's fetch carries
    // the signal, cleanup aborts whichever is mid-flight.
    const ac = new AbortController();

    const sync = async () => {
      // PP3 — skip the fetch + parse + cross-session merge when the tab is
      // hidden (the timer keeps ticking but does no work / triggers no renders).
      if (typeof document !== "undefined" && document.hidden) return;
      for (const session of activeSessions) {
        if (knownSessionIds.has(session.sessionId)) continue; // Already loaded
        const last = lastAttemptRef.current.get(session.sessionId) ?? 0;
        if (Date.now() - last < EMPTY_SESSION_RETRY_MS) continue;
        lastAttemptRef.current.set(session.sessionId, Date.now());

        // Load this session's artifacts from disk via the API
        try {
          const sRes = await apiGet(`${apiBase()}/api/live-session/${session.sessionId}`, { signal: ac.signal });
          if (!sRes.ok) continue;
          const state = await sRes.json();
          if (ac.signal.aborted) return;

          for (const artifact of state.artifacts ?? []) {
            addArtifact(artifact);
          }
          for (const comment of state.comments ?? []) {
            addComment(comment);
          }
        } catch {}
      }
    };

    sync();
    // 5s cadence stays for reacting to NEWLY appearing sessions quickly, but
    // it's now fetch-free unless there's an unknown session past its backoff.
    const timer = setInterval(sync, 5000);
    return () => { ac.abort(); clearInterval(timer); };
    // sessionKey (not the array) so a same-content refresh doesn't churn the
    // interval; activeSessions is read via a ref-stable closure re-created
    // only when membership actually changes.
  }, [sessionKey, knownSessionIds.size]); // Re-run on new sessions / merges

  return null; // No visual output — just syncs data
}

export function ArtifactPanel() {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectedArtifactId = useArtifactStore((s) => s.selectedArtifactId);
  const unreadIds = useArtifactStore((s) => s.unreadIds);
  const sidebarCollapsed = usePreferencesStore((s) => s.sidebarCollapsed);
  const toggleSidebar = usePreferencesStore((s) => s.toggleSidebar);
  const sidebarWidth = usePreferencesStore((s) => s.sidebarWidth);
  const isNarrow = useIsNarrowViewport();
  const effectiveCollapsed = sidebarCollapsed || isNarrow;
  const [sessionFilter, setSessionFilter] = useState<string | "all">("all");

  // Replay mode: hide artifacts created after the cursor. createdAt is ISO
  // so string comparison matches chronological order.
  const replayActive = useReplayStore((s) => s.active);
  const replayCursor = useReplayStore((s) => s.cursor);

  // Unique session IDs present in the store
  const sessionIds = useMemo(
    () => [...new Set(artifacts.map((a) => a.sessionId))],
    [artifacts],
  );

  const visibleArtifacts = useMemo(
    () => artifacts.filter((a) => {
      if (a.status !== "superseded" &&
          (sessionFilter === "all" || a.sessionId === sessionFilter)) {
        // When replaying, drop artifacts that haven't been "created" yet at
        // the cursor so the side bar reflects the state as of that moment.
        if (replayActive && replayCursor && a.createdAt > replayCursor) return false;
        return true;
      }
      return false;
    }),
    [artifacts, sessionFilter, replayActive, replayCursor],
  );

  // Group by type
  const typeGroups = useMemo(() => {
    const groups = new Map<string, Artifact[]>();
    for (const a of visibleArtifacts) {
      const list = groups.get(a.type) ?? [];
      list.push(a);
      groups.set(a.type, list);
    }
    return groups;
  }, [visibleArtifacts]);

  const selectedArtifact = artifacts.find((a) => a.id === selectedArtifactId);

  if (visibleArtifacts.length === 0) {
    return <FirstRunWalkthrough />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Sync artifacts from other active sessions */}
      <MultiAgentSync />

      {/* Session filter — shown when artifacts from multiple agents exist */}
      {sessionIds.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-default bg-surface-secondary overflow-x-auto shrink-0">
          <span className="text-2xs text-text-muted shrink-0">Agents:</span>
          <button
            onClick={() => setSessionFilter("all")}
            className={`px-2 py-0.5 rounded text-2xs shrink-0 transition-colors ${
              sessionFilter === "all"
                ? "bg-accent-blue-dim text-accent-blue font-medium"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            All ({artifacts.filter((a) => a.status !== "superseded").length})
          </button>
          {sessionIds.map((sid, i) => {
            const count = artifacts.filter((a) => a.sessionId === sid && a.status !== "superseded").length;
            return (
              <button
                key={sid}
                onClick={() => setSessionFilter(sid)}
                className={`px-2 py-0.5 rounded text-2xs shrink-0 transition-colors ${
                  sessionFilter === sid
                    ? "bg-accent-blue-dim text-accent-blue font-medium"
                    : "text-text-muted hover:text-text-secondary"
                }`}
                title={sid}
              >
                Agent {i + 1} ({count})
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
      {/* Left sidebar */}
      <ArtifactSidebar
        typeGroups={typeGroups}
        artifacts={visibleArtifacts}
        selectedArtifactId={selectedArtifactId}
        unreadIds={unreadIds}
        collapsed={effectiveCollapsed}
        width={SIDEBAR_WIDTHS[sidebarWidth]}
        onToggle={toggleSidebar}
      />

      {/* Detail pane */}
      <div className="flex-1 flex flex-col min-w-0">
        <AnimatePresence mode="popLayout">
          {selectedArtifact ? (
            // Per-artifact boundary: a renderer crash on malformed content is
            // isolated to THIS pane — the sidebar (outside this subtree) stays
            // usable so the user can pick another artifact. Keying by id remounts
            // a fresh boundary on selection change, so switching away from a
            // broken artifact auto-recovers (no manual "Try again" loop on the
            // same crashing content).
            <ErrorBoundary
              key={selectedArtifact.id}
              fallback={
                <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
                  <p className="text-sm text-accent-red font-medium">This artifact failed to render</p>
                  <p className="text-xs text-text-muted max-w-xs">
                    Its content may be malformed. Pick another artifact from the sidebar — the rest of the session is unaffected.
                  </p>
                </div>
              }
            >
              <ArtifactDetail artifact={selectedArtifact} />
            </ErrorBoundary>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-text-muted">
              Select an artifact to view details
            </div>
          )}
        </AnimatePresence>
      </div>
      </div>
    </div>
  );
}
