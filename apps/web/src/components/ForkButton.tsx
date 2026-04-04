import { useState } from "react";

const API_BASE = "http://localhost:3001";

interface ForkButtonProps {
  sessionId: string;
  decisionId: string;
  optionId: string;
  optionTitle: string;
  disabled?: boolean;
}

export function ForkButton({
  sessionId,
  decisionId,
  optionId,
  optionTitle,
  disabled,
}: ForkButtonProps) {
  const [status, setStatus] = useState<"idle" | "forking" | "running" | "done" | "error">("idle");

  const handleFork = async () => {
    setStatus("forking");
    try {
      const res = await fetch(
        `${API_BASE}/api/sessions/${sessionId}/decisions/${decisionId}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ optionId, optionTitle }),
        },
      );

      if (!res.ok) throw new Error("Fork failed");

      const data = await res.json();
      setStatus("running");

      // Poll for completion
      pollForkStatus(data.forkId);
    } catch {
      setStatus("error");
    }
  };

  const pollForkStatus = async (id: string) => {
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/forks/${id}`);
        if (!res.ok) return;

        const data = await res.json();
        if (data.status === "completed") {
          setStatus("done");
        } else if (data.status === "error") {
          setStatus("error");
        } else {
          setTimeout(poll, 2000);
        }
      } catch {
        setStatus("error");
      }
    };
    setTimeout(poll, 2000);
  };

  if (status === "idle") {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); handleFork(); }}
        disabled={disabled}
        className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded
                   hover:bg-blue-50 hover:text-blue-600 transition-colors
                   disabled:opacity-50 disabled:cursor-not-allowed"
        title="Explore this option in a separate branch"
      >
        Explore
      </button>
    );
  }

  if (status === "forking" || status === "running") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 text-xs text-amber-600 bg-amber-50 rounded">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        {status === "forking" ? "Starting..." : "Exploring..."}
      </span>
    );
  }

  if (status === "done") {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); /* TODO: open comparison view */ }}
        className="px-2 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100 transition-colors"
      >
        View results
      </button>
    );
  }

  return (
    <span className="px-2 py-1 text-xs text-red-600 bg-red-50 rounded">
      Failed
    </span>
  );
}
