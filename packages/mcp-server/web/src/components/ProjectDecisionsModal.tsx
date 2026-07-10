import { useEffect, useMemo, useState } from "react";
import { apiGet, apiBase } from "../lib/api";
import { enterSessionReplay } from "../lib/session-replay";
import { useModal } from "../hooks/useModal";
import { timeAgo } from "../lib/time";

/**
 * #138 — the project-wide decisions view. A human's one place to browse EVERY
 * decision made across ALL sessions of this project — what was chosen and why —
 * instead of that record being trapped in the session it was made in and lost
 * once the session scrolls away.
 *
 * Read-only. Clicking a row opens that decision in its session via the shared
 * replay-navigation scheme (enterSessionReplay) — the same routing the
 * cross-session SessionBrowser uses. Search is client-side over the decision
 * text + chosen option + session. A corrupt session's decisions surface as an
 * HONEST partial banner, never a silently-shorter list.
 */
interface ProjectDecision {
  decisionId: string;
  sessionId: string;
  sessionTitle: string;
  artifactId: string;
  artifactTitle: string;
  artifactMissing: boolean;
  context: string;
  stakes?: "low" | "medium" | "high";
  optionCount: number;
  resolved: boolean;
  chosenOptionId?: string;
  chosenOptionTitle?: string;
  reasoning?: string;
  confidence?: "low" | "medium" | "high";
  // Optional: a salvage-passing record can lack a timestamp — render "date
  // unknown" rather than a fabricated one.
  createdAt?: string;
  resolvedAt?: string;
  // #153 (S5) — unresolved AND its origin artifact was superseded: it can
  // never resolve, so render "Superseded (never resolved)" instead of a
  // permanent "Awaiting your decision" pill.
  closedUnresolved?: boolean;
}

interface ProjectDecisionsResult {
  decisions: ProjectDecision[];
  // #153 — kind distinguishes "can't read the file NOW" (unreadable/absent)
  // from "the file reads fine but earlier decisions were recovered from
  // corruption and live only in a .corrupt sidecar" (recovered).
  failedSessions: Array<{ sessionId: string; reason: string; kind?: "unreadable" | "recovered" }>;
}

export function ProjectDecisionsModal({ onClose }: { onClose: () => void }) {
  const { dialogProps } = useModal({ onClose });
  const [data, setData] = useState<ProjectDecisionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet(`${apiBase()}/api/decisions`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return (await res.json()) as ProjectDecisionsResult;
      })
      .then((d) => {
        if (cancelled) return;
        setData({ decisions: d.decisions ?? [], failedSessions: d.failedSessions ?? [] });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? "Could not load decisions");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const decisions = data?.decisions ?? [];
  const failedSessions = data?.failedSessions ?? [];

  const filtered = useMemo(() => {
    const list = data?.decisions ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((d) =>
      [d.context, d.chosenOptionTitle ?? "", d.sessionTitle, d.artifactTitle]
        .some((s) => s.toLowerCase().includes(q)),
    );
  }, [data, query]);

  const openDecision = async (d: ProjectDecision) => {
    setOpening(d.decisionId);
    try {
      const ok = await enterSessionReplay(d.sessionId, d.artifactId);
      if (ok) onClose();
    } finally {
      setOpening(null);
    }
  };

  const formatDate = (iso: string) => {
    try {
      const dt = new Date(iso);
      return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " + dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  };

  // Only the true "nothing recorded" state is the empty state — if a session
  // failed to load we show the partial banner instead, never "no decisions yet"
  // (which would lie about the sessions we couldn't read).
  const isEmpty = !loading && !error && decisions.length === 0 && failedSessions.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-16"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label="Project decisions"
        data-testid="decisions-view"
        className="w-full max-w-2xl max-h-[75vh] overflow-y-auto bg-surface-base border border-border-default rounded-lg p-4 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-bold text-text-primary">Project decisions</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xs">
            Esc
          </button>
        </div>
        <p className="text-2xs text-text-muted mb-3">
          Every decision made across all sessions of this project — what was chosen, and why.
        </p>

        <div className="relative mb-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search decisions"
            placeholder="Search decisions (question, chosen option, session)…"
            className="w-full px-3 py-2 pr-8 bg-surface-secondary border border-border-default rounded-lg text-sm text-text-primary
                       placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary text-xs"
              title="Clear search"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Honest partial-data report — a decisions view that silently omits a
            session's decisions is worse than none. Two truths, worded apart
            (#153): a file we can't read NOW, vs a file that reads fine but
            whose pre-corruption decisions survive only in a .corrupt sidecar. */}
        {failedSessions.length > 0 && (() => {
          const unreadable = failedSessions.filter((f) => f.kind !== "recovered");
          const recovered = failedSessions.filter((f) => f.kind === "recovered");
          return (
            <div
              role="status"
              className="mb-3 px-3 py-2 rounded-lg bg-accent-amber-dim border border-accent-amber/30 text-2xs text-accent-amber"
            >
              <span className="font-semibold">Some decisions couldn't be loaded.</span>{" "}
              {unreadable.length > 0 && (
                <>
                  {unreadable.length} session{unreadable.length === 1 ? "" : "s"} had an unreadable
                  decisions.json ({unreadable.map((f) => f.sessionId).join(", ")}) — the list below is
                  partial. A <code>.corrupt</code> backup was written for each.{" "}
                </>
              )}
              {recovered.length > 0 && (
                <>
                  Some of this project's decision history was previously recovered from a corrupted
                  file ({recovered.map((f) => f.sessionId).join(", ")}) — decisions from before the
                  recovery aren't shown. The original file is preserved as{" "}
                  <code>decisions.json.corrupt</code> in each session's folder.
                </>
              )}
            </div>
          );
        })()}

        {loading && (
          <div className="py-8 text-center text-text-muted text-sm" role="status">
            Loading decisions…
          </div>
        )}

        {error && !loading && (
          <div className="py-8 text-center text-accent-red text-sm" role="status">
            Couldn't load decisions: {error}
          </div>
        )}

        {isEmpty && (
          <div className="py-10 text-center text-text-muted text-sm">
            No decisions yet. Decisions you make while pairing will collect here.
          </div>
        )}

        {!loading && !error && decisions.length > 0 && (
          <>
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-text-muted text-sm">
                No decisions match “{query.trim()}”.
              </div>
            ) : (
              <ul className="space-y-2">
                {filtered.map((d) => (
                  <li key={d.decisionId}>
                    <button
                      data-decision-row
                      onClick={() => openDecision(d)}
                      disabled={opening === d.decisionId}
                      className="w-full text-left p-3 bg-surface-elevated border border-white/[0.06] rounded-lg
                                 hover:border-accent-blue/40 hover:bg-surface-hover transition-all duration-[180ms] ease-out
                                 disabled:opacity-50 press-scale focus:outline-none focus:ring-1 focus:ring-accent-blue"
                    >
                      <p className="text-sm font-medium text-text-primary truncate">
                        {d.context || d.artifactTitle}
                      </p>

                      {/* Chosen option — or a visibly-distinct unresolved pill. */}
                      <div className="mt-1.5">
                        {d.resolved ? (
                          <span className="inline-flex items-start gap-1 text-xs text-accent-green">
                            <span aria-hidden="true" className="mt-0.5">✓</span>
                            <span>
                              <span className="text-text-muted">Chose:</span>{" "}
                              <span className="font-medium">{d.chosenOptionTitle}</span>
                              {d.reasoning && (
                                <span className="text-text-muted"> — {d.reasoning}</span>
                              )}
                            </span>
                          </span>
                        ) : d.closedUnresolved ? (
                          // #153 (S5) — the origin artifact was superseded while
                          // this was unresolved: it can never resolve, so don't
                          // show a permanently-lit "awaiting" pill.
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-semibold bg-surface-secondary text-text-muted">
                            Superseded (never resolved)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-semibold bg-accent-amber-dim text-accent-amber">
                            Awaiting your decision
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        {d.stakes && (
                          <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-surface-secondary text-text-muted">
                            {d.stakes} stakes
                          </span>
                        )}
                        <span className="text-2xs text-text-muted truncate max-w-[40%]">
                          {d.sessionTitle}
                        </span>
                        <span className="text-2xs text-text-muted">·</span>
                        {d.resolvedAt ?? d.createdAt ? (
                          <span className="text-2xs text-text-muted" title={formatDate((d.resolvedAt ?? d.createdAt)!)}>
                            {timeAgo((d.resolvedAt ?? d.createdAt)!)}
                          </span>
                        ) : (
                          <span className="text-2xs text-text-muted italic">date unknown</span>
                        )}
                        {d.artifactMissing ? (
                          <span className="text-2xs text-text-muted italic">· artifact unavailable</span>
                        ) : (
                          <>
                            <span className="text-2xs text-text-muted">·</span>
                            <span className="text-2xs text-text-muted truncate max-w-[40%]">
                              {d.artifactTitle}
                            </span>
                          </>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-2xs text-text-muted text-center pt-3">
              Read-only — click a decision to open it in its session.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
