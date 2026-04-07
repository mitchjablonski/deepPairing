import { useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";

interface CommentThreadProps {
  artifactId: string;
  comments: Comment[];
  target?: { lineNumber?: number; findingIndex?: number; stepIndex?: number };
}

function Avatar({ author }: { author: string }) {
  const isHuman = author === "human";
  return (
    <div
      className={`w-5 h-5 rounded-full flex items-center justify-center text-2xs font-bold shrink-0 ${
        isHuman
          ? "bg-accent-blue text-white"
          : "bg-accent-violet-dim text-accent-violet"
      }`}
    >
      {isHuman ? "Y" : "A"}
    </div>
  );
}

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function CommentBubble({ comment }: { comment: Comment }) {
  const isHuman = comment.author === "human";
  const refs = (comment as any).codeReferences as Array<{
    filePath: string;
    lineStart: number;
    lineEnd: number;
    snippet?: string;
  }> | undefined;

  return (
    <div className="flex gap-2">
      <Avatar author={comment.author} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={`text-xs font-semibold ${isHuman ? "text-accent-blue" : "text-text-muted"}`}>
            {isHuman ? "You" : "Agent"}
          </span>
          {comment.target.filePath && comment.target.lineStart && (
            <span className="font-mono text-2xs text-accent-blue/60">
              {comment.target.filePath}:{comment.target.lineStart}
              {comment.target.lineEnd && comment.target.lineEnd !== comment.target.lineStart
                ? `-${comment.target.lineEnd}` : ""}
            </span>
          )}
          <span className="text-2xs text-text-muted ml-auto">{formatTime(comment.createdAt)}</span>
          {!isHuman && comment.acknowledged && (
            <span className="text-text-muted text-2xs" title="Acknowledged">✓</span>
          )}
        </div>
        <p className="text-xs text-text-primary whitespace-pre-wrap">{comment.content}</p>

        {/* Code reference blocks */}
        {refs && refs.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {refs.map((ref, i) => (
              <div key={i} className="bg-surface-code rounded p-1.5 font-mono text-2xs">
                <div className="text-text-muted mb-0.5">
                  {ref.filePath}:{ref.lineStart}-{ref.lineEnd}
                </div>
                {ref.snippet && (
                  <pre className="whitespace-pre overflow-x-auto text-text-secondary">{ref.snippet}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CommentThread({ artifactId, comments, target }: CommentThreadProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { submitComment } = useArtifactStore();
  

  const handleSubmit = async () => {
    if (!input.trim() || submitting) return;
    setSubmitting(true);
    await submitComment(artifactId, input.trim(), target);
    setInput("");
    setSubmitting(false);
  };

  const rootComments = comments.filter((c) => !c.parentCommentId);

  return (
    <div className="space-y-3">
      {rootComments.map((comment) => (
        <CommentBubble key={comment.id} comment={comment} />
      ))}

      <div className="flex gap-1.5">
        <input
          type="text"
          placeholder="Add a comment..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={submitting}
          className="flex-1 px-2.5 py-1.5 bg-surface-secondary border border-border-default rounded text-xs text-text-primary
                     placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue
                     disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim() || submitting}
          className="px-2.5 py-1.5 bg-accent-blue text-white text-xs rounded
                     hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-text-muted
                     transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/** Inline comment trigger — click to start a comment on a specific location */
export function CommentTrigger({
  artifactId,
  target,
  existingCount,
}: {
  artifactId: string;
  target: { lineNumber?: number; findingIndex?: number; evidenceIndex?: number; stepIndex?: number };
  existingCount: number;
}) {
  const [open, setOpen] = useState(false);
  const allComments = useArtifactStore((s) => s.comments[artifactId]) ?? [];
  const comments = allComments.filter((c) => {
    if (target.lineNumber != null) return c.target.lineNumber === target.lineNumber;
    if (target.evidenceIndex != null) {
      return c.target.findingIndex === target.findingIndex && c.target.evidenceIndex === target.evidenceIndex;
    }
    if (target.findingIndex != null) return c.target.findingIndex === target.findingIndex;
    if (target.stepIndex != null) return c.target.stepIndex === target.stepIndex;
    return false;
  });

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
          existingCount > 0
            ? "bg-accent-blue-dim text-accent-blue hover:bg-accent-blue-dim/80"
            : "bg-surface-elevated text-text-muted hover:bg-surface-hover hover:text-text-secondary"
        }`}
      >
        <span className="text-[10px]">💬</span>
        {existingCount > 0 && <span>{existingCount}</span>}
      </button>

      {open && (
        <div className="mt-1 p-2.5 bg-surface-elevated border border-border-default rounded-lg shadow-lg max-w-sm">
          <CommentThread
            artifactId={artifactId}
            comments={comments}
            target={target}
          />
        </div>
      )}
    </div>
  );
}
