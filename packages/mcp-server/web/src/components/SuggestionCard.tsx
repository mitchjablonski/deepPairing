import { useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { suggestionPill } from "../lib/suggestionPill";

/**
 * #172 — a posted suggested edit, rendered as a first-class card on the
 * artifact (not lost in a comment thread). Header + state pill, a mini unified
 * diff of the human's proposed change, Claude's reply, and — for a COUNTERED
 * suggestion — the counter's own mini-diff (H2 #202) + the negotiation action
 * row (take the counter / insist on mine / reply). Copy follows the batch-2
 * mockup verbatim.
 */

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** A mini unified diff (original − / replacement +), shared by the human's
 *  suggestion and — H2 (#202) — Claude's counter, so both read identically. */
function MiniDiff({ originalText, replacementText }: { originalText: string; replacementText: string }) {
  const originalLines = originalText.split("\n");
  const replacementLines = replacementText.split("\n");
  return (
    <div className="font-mono text-[11.5px] leading-[19px] bg-surface-code py-1.5">
      {originalLines.map((ln, i) => (
        <div key={`d-${i}`} className="px-3 whitespace-pre bg-diff-del-bg text-text-secondary">
          <span className="text-accent-red select-none">− </span>
          {ln || " "}
        </div>
      ))}
      {replacementLines.map((ln, i) => (
        <div key={`a-${i}`} className="px-3 whitespace-pre bg-diff-add-bg text-text-primary">
          <span className="text-accent-green select-none">+ </span>
          {ln || " "}
        </div>
      ))}
    </div>
  );
}

export function SuggestionCard({
  comment,
  replies,
  filePath,
}: {
  comment: Comment;
  /** Agent (and human) replies threaded under this suggestion. */
  replies: Comment[];
  filePath?: string;
}) {
  const resolveSuggestion = useArtifactStore((s) => s.resolveSuggestion);
  const submitComment = useArtifactStore((s) => s.submitComment);
  const [busy, setBusy] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");

  const s = comment.suggestion;
  if (!s) return null;

  const range = s.lineEnd > s.lineStart ? `${s.lineStart}–${s.lineEnd}` : `${s.lineStart}`;
  const loc = `${filePath ?? comment.target.filePath ?? "code"}:${range}`;
  const pill = suggestionPill(s);
  // H2 (#202) — the counter's own code, if the agent proposed one. A counter
  // can be reason-only (prose already shows as an agent reply below) or carry a
  // replacementText we must render so "Take the counter" isn't sight-unseen.
  const counterReplacement = s.counter?.replacementText;
  const agentReplies = replies
    .filter((r) => r.author === "agent")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const act = async (action: "take_counter" | "insist") => {
    if (busy) return;
    setBusy(true);
    try {
      await resolveSuggestion(comment.id, action);
    } catch {
      /* store toasts + rolls back */
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async () => {
    const text = replyText.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await submitComment(
        comment.target.artifactId,
        text,
        { ...comment.target, artifactId: undefined } as Record<string, unknown>,
        { parentCommentId: comment.id },
      );
      setReplyText("");
      setReplyOpen(false);
    } catch {
      /* keep the draft; store toasted */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="suggestion-card"
      data-state={s.state}
      className="border border-border-default rounded-lg overflow-hidden bg-surface-elevated max-w-[700px]"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 text-2xs border-b border-border-subtle">
        <span className="font-bold text-accent-blue tracking-wide">YOUR SUGGESTION</span>
        <span className="text-text-muted">· {loc} · {relativeTime(comment.createdAt)}</span>
        <span
          data-testid="suggestion-state-pill"
          className={`ml-auto rounded-full px-2 py-0.5 font-bold tracking-wide ${pill.cls}`}
        >
          {pill.label}
        </span>
      </div>

      {/* Mini unified diff of the human's proposed change */}
      <MiniDiff originalText={s.originalText} replacementText={s.replacementText} />

      {/* Claude's reply / counter reasoning */}
      {agentReplies.map((r) => (
        <div key={r.id} className="px-3 py-2 text-xs text-text-secondary border-t border-border-subtle">
          <div className="text-2xs font-bold text-accent-violet mb-0.5">
            CLAUDE <span className="text-text-muted font-medium">· {relativeTime(r.createdAt)}</span>
          </div>
          <div className="whitespace-pre-wrap">{r.content}</div>
        </div>
      ))}

      {/* H2 (#202) — Claude's counter, as its own labeled mini-diff so "Take the
          counter" is never accepting code sight-unseen. Original → the agent's
          alternative, mirroring the human's block above. A prose-only counter
          (no replacementText) renders nothing here — the reason already shows as
          the agent reply above. */}
      {s.state === "countered" && counterReplacement != null && (
        <div className="border-t border-border-subtle" data-testid="counter-diff">
          <div className="px-3 pt-2 pb-1 text-2xs font-bold text-accent-violet">Claude&apos;s counter:</div>
          <MiniDiff originalText={s.originalText} replacementText={counterReplacement} />
        </div>
      )}

      {/* Countered: the negotiation action row. */}
      {s.state === "countered" && (
        <div className="flex flex-wrap gap-1.5 px-3 py-2.5 border-t border-border-subtle">
          <button
            type="button"
            disabled={busy}
            onClick={() => act("take_counter")}
            className="px-2.5 py-1 text-2xs rounded border border-accent-green-dim bg-accent-green-dim text-accent-green
                       hover:brightness-110 disabled:opacity-50 transition-all"
          >
            Take the counter
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act("insist")}
            className="px-2.5 py-1 text-2xs rounded border border-border-default bg-surface-elevated text-text-secondary
                       hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            Insist on mine
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setReplyOpen((o) => !o)}
            className="px-2.5 py-1 text-2xs rounded border border-border-default bg-surface-elevated text-text-secondary
                       hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            Reply…
          </button>
        </div>
      )}

      {replyOpen && (
        <div className="px-3 pb-3 -mt-1">
          <textarea
            aria-label="Reply to Claude's counter"
            rows={2}
            autoFocus
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void sendReply();
              }
              if (e.key === "Escape") setReplyOpen(false);
            }}
            placeholder="Talk it out… (⌘⏎ to send, Esc to cancel)"
            disabled={busy}
            className="w-full px-2.5 py-1.5 bg-surface-primary border border-border-default rounded text-xs text-text-primary
                       placeholder-text-muted resize-none focus:outline-none focus:ring-1 focus:ring-accent-violet"
          />
          <div className="flex gap-1.5 mt-1">
            <button
              type="button"
              disabled={!replyText.trim() || busy}
              onClick={() => void sendReply()}
              className="px-2.5 py-1 text-2xs rounded bg-accent-violet-strong text-white hover:bg-accent-violet-strong-hover disabled:opacity-50 transition-colors"
            >
              Send reply
            </button>
            <button
              type="button"
              onClick={() => setReplyOpen(false)}
              className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
