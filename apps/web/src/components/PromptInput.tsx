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
    <div className="p-4 border-b border-gray-200">
      <div className="mb-2">
        <input
          type="text"
          placeholder="Project path (e.g., /home/user/my-project)"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          disabled={isActive}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                     disabled:bg-gray-50 disabled:text-gray-500"
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
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm resize-none
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                     disabled:bg-gray-50 disabled:text-gray-500"
        />
        <div className="flex flex-col gap-1">
          {!isDone && (
            <button
              onClick={handleSubmit}
              disabled={isActive || !prompt.trim() || !cwd.trim()}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md
                         hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed
                         transition-colors"
            >
              Start
            </button>
          )}
          {isDone && (
            <button
              onClick={reset}
              className="px-4 py-2 bg-gray-600 text-white text-sm font-medium rounded-md
                         hover:bg-gray-700 transition-colors"
            >
              New
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
