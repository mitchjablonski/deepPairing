import { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { type Artifact, type DecisionContent, getTypedContent } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { usePreferencesStore } from "../stores/preferences";
import { useReplayStore } from "../stores/replay";
import { useIsNarrowViewport } from "../hooks/useMediaQuery";
import { ResearchArtifact } from "./artifacts/ResearchArtifact";
import { PlanArtifact } from "./artifacts/PlanArtifact";
import { DecisionCard } from "./DecisionCard";
import { CodeChangeArtifact } from "./artifacts/CodeChangeArtifact";
import { ReasoningCard } from "./artifacts/ReasoningCard";
import { SpecArtifact } from "./artifacts/SpecArtifact";
import { CommentThread } from "./CommentThread";
import { ArtifactIcon } from "./icons/ArtifactIcons";
import { CausalChain } from "./CausalChain";

const statusDots: Record<string, string> = {
  draft: "bg-text-muted",
  reviewing: "bg-accent-blue",
  approved: "bg-accent-green",
  revised: "bg-accent-amber",
  rejected: "bg-accent-red",
  superseded: "bg-text-muted opacity-40",
  retracted: "bg-text-muted opacity-60",
};

const statusColors: Record<string, string> = {
  draft: "bg-surface-elevated text-text-muted",
  reviewing: "bg-accent-blue-dim text-accent-blue",
  approved: "bg-accent-green-dim text-accent-green",
  revised: "bg-accent-amber-dim text-accent-amber",
  rejected: "bg-accent-red-dim text-accent-red",
  superseded: "bg-surface-elevated text-text-muted",
  retracted: "bg-surface-elevated text-text-muted",
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
};

const statusLabels: Record<string, string> = {
  draft: "Draft, awaiting review",
  reviewing: "Under review",
  approved: "Approved",
  revised: "Revision requested",
  rejected: "Rejected",
  superseded: "Superseded by newer version",
  retracted: "Retracted by agent",
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
  const { artifacts, selectArtifact } = useArtifactStore();
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
  const { renameArtifact } = useArtifactStore();

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
    <motion.div
      key={artifact.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
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
            {artifact.status}
          </span>
          {artifact.version > 1 && (
            <span className="text-2xs text-text-muted">v{artifact.version}</span>
          )}
        </div>
        {artifact.agentReasoning && (
          <p className="text-xs text-text-muted italic">{artifact.agentReasoning}</p>
        )}
      </div>

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
      {artifact.type === "decision" && (() => {
        const dc = getTypedContent<DecisionContent>(artifact);
        if (!dc.options) return null;

        // When viewing a past resolved decision via replay, pull the record so
        // DecisionCard can open in the resolved state with the Re-pair button.
        const replay = useReplayStore.getState();
        const effectiveDecisionId = dc.decisionId ?? artifact.id;
        const record = replay.decisions.find(
          (d) => d.decisionId === effectiveDecisionId || d.artifactId === artifact.id,
        );
        const initialResolved = record?.response
          ? {
              optionId: record.response.optionId,
              reasoning: record.response.reasoning,
              resolvedAt: record.resolvedAt,
            }
          : undefined;

        return (
          <DecisionCard
            event={{
              type: "decision_request",
              decisionId: effectiveDecisionId,
              context: dc.context,
              options: dc.options,
            }}
            decisionId={effectiveDecisionId}
            artifactId={artifact.id}
            sessionId={artifact.sessionId}
            initialResolved={initialResolved}
          />
        );
      })()}

      {/* General comments */}
      <div className="pt-3 border-t border-border-default">
        <h4 className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
          Comments
        </h4>
        <CommentThread artifactId={artifact.id} comments={generalComments} />
      </div>
    </motion.div>
  );
}

type SidebarGrouping = "type" | "timeline" | "flow";

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

/** Sidebar artifact list with grouping modes */
function ArtifactSidebar({
  typeGroups,
  artifacts,
  selectedArtifactId,
  unreadIds,
  collapsed,
  onToggle,
}: {
  typeGroups: Map<string, Artifact[]>;
  artifacts: Artifact[];
  selectedArtifactId: string | null;
  unreadIds: string[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { selectArtifact } = useArtifactStore();
  const [grouping, setGrouping] = useState<SidebarGrouping>("type");

  // Build groups based on selected mode
  const groups = useMemo((): Map<string, Artifact[]> => {
    if (grouping === "type") return typeGroups;
    if (grouping === "timeline") {
      const sorted = [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return new Map([["All Artifacts", sorted]]);
    }
    return buildFlowGroups(artifacts);
  }, [grouping, typeGroups, artifacts]);

  return (
    <div
      className={`shrink-0 border-r border-border-default bg-surface-secondary overflow-y-auto transition-all duration-[180ms] ease-out ${
        collapsed ? "w-12" : "w-[220px]"
      }`}
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

      {/* Grouped artifact list */}
      {Array.from(groups.entries()).map(([label, items]) => (
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

const API_BASE = `http://${window.location.host}`;

interface ActiveSession { sessionId: string; port: number; pid: number; startedAt: string }

/**
 * Multi-agent bar: loads artifacts from other active sessions and merges
 * them into the local store so everything appears in one UI.
 */
function MultiAgentSync() {
  const { addArtifact, addComment, artifacts } = useArtifactStore();
  const knownSessionIds = useMemo(() => new Set(artifacts.map((a) => a.sessionId)), [artifacts]);

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/active-sessions`);
        const data = await res.json();
        const sessions: ActiveSession[] = data.sessions ?? [];

        for (const session of sessions) {
          if (knownSessionIds.has(session.sessionId)) continue; // Already loaded

          // Load this session's artifacts from disk via the API
          try {
            const sRes = await fetch(`${API_BASE}/api/live-session/${session.sessionId}`);
            if (!sRes.ok) continue;
            const state = await sRes.json();
            if (cancelled) return;

            for (const artifact of state.artifacts ?? []) {
              addArtifact(artifact);
            }
            for (const comment of state.comments ?? []) {
              addComment(comment);
            }
          } catch {}
        }
      } catch {}
    };

    sync();
    const timer = setInterval(sync, 5000); // Poll for new sessions every 5s
    return () => { cancelled = true; clearInterval(timer); };
  }, [knownSessionIds.size]); // Re-run when we load new sessions

  return null; // No visual output — just syncs data
}

export function ArtifactPanel() {
  const { artifacts, selectedArtifactId, selectArtifact, unreadIds } = useArtifactStore();
  const { sidebarCollapsed, toggleSidebar } = usePreferencesStore();
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
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3 p-8">
        <div className="w-12 h-12 rounded-full bg-surface-elevated flex items-center justify-center">
          <ArtifactIcon type="research" className="w-6 h-6 opacity-40" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-text-secondary">Waiting for agent</p>
          <p className="text-xs mt-1">Artifacts will appear here as the agent researches, decides, and builds</p>
        </div>
        {/* Skeleton loading hint */}
        <div className="w-full max-w-xs space-y-2 mt-4">
          <div className="h-3 rounded animate-shimmer" />
          <div className="h-3 rounded animate-shimmer w-3/4" />
          <div className="h-3 rounded animate-shimmer w-1/2" />
        </div>
      </div>
    );
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
        onToggle={toggleSidebar}
      />

      {/* Detail pane */}
      <div className="flex-1 flex flex-col min-w-0">
        <AnimatePresence mode="popLayout">
          {selectedArtifact ? (
            <ArtifactDetail key={selectedArtifact.id} artifact={selectedArtifact} />
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
