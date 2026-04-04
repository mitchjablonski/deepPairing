import { useState } from "react";
import { useSessionStore } from "../stores/session";

export function PromptInput() {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const { status, startSession, reset } = useSessionStore();

  const isActive = status !== "idle" && status !== "completed" && status !== "error";
  const isDone = status === "completed" || status === "error";

  const handleSubmit = () => {
    if (!prompt.trim() || !cwd.trim() || isActive) return;
    startSession(prompt, cwd);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="p-3 border-b border-border-default bg-surface-secondary">
      <div className="mb-2">
        <input
          type="text"
          placeholder="Project path (e.g., /home/user/my-project)"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          disabled={isActive}
          className="w-full px-3 py-1.5 bg-surface-primary border border-border-default rounded text-sm text-text-primary
                     placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue
                     disabled:opacity-50"
        />
      </div>
      <div className="flex gap-2">
        <textarea
          placeholder="What would you like to explore? (Enter to submit)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isActive}
          rows={2}
          className="flex-1 px-3 py-1.5 bg-surface-primary border border-border-default rounded text-sm text-text-primary
                     placeholder-text-muted resize-none
                     focus:outline-none focus:ring-1 focus:ring-accent-blue
                     disabled:opacity-50"
        />
        <div className="flex flex-col gap-1">
          {!isDone && (
            <button
              onClick={handleSubmit}
              disabled={isActive || !prompt.trim() || !cwd.trim()}
              className="px-4 py-2 bg-accent-blue text-white text-sm font-medium rounded
                         hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-text-muted
                         disabled:cursor-not-allowed transition-colors"
            >
              Start
            </button>
          )}
          {isDone && (
            <button
              onClick={reset}
              className="px-4 py-2 bg-surface-elevated text-text-secondary text-sm font-medium rounded
                         hover:bg-surface-hover transition-colors"
            >
              New
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
