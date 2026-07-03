import { useEffect, useMemo, useRef, useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { apiBase, sessionHeaders, safeFetch, ApiError } from "../lib/api";
import { useToastStore } from "../stores/toast";
import { useConnectionStore } from "../stores/connection";
import { useDraft } from "../hooks/useDraft";
import { useAgentRecentlyActive } from "../hooks/useAgentRecentlyActive";
import { useSentFlash } from "../hooks/useSentFlash";

// Stable empty-array reference so Zustand's store selector doesn't produce
// a fresh `[]` on every render (which would trigger an infinite loop via
// useSyncExternalStore).
const EMPTY_COMMENTS: Comment[] = [];

/**
 * Free-form message composer at the bottom of the companion UI.
 * Sends steering messages to the agent via the comment system, stored with
 * artifactId: "__session__" and delivered as "Human directive" in
 * check_feedback.
 *
 * Features:
 * - Multiline textarea (Cmd/Ctrl+Enter sends; Enter inserts newline)
 * - @artifact mentions with fuzzy autocomplete — inline text reference
 * - Last 3 session messages surfaced as thread history above the input
 */
export function MessageInput() {
  const agentRecentlyActive = useAgentRecentlyActive();
  // D9 (H5) — survives reloads; keyed per session so a draft can never
  // follow you across a session switch (M5).
  const sessionId = useConnectionStore((st) => st.sessionId);
  const [message, setMessage] = useDraft(`msg:${sessionId ?? "unbound"}`);
  const [sending, setSending] = useState(false);
  const { sent, flash } = useSentFlash();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const artifacts = useArtifactStore((s) => s.artifacts);
  const sessionComments = useArtifactStore((s) => s.comments["__session__"] ?? EMPTY_COMMENTS);

  // Thread history — last 3 session messages, newest at the bottom to read
  // naturally from older to newer as the eye travels down toward the input.
  const history = useMemo(() => {
    const list = [...sessionComments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return list.slice(-3);
  }, [sessionComments]);

  // @mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const mentionSuggestions = useMemo(() => {
    if (mentionQuery == null) return [] as { id: string; title: string; type: string }[];
    const q = mentionQuery.toLowerCase();
    return artifacts
      .filter((a) => a.status !== "superseded" && a.status !== "retracted")
      .filter((a) => q === "" || a.title.toLowerCase().includes(q))
      .slice(0, 5)
      .map((a) => ({ id: a.id, title: a.title, type: a.type }));
  }, [mentionQuery, artifacts]);

  // Track the textarea content to detect when the caret is inside an @-token.
  const updateMentionState = (text: string, caret: number) => {
    const upToCaret = text.slice(0, caret);
    const lastAt = upToCaret.lastIndexOf("@");
    if (lastAt < 0) { setMentionQuery(null); return; }
    // Must be at start-of-text or preceded by whitespace so we don't match emails.
    const prev = lastAt === 0 ? " " : upToCaret[lastAt - 1];
    if (prev && !/\s/.test(prev)) { setMentionQuery(null); return; }
    const token = upToCaret.slice(lastAt + 1);
    // Cancel if the token has whitespace (token ended).
    if (/\s/.test(token)) { setMentionQuery(null); return; }
    setMentionQuery(token);
    setMentionSelectedIdx(0);
  };

  useEffect(() => { updateMentionState(message, textareaRef.current?.selectionStart ?? message.length); }, [message]);

  const applyMention = (title: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? message.length;
    const upToCaret = message.slice(0, caret);
    const lastAt = upToCaret.lastIndexOf("@");
    if (lastAt < 0) return;
    const before = message.slice(0, lastAt);
    const after = message.slice(caret);
    const insert = `@${title} `;
    const next = before + insert + after;
    setMessage(next);
    setMentionQuery(null);
    // Move caret after the inserted reference.
    requestAnimationFrame(() => {
      const pos = (before + insert).length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
    });
  };

  // U0.1 — sync guard backed by a ref. The previous `if (sending) return`
  // read React state, which doesn't flush until after the event handler;
  // a rapid Cmd+Enter could fire handleSend several times before
  // setSending(true) propagated, producing duplicate POSTs. The ref is
  // synchronous, so the second tap short-circuits immediately.
  const inFlightRef = useRef(false);

  const handleSend = async () => {
    if (!message.trim() || inFlightRef.current) return;
    inFlightRef.current = true;
    setSending(true);

    try {
      await safeFetch(`${apiBase()}/api/comments`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({
          artifactId: "__session__",
          content: message.trim(),
          target: { artifactId: "__session__" },
        }),
      });
      setMessage("");
      flash();
    } catch (err) {
      // U3 — surface the failure as a toast and keep the message in the
      // composer so the user can retry. Pre-U3 this swallowed the error
      // entirely; the user thought their message went through and only
      // realized minutes later (when the agent never responded) that it
      // hadn't.
      const apiErr = err instanceof ApiError ? err : null;
      useToastStore.getState().push({
        kind: "error",
        title: "Send failed",
        body: apiErr?.message ?? (err instanceof Error ? err.message : "Unknown error"),
        ttl: 7000,
      });
    } finally {
      inFlightRef.current = false;
      setSending(false);
    }
  };

  return (
    <div className="px-3 py-2 border-t border-border-default bg-surface-secondary">
      {/* Thread history — last 3 session messages */}
      {history.length > 0 && (
        <div className="space-y-1 mb-2 max-h-[140px] overflow-y-auto">
          {history.map((c) => {
            const isAgent = c.author === "agent";
            return (
              <div
                key={c.id}
                className={`text-2xs px-2 py-1 rounded border ${
                  isAgent
                    ? "bg-accent-blue-dim/15 border-accent-blue/20 text-accent-blue"
                    : "bg-surface-primary border-border-default text-text-secondary"
                }`}
              >
                <span className="opacity-60 mr-1.5 font-medium">{isAgent ? "agent" : "you"}:</span>
                <span className="whitespace-pre-wrap break-words">{c.content}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="relative">
        <textarea
          ref={textareaRef}
          rows={2}
          placeholder="Message the agent... (Cmd+Enter to send, @ to reference artifacts)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (mentionQuery != null && mentionSuggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionSelectedIdx((i) => Math.min(i + 1, mentionSuggestions.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionSelectedIdx((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                applyMention(mentionSuggestions[mentionSelectedIdx].title);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionQuery(null);
                return;
              }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
          onKeyUp={(e) => {
            const ta = e.currentTarget;
            updateMentionState(ta.value, ta.selectionStart ?? ta.value.length);
          }}
          onClick={(e) => {
            const ta = e.currentTarget;
            updateMentionState(ta.value, ta.selectionStart ?? ta.value.length);
          }}
          disabled={sending}
          className="w-full px-2.5 py-1.5 bg-surface-primary border border-border-default rounded text-xs text-text-primary resize-none
                     placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue
                     disabled:opacity-50"
        />

        {/* @mention autocomplete */}
        {mentionQuery != null && mentionSuggestions.length > 0 && (
          <div className="absolute left-0 bottom-full mb-1 w-full max-w-sm bg-surface-elevated border border-border-default rounded shadow-lg overflow-hidden z-10">
            <div className="px-2 py-1 text-2xs text-text-muted border-b border-border-default">
              Reference artifact
            </div>
            {mentionSuggestions.map((s, i) => (
              <button
                key={s.id}
                onMouseEnter={() => setMentionSelectedIdx(i)}
                onClick={() => applyMention(s.title)}
                className={`w-full flex items-center gap-2 px-2 py-1 text-left transition-colors ${
                  i === mentionSelectedIdx
                    ? "bg-accent-blue-dim/40 text-accent-blue"
                    : "text-text-secondary hover:bg-surface-hover"
                }`}
              >
                <span className="text-2xs opacity-60 font-mono">{s.type}</span>
                <span className="text-xs truncate flex-1">{s.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-1">
        {/* D8 (M3) — the "under 30s" promise is only honest while the agent
            heartbeat is fresh; when it's idle/gone, don't promise latency. */}
        <p className="text-2xs text-text-muted">
          {agentRecentlyActive
            ? "The agent will see this the next time it checks in — usually under 30s"
            : "The agent will see this the next time it checks in"}
        </p>
        <button
          onClick={handleSend}
          disabled={!message.trim() || sending}
          className="px-3 py-1 bg-accent-blue-strong text-white text-2xs rounded
                     hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-text-muted
                     transition-all duration-[180ms] ease-out press-scale"
        >
          {sent ? "Sent ✓" : "Send"}
          <kbd className="ml-1.5 font-mono opacity-70 text-[9px]">⌘⏎</kbd>
        </button>
      </div>
    </div>
  );
}
