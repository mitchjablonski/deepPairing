import { useEffect, useMemo, useRef } from "react";
import type { Comment, Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useFocusTrap } from "../hooks/useFocusTrap";

/**
 * W1 — Conversation rail.
 *
 * Why it exists: comments live on whichever artifact carries them and were
 * only visible when the user opened that artifact. In a multi-artifact
 * session (which the agent often produces all-at-once: findings + plan +
 * code_changes), Q&A scattered across artifacts left the user blind to
 * what was outstanding. This is a single chronological feed of every
 * comment + reply in the session, grouped by artifact and visually
 * threaded by parentCommentId.
 *
 * Click a row → dispatches `dp:focus-artifact` (the same event the
 * `Jump to answer` toast uses) so the artifact panel selects it and
 * scrolls into view.
 */

interface ConversationRailProps {
  onClose: () => void;
}

interface ThreadedRow {
  comment: Comment;
  replies: Comment[];
  artifactId: string;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Pick a short location tag from a comment's target — line range or
 *  finding-anchor — so the user can tell "auth.ts L23" vs "step 2"
 *  vs "freeform message" at a glance. */
function targetLabel(c: Comment, artifact?: Artifact): string {
  const t: any = c.target ?? {};
  if (t.artifactId === "__session__") return "session";
  if (typeof t.lineStart === "number") {
    const file = t.filePath ? `${String(t.filePath).split("/").pop()} ` : "";
    if (typeof t.lineEnd === "number" && t.lineEnd !== t.lineStart) {
      return `${file}L${t.lineStart}–L${t.lineEnd}`;
    }
    return `${file}L${t.lineStart}`;
  }
  if (typeof t.stepIndex === "number") return `step ${t.stepIndex + 1}`;
  if (typeof t.findingIndex === "number") return `finding ${t.findingIndex + 1}`;
  if (artifact) return artifact.type;
  return "comment";
}

export function ConversationRail({ onClose }: ConversationRailProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const artifacts = useArtifactStore((s) => s.artifacts);
  const commentsByArtifact = useArtifactStore((s) => s.comments);

  useFocusTrap(panelRef, true);
  useEffect(() => { panelRef.current?.focus(); }, []);

  // Build the threaded view:
  //   - Group comments by artifactId
  //   - Within each group: top-level comments (no parentCommentId) sorted
  //     newest-first, with their direct replies (parentCommentId === id)
  //     nested under them in chronological order (oldest reply first so
  //     the conversation reads naturally top-down).
  //   - Group order: most-recent activity wins — an artifact whose latest
  //     comment landed 30s ago floats above one with a 5m-old comment.
  //
  // No backend roundtrip: every comment is already in the artifact store
  // (hydrated on connect, broadcast on each comment_added).
  const grouped = useMemo(() => {
    type Group = {
      artifactId: string;
      artifact: Artifact | undefined;
      threads: ThreadedRow[];
      latestAt: number;
    };
    const groups: Group[] = [];
    const artifactById = new Map(artifacts.map((a) => [a.id, a]));

    for (const [artifactId, comments] of Object.entries(commentsByArtifact)) {
      if (!comments || comments.length === 0) continue;

      // Index by id for O(1) parent lookup; collect each comment's replies
      const byId = new Map<string, Comment>();
      for (const c of comments) byId.set(c.id, c);
      const repliesByParent = new Map<string, Comment[]>();
      for (const c of comments) {
        if (c.parentCommentId && byId.has(c.parentCommentId)) {
          const arr = repliesByParent.get(c.parentCommentId) ?? [];
          arr.push(c);
          repliesByParent.set(c.parentCommentId, arr);
        }
      }
      // Top-level rows = comments without a parent (or whose parent is gone).
      const tops = comments.filter(
        (c) => !c.parentCommentId || !byId.has(c.parentCommentId),
      );
      const threads: ThreadedRow[] = tops.map((top) => {
        const replies = (repliesByParent.get(top.id) ?? []).slice().sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt),
        );
        return { comment: top, replies, artifactId };
      });
      // Newest top-level first within the group.
      threads.sort((a, b) => b.comment.createdAt.localeCompare(a.comment.createdAt));

      const latestAt = comments
        .map((c) => new Date(c.createdAt).getTime())
        .reduce((max, t) => (t > max ? t : max), 0);

      groups.push({ artifactId, artifact: artifactById.get(artifactId), threads, latestAt });
    }

    // Most-recent group wins.
    groups.sort((a, b) => b.latestAt - a.latestAt);
    return groups;
  }, [artifacts, commentsByArtifact]);

  const totalComments = useMemo(
    () => grouped.reduce((sum, g) => sum + g.threads.length + g.threads.reduce((s, t) => s + t.replies.length, 0), 0),
    [grouped],
  );
  const unansweredQuestions = useMemo(() => {
    let n = 0;
    for (const g of grouped) {
      for (const t of g.threads) {
        if (t.comment.author === "human" && (t.comment as any).intent === "question" && t.replies.length === 0) {
          n++;
        }
      }
    }
    return n;
  }, [grouped]);

  const focusArtifact = (artifactId: string) => {
    // Re-uses the existing focus event the question_answered toast wires.
    window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId } }));
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        role="dialog"
        aria-label="Conversation"
        className="fixed top-0 right-0 bottom-0 z-50 w-[480px] max-w-[92vw]
                   bg-surface-elevated border-l border-border-default shadow-2xl
                   overflow-y-auto focus:outline-none"
      >
        <div className="sticky top-0 flex items-center justify-between px-5 py-3 border-b border-border-default bg-surface-elevated z-10">
          <div>
            <h2 className="text-sm font-bold text-text-primary">Conversation</h2>
            <div className="text-2xs text-text-muted mt-0.5">
              {totalComments === 0
                ? "No comments yet"
                : `${totalComments} message${totalComments === 1 ? "" : "s"} across ${grouped.length} artifact${grouped.length === 1 ? "" : "s"}`}
              {unansweredQuestions > 0 && (
                <span className="ml-2 text-accent-violet">
                  · {unansweredQuestions} unanswered question{unansweredQuestions === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-2xs"
            title="Close (Esc)"
          >
            Esc
          </button>
        </div>

        {grouped.length === 0 ? (
          <div className="p-8 text-center text-xs text-text-muted">
            No comments in this session yet. Click <span className="font-mono">+</span> on any line of evidence to start a thread.
          </div>
        ) : (
          <div className="px-3 py-3 space-y-4">
            {grouped.map((g) => (
              <div key={g.artifactId} className="rounded border border-border-default overflow-hidden">
                {/* Artifact group header */}
                <button
                  onClick={() => focusArtifact(g.artifactId)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-surface-secondary hover:bg-surface-hover transition-colors text-left"
                  title="Open this artifact"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-2xs uppercase tracking-wide text-text-muted">
                      {g.artifact?.type ?? "artifact"}
                    </div>
                    <div className="text-xs text-text-primary truncate">
                      {g.artifact?.title ?? g.artifactId}
                    </div>
                  </div>
                  <span className="text-[10px] text-text-muted shrink-0">
                    {timeAgo(new Date(g.latestAt).toISOString())}
                  </span>
                </button>

                {/* Threads in this group */}
                <div className="divide-y divide-border-subtle">
                  {g.threads.map((t) => (
                    <ThreadEntry
                      key={t.comment.id}
                      thread={t}
                      artifact={g.artifact}
                      onFocus={() => focusArtifact(g.artifactId)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ThreadEntry({
  thread,
  artifact,
  onFocus,
}: {
  thread: ThreadedRow;
  artifact: Artifact | undefined;
  onFocus: () => void;
}) {
  const { comment, replies } = thread;
  const isUnansweredQuestion =
    comment.author === "human" &&
    (comment as any).intent === "question" &&
    replies.length === 0;

  return (
    <div
      onClick={onFocus}
      className="px-3 py-2 cursor-pointer hover:bg-surface-hover transition-colors"
      title="Click to open this artifact"
    >
      <CommentRow comment={comment} location={targetLabel(comment, artifact)} />
      {replies.length > 0 && (
        <div className="ml-4 mt-1.5 pl-3 border-l-2 border-border-default space-y-1.5">
          {replies.map((r) => (
            <CommentRow key={r.id} comment={r} location={targetLabel(r, artifact)} reply />
          ))}
        </div>
      )}
      {isUnansweredQuestion && (
        <div className="ml-4 mt-1 text-[10px] text-accent-violet/80">
          ⏳ awaiting agent answer (next check_feedback)
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  location,
  reply,
}: {
  comment: Comment;
  location: string;
  reply?: boolean;
}) {
  const isAgent = comment.author === "agent";
  const isQuestion = (comment as any).intent === "question";
  const authorLabel = isAgent ? "Agent" : "You";
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
        <span className={`font-semibold ${isAgent ? "text-text-secondary" : "text-accent-blue"}`}>
          {reply && <span className="opacity-60 mr-1">↳</span>}
          {authorLabel}
        </span>
        <span>·</span>
        <span>{timeAgo(comment.createdAt)}</span>
        <span>·</span>
        <span className="font-mono">{location}</span>
        {isQuestion && (
          <span className="ml-1 px-1 py-px rounded bg-accent-violet-dim text-accent-violet text-[9px]">
            ❓ question
          </span>
        )}
      </div>
      <div className={`mt-0.5 text-xs whitespace-pre-wrap break-words ${reply ? "text-text-secondary" : "text-text-primary"}`}>
        {comment.content}
      </div>
    </div>
  );
}
