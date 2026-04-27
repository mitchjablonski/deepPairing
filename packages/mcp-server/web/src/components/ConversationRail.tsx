import { useEffect, useMemo, useRef, useState } from "react";
import type { Comment, Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useFocusTrap } from "../hooks/useFocusTrap";

// W2 — "last opened" timestamp persisted to sessionStorage so we know
// which comments arrived since the user last looked at the rail. Stored
// per session-tab; survives drawer open/close cycles but resets when the
// tab is reloaded (which is when the artifact store rehydrates anyway).
const RAIL_LAST_OPENED_KEY = "dp:rail-last-opened-at";

function loadLastOpenedAt(): number {
  try {
    const raw = sessionStorage.getItem(RAIL_LAST_OPENED_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function saveLastOpenedAt(ms: number): void {
  try { sessionStorage.setItem(RAIL_LAST_OPENED_KEY, String(ms)); } catch {}
}

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

type FilterMode = "all" | "unanswered";

export function ConversationRail({ onClose }: ConversationRailProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const artifacts = useArtifactStore((s) => s.artifacts);
  const commentsByArtifact = useArtifactStore((s) => s.comments);
  // W2 — filter state for the unanswered-only view. Default to "all" so a
  // first-time opener sees the full feed; switching to "unanswered"
  // collapses the list to just the human questions still waiting on a
  // reply, which is the triage surface most users will reach for.
  const [filter, setFilter] = useState<FilterMode>("all");

  // W2 — capture the previous "last opened" once on mount; we use it to
  // diff which comments arrived since. Then UPDATE the persisted value to
  // now, so the next open's "since" clock starts here. Effectively: while
  // the rail is open, every comment is "unread" relative to the moment we
  // opened it; close + reopen = fresh diff.
  const [previousLastOpenedAt] = useState<number>(() => loadLastOpenedAt());
  useEffect(() => { saveLastOpenedAt(Date.now()); }, []);

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

  // Apply the current filter to the threads inside each group, keeping
  // group order intact. A group with zero threads after filtering drops
  // out of the visible list entirely.
  const visibleGrouped = useMemo(() => {
    if (filter === "all") return grouped;
    return grouped
      .map((g) => ({
        ...g,
        threads: g.threads.filter(
          (t) =>
            t.comment.author === "human" &&
            (t.comment as any).intent === "question" &&
            t.replies.length === 0,
        ),
      }))
      .filter((g) => g.threads.length > 0);
  }, [grouped, filter]);

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

  // W2 — count comments whose createdAt is newer than the previous open.
  // Also bubble up per-group new-counts so each artifact header can show
  // a small pip when it has fresh activity.
  const isUnread = (c: Comment) => new Date(c.createdAt).getTime() > previousLastOpenedAt;
  const unreadByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of grouped) {
      let n = 0;
      for (const t of g.threads) {
        if (isUnread(t.comment)) n++;
        for (const r of t.replies) if (isUnread(r)) n++;
      }
      if (n > 0) map.set(g.artifactId, n);
    }
    return map;
  }, [grouped, previousLastOpenedAt]);
  const totalUnread = useMemo(
    () => Array.from(unreadByGroup.values()).reduce((a, b) => a + b, 0),
    [unreadByGroup],
  );

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
        <div className="sticky top-0 flex flex-col gap-2 px-5 py-3 border-b border-border-default bg-surface-elevated z-10">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-text-primary">
                Conversation
                {totalUnread > 0 && (
                  <span
                    className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-4 px-1.5 rounded-full bg-accent-blue text-white text-[10px] font-semibold"
                    aria-label={`${totalUnread} new since last open`}
                    title={`${totalUnread} new since you last opened the rail`}
                  >
                    {totalUnread > 99 ? "99+" : totalUnread}
                  </span>
                )}
              </h2>
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
          {/* W2 filter pills */}
          {totalComments > 0 && (
            <div className="flex items-center gap-1">
              <FilterPill
                active={filter === "all"}
                onClick={() => setFilter("all")}
                label="All"
                count={totalComments}
              />
              <FilterPill
                active={filter === "unanswered"}
                onClick={() => setFilter("unanswered")}
                label="Unanswered"
                count={unansweredQuestions}
                accent
              />
            </div>
          )}
        </div>

        {visibleGrouped.length === 0 ? (
          <div className="p-8 text-center text-xs text-text-muted">
            {filter === "unanswered"
              ? "No unanswered questions. Switch to All to see the full feed."
              : <>No comments in this session yet. Click <span className="font-mono">+</span> on any line of evidence to start a thread.</>}
          </div>
        ) : (
          <div className="px-3 py-3 space-y-4">
            {visibleGrouped.map((g) => {
              const groupUnread = unreadByGroup.get(g.artifactId) ?? 0;
              return (
                <div key={g.artifactId} className="rounded border border-border-default overflow-hidden">
                  {/* Artifact group header */}
                  <button
                    onClick={() => focusArtifact(g.artifactId)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-surface-secondary hover:bg-surface-hover transition-colors text-left"
                    title="Open this artifact"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-text-muted">
                        {g.artifact?.type ?? "artifact"}
                        {groupUnread > 0 && (
                          <span
                            className="inline-flex items-center justify-center min-w-[1rem] h-3.5 px-1 rounded-full bg-accent-blue text-white text-[9px] font-semibold normal-case tracking-normal"
                            aria-label={`${groupUnread} new`}
                          >
                            {groupUnread > 99 ? "99+" : groupUnread}
                          </span>
                        )}
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
                        isUnread={isUnread}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
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
  isUnread,
}: {
  thread: ThreadedRow;
  artifact: Artifact | undefined;
  onFocus: () => void;
  isUnread: (c: Comment) => boolean;
}) {
  const { comment, replies } = thread;
  const { submitComment } = useArtifactStore();
  const isUnansweredQuestion =
    comment.author === "human" &&
    (comment as any).intent === "question" &&
    replies.length === 0;
  // W2 — a thread is "fresh" if the parent OR any reply is unread. The
  // parent gets the dot regardless of which row is fresh; per-reply dots
  // make the diff readable when only the agent's answer is new.
  const threadHasUnread = isUnread(comment) || replies.some(isUnread);

  // Inline reply state. The newest agent reply (or the parent comment
  // itself if no replies yet but it's an agent comment) is the natural
  // reply target — that's how the user continues the thread.
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replySubmitting, setReplySubmitting] = useState(false);

  // Pick the comment to reply to: the latest reply if any, else the parent.
  const replyTarget = replies.length > 0 ? replies[replies.length - 1] : comment;

  const submitReply = async () => {
    const text = replyText.trim();
    if (!text || replySubmitting) return;
    setReplySubmitting(true);
    try {
      await submitComment(
        comment.target.artifactId,
        text,
        // Inherit the target so the reply lands at the same anchor as
        // the conversation it's continuing. Strip artifactId from
        // target since submitComment re-applies it.
        { ...(replyTarget.target ?? {}), artifactId: undefined } as any,
        { parentCommentId: replyTarget.id },
      );
      setReplyOpen(false);
      setReplyText("");
    } finally {
      setReplySubmitting(false);
    }
  };

  return (
    <div
      className={`px-3 py-2 transition-colors ${
        threadHasUnread ? "bg-accent-blue-dim/10" : ""
      }`}
    >
      <div onClick={onFocus} className="cursor-pointer hover:bg-surface-hover -mx-3 -my-2 px-3 py-2" title="Click to open this artifact">
        <CommentRow comment={comment} location={targetLabel(comment, artifact)} unread={isUnread(comment)} />
        {replies.length > 0 && (
          <div className="ml-4 mt-1.5 pl-3 border-l-2 border-border-default space-y-1.5">
            {replies.map((r) => (
              <CommentRow
                key={r.id}
                comment={r}
                location={targetLabel(r, artifact)}
                reply
                unread={isUnread(r)}
              />
            ))}
          </div>
        )}
        {isUnansweredQuestion && (
          <div className="ml-4 mt-1 text-[10px] text-accent-violet/80">
            ⏳ awaiting agent answer (next check_feedback)
          </div>
        )}
      </div>

      {/* Reply affordance — visible whenever there's an agent presence in
          the thread (either parent or any reply). Clicking opens an
          inline composer; submit posts a comment with parentCommentId
          pointing at the latest agent reply (or the parent if it's the
          agent), continuing the thread. */}
      {(comment.author === "agent" || replies.some((r) => r.author === "agent")) && (
        <div className="ml-4 mt-1.5">
          {replyOpen ? (
            <div className="pl-3 border-l-2 border-accent-blue/30 space-y-1.5">
              <textarea
                rows={2}
                autoFocus
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitReply();
                  }
                  if (e.key === "Escape") {
                    setReplyOpen(false);
                    setReplyText("");
                  }
                }}
                placeholder="Continue the thread… (⌘⏎ to send, Esc to cancel)"
                disabled={replySubmitting}
                className="w-full px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-2xs text-text-primary
                           placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue resize-none"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={submitReply}
                  disabled={!replyText.trim() || replySubmitting}
                  className="px-2.5 py-1 bg-accent-blue text-white text-2xs rounded
                             hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-text-muted transition-colors"
                >
                  Reply
                </button>
                <button
                  type="button"
                  onClick={() => { setReplyOpen(false); setReplyText(""); }}
                  className="px-2 py-1 text-2xs text-text-muted hover:text-text-secondary transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setReplyOpen(true)}
              className="text-2xs text-accent-blue hover:underline opacity-70 hover:opacity-100 transition-opacity"
              title="Reply — continues the thread, agent will see it as a follow-up"
              aria-label="Reply in this thread"
            >
              ↳ Reply
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  location,
  reply,
  unread,
}: {
  comment: Comment;
  location: string;
  reply?: boolean;
  unread?: boolean;
}) {
  const isAgent = comment.author === "agent";
  const isQuestion = (comment as any).intent === "question";
  const authorLabel = isAgent ? "Agent" : "You";
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
        {unread && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-accent-blue shrink-0"
            aria-label="new since last open"
            title="new since you last opened the rail"
          />
        )}
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

function FilterPill({
  active,
  onClick,
  label,
  count,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  accent?: boolean;
}) {
  const accentColor = accent ? "text-accent-violet" : "text-accent-blue";
  const activeBg = accent ? "bg-accent-violet-dim" : "bg-accent-blue-dim/40";
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-0.5 rounded text-2xs transition-colors ${
        active
          ? `${activeBg} ${accentColor}`
          : "text-text-muted hover:text-text-secondary hover:bg-surface-hover"
      }`}
      aria-pressed={active}
    >
      <span>{label}</span>
      <span className={`text-[10px] ${active ? "opacity-90" : "opacity-60"}`}>{count}</span>
    </button>
  );
}
