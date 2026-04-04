import { useEffect, useState } from "react";

const API_BASE = "";

interface SessionSummary {
  id: string;
  status: string;
  prompt?: string;
  createdAt?: string;
}

interface SessionListProps {
  onSelectSession?: (sessionId: string) => void;
}

export function SessionList({ onSelectSession }: SessionListProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/sessions`)
      .then((res) => res.json())
      .then((data) => setSessions(data.sessions ?? []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-xs text-gray-400 px-2">Loading...</p>;
  }

  if (sessions.length === 0) {
    return <p className="text-xs text-gray-400 px-2">No sessions yet</p>;
  }

  const statusColors: Record<string, string> = {
    active: "bg-green-400",
    completed: "bg-gray-400",
    error: "bg-red-400",
    running: "bg-green-400",
  };

  return (
    <div className="space-y-1">
      {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => onSelectSession?.(session.id)}
          className="w-full text-left px-2 py-2 rounded hover:bg-gray-100 transition-colors group"
        >
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${statusColors[session.status] ?? "bg-gray-300"}`}
            />
            <span className="text-xs text-gray-700 truncate">
              {session.prompt
                ? session.prompt.slice(0, 50) + (session.prompt.length > 50 ? "..." : "")
                : session.id.slice(0, 12)}
            </span>
          </div>
          {session.createdAt && (
            <p className="text-[10px] text-gray-400 ml-4 mt-0.5">
              {new Date(session.createdAt).toLocaleDateString()} {new Date(session.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
        </button>
      ))}
    </div>
  );
}
