import { useState } from "react";
import { useArtifactStore } from "../stores/artifact";

const API_BASE = `http://${window.location.host}`;

/**
 * Free-form message input at the bottom of the companion UI.
 * Sends steering messages to the agent via the comment system.
 * Messages are stored with artifactId: "__session__" and delivered
 * to the agent as "Human directive: {content}" in check_feedback.
 */
export function MessageInput() {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setSending(true);

    try {
      await fetch(`${API_BASE}/api/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId: "__session__",
          content: message.trim(),
          target: { artifactId: "__session__" },
        }),
      });
      setMessage("");
      setSent(true);
      setTimeout(() => setSent(false), 2000);
    } catch {
      // Failed to send
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="px-3 py-2 border-t border-border-default bg-surface-secondary">
      <div className="flex gap-1.5">
        <input
          type="text"
          placeholder="Message the agent... (e.g., 'skip auth, focus on database')"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={sending}
          className="flex-1 px-2.5 py-1.5 bg-surface-primary border border-border-default rounded text-xs text-text-primary
                     placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue
                     disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!message.trim() || sending}
          className="px-3 py-1.5 bg-accent-blue text-white text-xs rounded
                     hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-text-muted
                     transition-colors"
        >
          {sent ? "Sent ✓" : "Send"}
        </button>
      </div>
      <p className="text-2xs text-text-muted mt-1">
        Steering messages reach the agent on its next check_feedback call
      </p>
    </div>
  );
}
