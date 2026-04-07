import { useEffect, useState } from "react";
import { useArtifactStore } from "../stores/artifact";
import { ArtifactIcon } from "./icons/ArtifactIcons";

const API_BASE = `http://${window.location.host}`;

interface SessionSummary {
  id: string;
  createdAt: string;
  lastActivity: string;
  summary: string;
  artifactCount: number;
  hasDecisions: boolean;
}

export function SessionBrowser() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const { addArtifact, addComment, reset } = useArtifactStore();

  useEffect(() => {
    fetch(`${API_BASE}/api/sessions`)
      .then((res) => res.json())
      .then((data) => setSessions(data.sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadSession = async (sessionId: string) => {
    setLoadingSession(sessionId);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
      const state = await res.json();

      reset();
      for (const artifact of state.artifacts ?? []) {
        addArtifact(artifact);
      }
      for (const comment of state.comments ?? []) {
        addComment(comment);
      }
    } catch {
      // Failed to load
    } finally {
      setLoadingSession(null);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return dateStr;
    }
  };

  const timeAgo = (dateStr: string) => {
    try {
      const ms = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(ms / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return "";
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
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3 p-8">
        <ArtifactIcon type="research" className="w-8 h-8 opacity-30" />
        <div className="text-center">
          <p className="text-sm">No sessions yet</p>
          <p className="text-xs mt-1">Start a conversation with Claude Code using deepPairing tools</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-2">
      <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
        Past Sessions ({sessions.length})
      </h2>

      {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => loadSession(session.id)}
          disabled={loadingSession === session.id}
          className="w-full text-left p-3 bg-surface-elevated border border-border-subtle rounded-lg
                     hover:border-border-default hover:bg-surface-hover transition-colors
                     disabled:opacity-50"
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
    </div>
  );
}
