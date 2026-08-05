import { useEffect, useState } from "react";
import { apiGet, apiBase, safeFetch, sessionHeaders } from "../lib/api";
import { enterSessionReplay } from "../lib/session-replay";
import { useModal } from "../hooks/useModal";
import { timeAgo } from "../lib/time";
import { ArtifactIcon } from "./icons/ArtifactIcons";

/**
 * #203 (H2) — the Features view, slice 1. A DERIVED read-model: a FEATURE is a
 * bag of artifacts ORTHOGONAL to the session boundary (the dominant real shape
 * is one long rolling session holding many features, hand-labelled with
 * "Milestone N" / "Phase N" title prefixes). This groups every artifact across
 * every session by that prefix + parentId chains — zero schema change, zero
 * agent obligation, nothing persisted. Read-only.
 *
 * Per group: a TIMELINE of the group's artifacts (click → open in its session
 * via the shared enterSessionReplay routing — identical to the decisions view),
 * an OPEN ITEMS block (unresolved decisions, un-actioned debrief needsYourEyes,
 * unanswered questions — each click-throughs to its artifact), and a collapsible
 * FILE-TOUCH set (with cross-group "also touched by" breadcrumbs). The Ungrouped
 * bucket is always last and collapsed by default (it is most of history).
 */
interface FeatureArtifactRef {
  sessionId: string;
  artifactId: string;
  type: string;
  title: string;
  status: string;
  createdAt: string;
}
interface FeatureOpenItem {
  kind: "decision" | "needs_eyes" | "question";
  label: string;
  sessionId: string;
  artifactId: string;
  detail?: string;
  commentId?: string;
}
interface FeatureFileTouch {
  path: string;
  alsoIn: string[];
}
interface FeatureGroup {
  id: string;
  title: string;
  ungrouped?: boolean;
  artifactCount: number;
  openItemCount: number;
  lastActivity?: string;
  artifactRefs: FeatureArtifactRef[];
  openItems: FeatureOpenItem[];
  fileTouches: FeatureFileTouch[];
}
interface FeatureGroupsResult {
  groups: FeatureGroup[];
  failedSessions: Array<{ sessionId: string; reason: string }>;
}

const OPEN_ITEM_LABEL: Record<FeatureOpenItem["kind"], string> = {
  decision: "Decision",
  needs_eyes: "Needs your eyes",
  question: "Question",
};

export function FeaturesModal({ onClose }: { onClose: () => void }) {
  const { dialogProps } = useModal({ onClose });
  const [data, setData] = useState<FeatureGroupsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // Which groups are expanded. Seeded once data loads: every named feature
  // open, the Ungrouped bucket collapsed.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Which groups have their (compact) file-touch list revealed.
  const [filesOpen, setFilesOpen] = useState<Record<string, boolean>>({});
  // #206 (I1) — the group currently being RENAMED + its in-flight draft title.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // A correction (rename / move) is being persisted — disables the affordances
  // so a double-submit can't race.
  const [savingOverride, setSavingOverride] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet(`${apiBase()}/api/features`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return (await res.json()) as FeatureGroupsResult;
      })
      .then((d) => {
        if (cancelled) return;
        const groups = d.groups ?? [];
        setData({ groups, failedSessions: d.failedSessions ?? [] });
        const seed: Record<string, boolean> = {};
        for (const g of groups) seed[g.id] = !g.ungrouped;
        setExpanded(seed);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? "Could not load features");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const groups = data?.groups ?? [];
  const failedSessions = data?.failedSessions ?? [];
  const isEmpty = !loading && !error && groups.length === 0 && failedSessions.length === 0;

  const openArtifact = async (sessionId: string, artifactId: string) => {
    const key = `${sessionId}:${artifactId}`;
    setOpening(key);
    try {
      const ok = await enterSessionReplay(sessionId, artifactId);
      if (ok) onClose();
    } finally {
      setOpening(null);
    }
  };

  // #206 (I1) — POST a correction (rename / move) to the project-level overrides
  // and adopt the freshly re-grouped result the route returns (one round-trip:
  // authoritative, not optimistic-then-refetch). Preserves the current expand
  // state so a correction doesn't collapse groups the human opened; a brand-new
  // group (a move to a not-yet-rendered key) defaults to expanded.
  const postOverride = async (body: Record<string, unknown>): Promise<void> => {
    setSavingOverride(true);
    setOverrideError(null);
    try {
      const res = await safeFetch(`${apiBase()}/api/features/overrides`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify(body),
      });
      const next = (await res.json()) as FeatureGroupsResult;
      const nextGroups = next.groups ?? [];
      setData({ groups: nextGroups, failedSessions: next.failedSessions ?? [] });
      setExpanded((prev) => {
        const merged = { ...prev };
        for (const g of nextGroups) if (!(g.id in merged)) merged[g.id] = !g.ungrouped;
        return merged;
      });
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : "Could not save your correction.");
    } finally {
      setSavingOverride(false);
    }
  };

  const startRename = (g: FeatureGroup) => {
    setOverrideError(null);
    setRenaming(g.id);
    setRenameValue(g.title);
  };
  const commitRename = async (g: FeatureGroup) => {
    const title = renameValue.trim();
    setRenaming(null);
    // No-op when unchanged (avoids a pointless write + re-render churn).
    if (title === g.title.trim()) return;
    await postOverride({ action: "rename", groupKey: g.id, title });
  };
  const moveArtifact = async (artifactId: string, groupKey: string) => {
    await postOverride({ action: "assign", artifactId, groupKey });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-16"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label="Features"
        data-testid="features-view"
        className="w-full max-w-2xl max-h-[75vh] overflow-y-auto bg-surface-elevated border border-border-default rounded-lg p-4 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-bold text-text-primary">Features</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xs">
            Esc
          </button>
        </div>
        <p className="text-2xs text-text-muted mb-3">
          Your work across all sessions, grouped into features — each with its timeline, what's still
          open, and the files it touched.
        </p>

        {failedSessions.length > 0 && (
          <div
            role="status"
            className="mb-3 px-3 py-2 rounded-lg bg-accent-amber-dim border border-accent-amber/30 text-2xs text-accent-amber"
          >
            <span className="font-semibold">Some sessions couldn't be read.</span>{" "}
            {failedSessions.length} session{failedSessions.length === 1 ? "" : "s"} had an unreadable
            artifacts.json ({failedSessions.map((f) => f.sessionId).join(", ")}) — the grouping below is
            partial.
          </div>
        )}

        {overrideError && (
          <div
            role="alert"
            className="mb-3 px-3 py-2 rounded-lg bg-accent-red/10 border border-accent-red/30 text-2xs text-accent-red"
          >
            {overrideError}
          </div>
        )}

        {loading && (
          <div className="py-8 text-center text-text-muted text-sm" role="status">
            Loading features…
          </div>
        )}
        {error && !loading && (
          <div className="py-8 text-center text-accent-red text-sm" role="status">
            Couldn't load features: {error}
          </div>
        )}
        {isEmpty && (
          <div className="py-10 text-center text-text-muted text-sm">
            No features yet. As you pair, your artifacts group here by their "Milestone N" / "Phase N"
            title prefixes.
          </div>
        )}

        {!loading && !error && groups.length > 0 && (
          <>
            <ul className="space-y-2">
              {groups.map((g) => {
                const isOpen = expanded[g.id] ?? !g.ungrouped;
                return (
                  <li
                    key={g.id}
                    data-feature-group={g.id}
                    className="border border-white/[0.06] rounded-lg overflow-hidden bg-surface-elevated"
                  >
                    {renaming === g.id ? (
                      // #206 (I1) — inline RENAME row. Enter commits, Esc cancels.
                      <div className="px-3 py-2 flex items-center gap-2">
                        <input
                          autoFocus
                          data-feature-rename-input
                          aria-label={`Rename ${g.title}`}
                          value={renameValue}
                          disabled={savingOverride}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitRename(g); }
                            else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                          }}
                          className="flex-1 min-w-0 bg-surface-secondary border border-border-default rounded px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                        />
                        <button
                          onClick={() => void commitRename(g)}
                          disabled={savingOverride}
                          className="text-2xs text-accent-blue hover:underline disabled:opacity-50 shrink-0"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setRenaming(null)}
                          disabled={savingOverride}
                          className="text-2xs text-text-muted hover:text-text-primary disabled:opacity-50 shrink-0"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                    <div className="flex items-stretch">
                    <button
                      onClick={() => setExpanded((e) => ({ ...e, [g.id]: !isOpen }))}
                      aria-expanded={isOpen}
                      className="flex-1 min-w-0 text-left px-3 py-2 flex items-center gap-2 hover:bg-surface-hover transition-colors focus:outline-none focus:ring-1 focus:ring-accent-blue"
                    >
                      <span aria-hidden="true" className="text-text-muted text-2xs w-3 shrink-0">
                        {isOpen ? "▾" : "▸"}
                      </span>
                      <span className={`text-sm font-medium truncate ${g.ungrouped ? "text-text-muted" : "text-text-primary"}`}>
                        {g.title}
                      </span>
                      <span className="text-2xs text-text-muted shrink-0">
                        {g.artifactCount} item{g.artifactCount === 1 ? "" : "s"}
                      </span>
                      {g.openItemCount > 0 && (
                        <span
                          className="ml-auto shrink-0 min-w-[16px] h-[16px] px-1 inline-flex items-center justify-center rounded-full bg-accent-amber-dim text-accent-amber text-[9px] font-semibold leading-none"
                          aria-label={`${g.openItemCount} open item${g.openItemCount === 1 ? "" : "s"}`}
                        >
                          {g.openItemCount}
                        </span>
                      )}
                      {g.lastActivity && (
                        <span className={`text-2xs text-text-muted shrink-0 ${g.openItemCount > 0 ? "" : "ml-auto"}`}>
                          {timeAgo(g.lastActivity)}
                        </span>
                      )}
                    </button>
                    {/* Rename is a HUMAN correction to the derived title — offered on
                        named features only (the Ungrouped bucket isn't a feature). */}
                    {!g.ungrouped && (
                      <button
                        data-feature-rename
                        aria-label={`Rename ${g.title}`}
                        title="Rename this feature"
                        disabled={savingOverride}
                        onClick={() => startRename(g)}
                        className="px-2 text-text-muted hover:text-text-primary hover:bg-surface-hover disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-accent-blue shrink-0"
                      >
                        <span aria-hidden="true" className="text-xs">✎</span>
                      </button>
                    )}
                    </div>
                    )}

                    {isOpen && (
                      <div className="px-3 pb-3 pt-1 space-y-3">
                        {/* Timeline */}
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-1">
                            Timeline
                          </div>
                          <ul className="space-y-1">
                            {g.artifactRefs.map((r) => {
                              const key = `${r.sessionId}:${r.artifactId}`;
                              // #206 (I1) — move targets = every OTHER group (incl.
                              // Ungrouped). Only offered when a target exists.
                              const moveTargets = groups.filter((t) => t.id !== g.id);
                              return (
                                <li key={key} className="flex items-center gap-1">
                                  <button
                                    data-feature-artifact
                                    onClick={() => openArtifact(r.sessionId, r.artifactId)}
                                    disabled={opening === key}
                                    className="flex-1 min-w-0 text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-hover
                                               disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-accent-blue"
                                  >
                                    <span className="text-text-muted shrink-0">
                                      <ArtifactIcon type={r.type} className="w-3.5 h-3.5" />
                                    </span>
                                    <span className="text-xs text-text-primary truncate">{r.title}</span>
                                    <span className="ml-auto text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-surface-secondary text-text-muted shrink-0">
                                      {r.status}
                                    </span>
                                  </button>
                                  {moveTargets.length > 0 && (
                                    <select
                                      data-feature-move
                                      aria-label={`Move ${r.title} to another feature`}
                                      title="Move to feature…"
                                      disabled={savingOverride}
                                      value=""
                                      onChange={(e) => {
                                        const target = e.target.value;
                                        if (target) void moveArtifact(r.artifactId, target);
                                      }}
                                      className="shrink-0 text-2xs bg-surface-secondary border border-border-default rounded px-1 py-0.5 text-text-muted
                                                 hover:text-text-primary disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-accent-blue max-w-[7rem]"
                                    >
                                      <option value="">Move…</option>
                                      {moveTargets.map((t) => (
                                        <option key={t.id} value={t.id}>
                                          {t.ungrouped ? "Ungrouped" : t.title}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>

                        {/* Open items */}
                        {g.openItems.length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-1">
                              Open items
                            </div>
                            <ul className="space-y-1">
                              {g.openItems.map((item, i) => {
                                const key = `${item.sessionId}:${item.artifactId}`;
                                return (
                                  <li key={`${item.kind}-${i}`}>
                                    <button
                                      data-feature-openitem
                                      onClick={() => openArtifact(item.sessionId, item.artifactId)}
                                      disabled={opening === key}
                                      className="w-full text-left flex items-start gap-2 px-2 py-1 rounded hover:bg-surface-hover
                                                 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-accent-blue"
                                    >
                                      <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-accent-amber-dim text-accent-amber shrink-0 mt-0.5">
                                        {OPEN_ITEM_LABEL[item.kind]}
                                      </span>
                                      <span className="min-w-0">
                                        <span className="text-xs text-text-primary block truncate">{item.label}</span>
                                        {item.detail && (
                                          <span className="text-2xs text-text-muted block truncate">{item.detail}</span>
                                        )}
                                      </span>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}

                        {/* File touches — compact, monospace, collapsible */}
                        {g.fileTouches.length > 0 && (
                          <div>
                            <button
                              onClick={() => setFilesOpen((f) => ({ ...f, [g.id]: !f[g.id] }))}
                              aria-expanded={!!filesOpen[g.id]}
                              className="text-[10px] font-semibold uppercase tracking-wide text-text-muted hover:text-text-secondary inline-flex items-center gap-1"
                            >
                              <span aria-hidden="true">{filesOpen[g.id] ? "▾" : "▸"}</span>
                              Files touched ({g.fileTouches.length})
                            </button>
                            {filesOpen[g.id] && (
                              <ul className="mt-1 space-y-0.5">
                                {g.fileTouches.map((f) => (
                                  <li key={f.path} className="text-2xs font-mono text-text-secondary truncate">
                                    {f.path}
                                    {f.alsoIn.length > 0 && (
                                      <span className="text-text-muted font-sans not-italic">
                                        {" "}· also touched by {f.alsoIn.join(", ")}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* Honest limits, stated in-UI — no overclaiming. */}
            <p className="text-2xs text-text-muted pt-3 leading-relaxed">
              Grouping is derived from artifact titles, the feature tags the agent stamps as it works,
              and parent/revision threads. You can rename a feature (✎) or move an artifact to another
              feature — your corrections are saved and win over the derived grouping. Anything still
              untagged and without a "Milestone N" / "Phase N" / "Feature:" / "[tag]" prefix lands in
              Ungrouped. File touches come from code changes and changesets; decisions don't carry file
              attribution.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
