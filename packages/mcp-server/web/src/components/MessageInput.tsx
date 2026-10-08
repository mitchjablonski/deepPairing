import { useEffect, useMemo, useRef, useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { apiBase, sessionHeaders, safeFetch, ApiError } from "../lib/api";
import { useToastStore } from "../stores/toast";
import { useConnectionStore } from "../stores/connection";
import { useReplayStore } from "../stores/replay";
import { useDraft, clearDraftIfUnchanged, isDraftSending, markDraftSending, useDraftSending } from "../hooks/useDraft";
import { useAgentRecentlyActive } from "../hooks/useAgentRecentlyActive";
import { useSentFlash } from "../hooks/useSentFlash";
import { useOfflineReason } from "../hooks/useOfflineReason";

// Stable empty-array reference so Zustand's store selector doesn't produce
// a fresh `[]` on every render (which would trigger an infinite loop via
// useSyncExternalStore).
const EMPTY_COMMENTS: Comment[] = [];

/**
 * #417 review — give up on a send after this long. safeFetch has no timeout,
 * and the per-draft in-flight marker (below) now outlives a remount, so a POST
 * that never settles would keep this session's composer disabled until a
 * reload. The route is a local file write whose locks are bounded (250ms
 * store lock, 1s ledger lock → 503 lock_busy), so a healthy daemon answers in
 * well under a second even on slow disks (WSL /mnt/c); 30s is far past any
 * legitimate reply and short enough that a wedge is noticed.
 */
const SEND_TIMEOUT_MS = 30_000;

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
  // #465 (state G rule 1) — Send disables while disconnected; the text stays.
  const offline = useOfflineReason();
  // F12 review — this composer BYPASSES the store choke point (own safeFetch)
  // and rendered against the replayed session's thread while SENDING into
  // the live tab binding: a visual reply into history that lands elsewhere.
  const replayActive = useReplayStore((st) => st.active);
  const boundLive = useConnectionStore(
    (st) => st.activeSessions.find((x) => x.sessionId === st.sessionId)?.live !== false,
  );
  const agentRecentlyActive = useAgentRecentlyActive();
  // D9 (H5) — survives reloads; keyed per session so a draft can never
  // follow you across a session switch (M5).
  const sessionId = useConnectionStore((st) => st.sessionId);
  const draftKey = `msg:${sessionId ?? "unbound"}`;
  const [message, setMessage] = useDraft(draftKey);
  // #417 review — keyed per draft and held outside this instance (see
  // markDraftSending): a composer that remounts mid-send stays "sending", and
  // a send pending in session A no longer locks session B's composer.
  const sending = useDraftSending(draftKey);
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

  // U0.1 — the double-submit guard must be SYNCHRONOUS: React state doesn't
  // flush until after the event handler, so a rapid Cmd+Enter could fire
  // handleSend several times. `isDraftSending` reads a plain Set, so the second
  // tap short-circuits immediately — and (#417 review) across a remount too.

  // #417 — a send's completion must land on the composer it came FROM. This
  // component is not keyed by session: switching sessions re-keys the draft
  // in place, so a send started in A that settled after a switch to B ran
  // `setMessage("")` against B's draft (deleting it after the debounce) and
  // flashed "Sent" in B. Completion is bound to the originating session by
  // IDENTITY — the tab's sessionId, not the store generation (#415 round 3:
  // a same-session reconnect must still clear and flash) — plus this
  // instance's lifetime, and the text that was sent.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const messageRef = useRef(message);
  messageRef.current = message;

  const handleSend = async () => {
    if (!message.trim() || isDraftSending(draftKey) || offline) return; // #465 — ⌘⏎ too
    const release = markDraftSending(draftKey);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SEND_TIMEOUT_MS);
    const origin = { sessionId, draftKey, text: message };
    const stillHere = () => mountedRef.current && useConnectionStore.getState().sessionId === origin.sessionId;

    try {
      await safeFetch(`${apiBase()}/api/comments`, {
        method: "POST",
        headers: sessionHeaders(origin.sessionId ?? undefined),
        signal: controller.signal,
        body: JSON.stringify({
          artifactId: "__session__",
          content: message.trim(),
          target: { artifactId: "__session__" },
        }),
      });
      if (stillHere()) {
        // Clear only the text that was sent (the textarea is disabled while
        // sending, so in practice it is; an A→B→A round trip reloads A's
        // saved draft, which is that same text).
        if (messageRef.current === origin.text) setMessage("");
        flash();
      } else {
        // Moved on (switched away, or unmounted): touch nothing on screen and
        // say nothing here. Retire the ORIGIN session's saved draft if it is
        // still exactly the sent text, so it doesn't resurrect as unsent when
        // you return; anything written since is kept.
        clearDraftIfUnchanged(origin.draftKey, origin.text);
      }
    } catch (err) {
      // U3 — surface the failure as a toast and keep the message in the
      // composer so the user can retry. Pre-U3 this swallowed the error
      // entirely; the user thought their message went through and only
      // realized minutes later (when the agent never responded) that it
      // hadn't.
      // #417 — still toast after a switch (a silent failure is exactly the U3
      // trap: you left believing it went), but name it as the PREVIOUS
      // session's so it can't read as a failure of anything in this one. The
      // draft stays saved there for the retry.
      const apiErr = err instanceof ApiError ? err : null;
      const detail = apiErr?.message ?? (err instanceof Error ? err.message : "Unknown error");
      const switched = useConnectionStore.getState().sessionId !== origin.sessionId;
      if (timedOut) {
        // The POST may still have landed. The server only dedupes an identical
        // comment within 5s and the payload carries no client id, so a resend
        // now could post twice: say so instead of implying a clean failure.
        useToastStore.getState().push({
          kind: "error",
          title: switched ? "Message to your previous session timed out" : "Send timed out",
          body: "It may or may not have reached the agent — check the recent messages before resending. Your draft is kept.",
          ttl: 0,
        });
        return;
      }
      useToastStore.getState().push({
        kind: "error",
        title: switched ? "Message to your previous session wasn't sent" : "Send failed",
        body: switched ? `${detail} — your draft is still saved there; switch back to retry.` : detail,
        ttl: 7000,
      });
    } finally {
      clearTimeout(timer);
      release();
    }
  };

  if (replayActive) {
    return (
      <div
        role="region"
        aria-label="Message the agent"
        className="px-3 py-2 border-t border-border-default text-xs text-text-muted"
      >
        ⏸ Replay — read-only. Exit replay (Esc) to message the agent.
      </div>
    );
  }

  return (
    // Q4 review (L5) — a named landmark. The composer is the app's primary
    // input and it sat OUTSIDE every landmark, so axe's `region` rule (all
    // content belongs to one) flagged both its body and its latency hint, and
    // a screen-reader user had no way to jump to it. role=region rather than a
    // <form>: this composer sends via a button + ⌘⏎, never a form submit, and
    // an unsubmittable <form> is a worse lie than a generic region.
    <div
      role="region"
      aria-label="Message the agent"
      className="px-3 py-2 border-t border-border-default bg-surface-secondary"
    >
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
                // Guarded: a live artifact update can shrink the suggestion
                // list under a stale selected index — this used to throw.
                // F5 review — clamp to the last suggestion rather than
                // swallowing the keypress (preventDefault already fired).
                const selected =
                  mentionSuggestions[Math.min(mentionSelectedIdx, mentionSuggestions.length - 1)];
                if (selected) applyMention(selected.title);
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
          {/* H1 — a dead session gets the F8 honest phrasing, not a promise. */}
          {!boundLive
            ? "The agent exited — your message is saved and will be seen if the session resumes"
            : agentRecentlyActive
              ? "The agent will see this the next time it checks in — usually under 30s"
              : "The agent will see this the next time it checks in"}
        </p>
        <button
          onClick={handleSend}
          disabled={!message.trim() || sending || !!offline}
          title={offline ?? undefined}
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
