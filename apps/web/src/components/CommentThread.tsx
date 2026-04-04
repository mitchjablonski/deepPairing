import { useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useSessionStore } from "../stores/session";

interface CommentThreadProps {
  artifactId: string;
  comments: Comment[];
  target?: { lineNumber?: number; findingIndex?: number; stepIndex?: number };
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
    <div className={`flex gap-2 ${isHuman ? "" : "flex-row-reverse"}`}>
      <div
        className={`px-3 py-2 rounded-lg text-xs max-w-[85%] ${
          isHuman
            ? "bg-blue-50 text-gray-800 rounded-bl-none"
            : "bg-gray-100 text-gray-700 rounded-br-none"
        }`}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={`font-semibold ${isHuman ? "text-blue-700" : "text-gray-500"}`}>
            {isHuman ? "You" : "Agent"}
          </span>
          {comment.target.filePath && comment.target.lineStart && (
            <span className="font-mono text-[10px] text-blue-500">
              {comment.target.filePath}:{comment.target.lineStart}
              {comment.target.lineEnd && comment.target.lineEnd !== comment.target.lineStart
                ? `-${comment.target.lineEnd}` : ""}
            </span>
          )}
          {!isHuman && comment.acknowledged && (
            <span className="text-gray-300" title="Acknowledged">&#10003;</span>
          )}
        </div>
        <p className="whitespace-pre-wrap">{comment.content}</p>

        {/* Code reference blocks */}
        {refs && refs.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {refs.map((ref, i) => (
              <div key={i} className="bg-gray-800 text-gray-200 rounded p-1.5 font-mono text-[11px]">
                <div className="text-gray-400 text-[10px] mb-0.5">
                  {ref.filePath}:{ref.lineStart}-{ref.lineEnd}
                </div>
                {ref.snippet && (
                  <pre className="whitespace-pre overflow-x-auto">{ref.snippet}</pre>
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
  const sessionId = useSessionStore((s) => s.sessionId);

  const handleSubmit = async () => {
    if (!input.trim() || !sessionId || submitting) return;
    setSubmitting(true);
    await submitComment(sessionId, artifactId, input.trim(), target);
    setInput("");
    setSubmitting(false);
  };

  // Build thread tree (flat for now, threaded replies later)
  const rootComments = comments.filter((c) => !c.parentCommentId);

  return (
    <div className="space-y-2">
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
          className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded text-xs
                     focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-transparent
                     disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim() || submitting}
          className="px-2.5 py-1.5 bg-blue-600 text-white text-xs rounded
                     hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed
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
            ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
            : "bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
        }`}
      >
        <span className="text-[10px]">💬</span>
        {existingCount > 0 && <span>{existingCount}</span>}
      </button>

      {open && (
        <div className="mt-1 p-2 bg-white border border-gray-200 rounded-lg shadow-sm max-w-sm">
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
