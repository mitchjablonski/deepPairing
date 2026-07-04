import { useEffect, useRef, useState } from "react";
import { timeAgo } from "../lib/time";
import { apiGet, apiBase } from "../lib/api";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { useReplayStore } from "../stores/replay";
import { ArtifactIcon } from "./icons/ArtifactIcons";
import { WaitingForClaude } from "./WaitingForClaude";
import { demoArtifacts, demoComments } from "@deeppairing/shared/__fixtures__/demo-session";

interface SearchResult {
  sessionId: string;
  sessionTitle: string;
  artifactId: string;
  artifactType: string;
  title: string;
  excerpt: string;
  score: number;
  matchedVia: string[];
}


interface SessionSummary {
  id: string;
  createdAt: string;
  lastActivity: string;
  summary: string;
  artifactCount: number;
  hasDecisions: boolean;
}

export function SessionBrowser({ onPicked }: { onPicked?: () => void } = {}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const addArtifact = useArtifactStore((s) => s.addArtifact);
  const addComment = useArtifactStore((s) => s.addComment);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const reset = useArtifactStore((s) => s.reset);
  const hasActiveSession = useConnectionStore((s) => s.activeSessions.length > 0);

  // Cross-session search state
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDemo = () => {
    reset();
    for (const artifact of demoArtifacts) {
      addArtifact(artifact);
    }
    for (const comment of demoComments) {
      addComment(comment);
    }
    const [firstDemo] = demoArtifacts;
    if (firstDemo) selectArtifact(firstDemo.id);
  };

  useEffect(() => {
    apiGet(`${apiBase()}/api/sessions`)
      .then((res) => res.json())
      .then((data) => setSessions(data.sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadSession = async (sessionId: string, focusArtifactId?: string) => {
    setLoadingSession(sessionId);
    try {
      const res = await apiGet(`${apiBase()}/api/sessions/${sessionId}`);
      const state = await res.json();

      reset();
      for (const artifact of state.artifacts ?? []) {
        addArtifact(artifact);
      }
      for (const comment of state.comments ?? []) {
        addComment(comment);
      }
      // C2 review — reset() clears acknowledgedDecisions, so without this
      // re-seed every REPLAYED decision showed a permanently-false
      // "Delivered — Claude will pick it up" for resolutions the agent
      // consumed long ago. Mirror the connection.ts hydration seed.
      const ackedIds = (state.decisions ?? [])
        .filter((d: any) => d?.acknowledged && d?.decisionId)
        .map((d: any) => d.decisionId as string);
      if (ackedIds.length > 0) {
        useArtifactStore.getState().markDecisionsAcknowledged(ackedIds);
      }
      // Opening a past session drops us into replay mode — the scrubber
      // above ArtifactPanel hides events after the cursor, so re-reading
      // feels like walking through the session as it happened.
      await useReplayStore.getState().enterReplay(sessionId, state);

      // When a search result was clicked, advance the scrubber to the
      // matched artifact's creation event so the user lands where they
      // expected to land.
      if (focusArtifactId) {
        const target = (state.artifacts ?? []).find((a: any) => a.id === focusArtifactId);
        if (target) {
          useReplayStore.getState().setCursor(target.createdAt);
          selectArtifact(focusArtifactId);
        }
      }
      // H1 — hosted in the modal, entering replay closes it.
      onPicked?.();
    } catch {
      // Failed to load
    } finally {
      setLoadingSession(null);
    }
  };

  // Debounced search against /api/search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const res = await apiGet(`${apiBase()}/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(`Search failed: ${res.status}`);
        const data = await res.json();
        setResults(data.results ?? []);
      } catch (err: any) {
        setSearchError(err?.message ?? "Search failed");
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query]);

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return dateStr;
    }
  };


  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Loading sessions...
      </div>
    );
  }

  if (sessions.length === 0) {
    // H1 review — modal-hosted (onPicked set = opened from a CONNECTED tab):
    // no demo affordance. loadDemo resets the LIVE store and injects fully
    // mutable fakes whose approvals would POST to the real daemon; it was
    // safe only on the disconnected IdleHome path.
    if (onPicked) {
      return (
        <div className="p-4 text-sm text-text-muted">
          No past sessions recorded for this project yet.
        </div>
      );
    }
    return (
      <div className="p-4 max-w-2xl mx-auto space-y-4">
        <WaitingForClaude />
        <div className="flex flex-col items-center text-text-muted gap-2 pt-2">
          <button
            onClick={loadDemo}
            className="px-4 py-2 bg-accent-blue-strong text-white text-xs font-medium rounded-lg
                       hover:bg-accent-blue/80 transition-all duration-[180ms] ease-out press-scale"
          >
            Or try the demo session
          </button>
          <p className="text-2xs text-text-muted">See what deepPairing looks like with real data</p>
        </div>
      </div>
    );
  }

  const showingSearchResults = query.trim().length > 0;

  return (
    <div className="p-4 space-y-2">
      {/* O1b: when the user has past sessions on disk but no active live
          session, nudge them — otherwise the "list of old sessions" reads as
          the product's empty state, not as "you can start a new one right
          now." */}
      {!hasActiveSession && !showingSearchResults && <WaitingForClaude />}

      {/* Cross-session search */}
      <div className="mb-4">
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search past sessions (titles, concepts, rejected approaches)..."
            className="w-full px-3 py-2 pr-16 bg-surface-secondary border border-border-default rounded-lg text-sm text-text-primary
                       placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue"
          />
          {searching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-2xs text-text-muted animate-pulse">
              searching…
            </span>
          )}
          {query && !searching && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary text-xs"
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        {searchError && (
          <p className="mt-1 text-2xs text-accent-red">{searchError}</p>
        )}
      </div>

      {/* Search results take precedence when a query is active */}
      {showingSearchResults ? (
        <SearchResults
          results={results}
          searching={searching}
          onPick={(r) => loadSession(r.sessionId, r.artifactId)}
        />
      ) : (
        <>
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            Past Sessions ({sessions.length})
          </h2>

          {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => loadSession(session.id)}
          disabled={loadingSession === session.id}
          className="w-full text-left p-3 bg-surface-elevated border border-white/[0.06] rounded-lg
                     hover:border-white/[0.1] hover:bg-surface-hover transition-all duration-[180ms] ease-out
                     disabled:opacity-50 press-scale"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary truncate">
                {session.summary}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-2xs text-text-muted">
                  {formatDate(session.createdAt)}
                </span>
                <span className="text-2xs text-text-muted">·</span>
                <span className="text-2xs text-text-muted">
                  {session.artifactCount} artifact{session.artifactCount !== 1 ? "s" : ""}
                </span>
                {session.hasDecisions && (
                  <>
                    <span className="text-2xs text-text-muted">·</span>
                    <span className="text-2xs text-accent-blue">decisions</span>
                  </>
                )}
              </div>
            </div>
            <span className="text-2xs text-text-muted shrink-0">
              {timeAgo(session.lastActivity)}
            </span>
          </div>
          {loadingSession === session.id && (
            <div className="mt-2 text-2xs text-accent-blue animate-pulse">Loading...</div>
          )}
        </button>
      ))}

          <p className="text-2xs text-text-muted text-center pt-2">
            Past sessions are read-only
          </p>
        </>
      )}
    </div>
  );
}

export function SearchResults({
  results,
  searching,
  onPick,
}: {
  results: SearchResult[];
  searching: boolean;
  onPick: (r: SearchResult) => void;
}) {
  if (results.length === 0) {
    return (
      <div className="text-xs text-text-muted text-center py-8">
        {searching ? "Searching…" : "No matches. Try a different query."}
      </div>
    );
  }

  // Group by session so the user sees which session each hit belongs to
  const bySession = new Map<string, SearchResult[]>();
  for (const r of results) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
        {results.length} match{results.length === 1 ? "" : "es"}
      </p>
      {Array.from(bySession.entries()).map(([sessionId, hits]) => (
        <div key={sessionId} className="space-y-1.5">
          <div className="text-2xs text-text-muted truncate">
            <span className="opacity-70">session:</span>{" "}
            <span className="text-text-secondary font-mono">{hits[0]?.sessionTitle || sessionId}</span>
          </div>
          {hits.map((r) => (
            <button
              key={r.artifactId}
              onClick={() => onPick(r)}
              className="w-full text-left p-2.5 bg-surface-elevated border border-white/[0.06] rounded
                         hover:border-accent-blue/40 hover:bg-surface-hover transition-all duration-[180ms] ease-out press-scale"
            >
              <div className="flex items-start gap-2">
                <ArtifactIcon type={r.artifactType} className="w-3.5 h-3.5 mt-0.5 text-text-muted shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-medium text-text-primary truncate">{r.title}</span>
                    {r.matchedVia.map((via) => (
                      <span
                        key={via}
                        className={`text-[9px] uppercase tracking-wide px-1 py-0.5 rounded ${
                          via === "concept"
                            ? "bg-accent-violet-dim text-accent-violet"
                            : via === "rejected"
                              ? "bg-accent-red-dim text-accent-red"
                              : via === "title"
                                ? "bg-accent-blue-dim text-accent-blue"
                                : "bg-surface-secondary text-text-muted"
                        }`}
                      >
                        {via}
                      </span>
                    ))}
                  </div>
                  <p className="text-2xs text-text-muted truncate mt-0.5">{r.excerpt}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
