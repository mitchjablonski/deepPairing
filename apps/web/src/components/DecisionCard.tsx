import { useState } from "react";
import type { DecisionRequestEvent } from "@deeppairing/shared";
import { ForkButton } from "./ForkButton";

const API_BASE = "";

interface DecisionCardProps {
  event: DecisionRequestEvent;
  sessionId: string;
  onResolved?: () => void;
}

const effortColors = {
  low: "bg-green-100 text-green-700",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-red-100 text-red-700",
};

const riskColors = {
  low: "bg-green-100 text-green-700",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-red-100 text-red-700",
};

export function DecisionCard({ event, sessionId, onResolved }: DecisionCardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolved, setResolved] = useState(false);

  const handleSubmit = async (optionId: string) => {
    setSubmitting(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/sessions/${sessionId}/decisions/${event.decisionId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            optionId,
            ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
          }),
        },
      );

      if (res.ok) {
        setResolved(true);
        setSelectedId(optionId);
        onResolved?.();
      }
    } catch {
      // Connection error — leave submitting state so user can retry
    } finally {
      setSubmitting(false);
    }
  };

  if (resolved) {
    const chosen = event.options.find((o) => o.id === selectedId);
    const rejected = event.options.filter((o) => o.id !== selectedId);

    return (
      <div className="mx-3 my-2 p-4 bg-green-50 border border-green-200 rounded-lg">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-green-600 text-lg">&#10003;</span>
          <span className="text-sm font-semibold text-green-800">Decision Made</span>
        </div>
        <p className="text-sm text-gray-700">
          <span className="font-medium">{chosen?.title}</span>
          {reasoning && <span className="text-gray-500"> — {reasoning}</span>}
        </p>
        {rejected.length > 0 && (
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-green-200">
            <span className="text-xs text-gray-500">Explore alternatives:</span>
            {rejected.map((opt) => (
              <ForkButton
                key={opt.id}
                sessionId={sessionId}
                decisionId={event.decisionId}
                optionId={opt.id}
                optionTitle={opt.title}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-3 my-3 p-4 bg-rose-50 border border-rose-200 rounded-lg">
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-block w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
        <span className="text-sm font-semibold text-rose-800">Decision Needed</span>
      </div>
      <p className="text-sm text-gray-700 mb-4">{event.context}</p>

      <div className="grid gap-3">
        {event.options.map((option) => (
          <div
            key={option.id}
            className={`p-3 border rounded-lg cursor-pointer transition-all ${
              selectedId === option.id
                ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
                : option.recommendation
                  ? "border-blue-300 bg-white hover:border-blue-400"
                  : "border-gray-200 bg-white hover:border-gray-300"
            }`}
            onClick={() => !submitting && setSelectedId(option.id)}
          >
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold text-gray-900">{option.title}</h4>
                {option.recommendation && (
                  <span className="px-1.5 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded">
                    Recommended
                  </span>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <span className={`px-1.5 py-0.5 text-xs rounded ${effortColors[option.effort]}`}>
                  {option.effort} effort
                </span>
                <span className={`px-1.5 py-0.5 text-xs rounded ${riskColors[option.risk]}`}>
                  {option.risk} risk
                </span>
              </div>
            </div>
            <p className="text-xs text-gray-600 mb-2">{option.description}</p>
            <div className="flex gap-4 text-xs">
              {option.pros.length > 0 && (
                <div>
                  <span className="font-medium text-green-700">Pros: </span>
                  <span className="text-gray-600">{option.pros.join(", ")}</span>
                </div>
              )}
              {option.cons.length > 0 && (
                <div>
                  <span className="font-medium text-red-700">Cons: </span>
                  <span className="text-gray-600">{option.cons.join(", ")}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Reasoning input + submit */}
      {selectedId && (
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            placeholder="Why? (optional)"
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && selectedId) handleSubmit(selectedId);
            }}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={submitting}
          />
          <button
            onClick={() => handleSubmit(selectedId)}
            disabled={submitting}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md
                       hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
          >
            {submitting ? "..." : "Select"}
          </button>
        </div>
      )}
    </div>
  );
}
