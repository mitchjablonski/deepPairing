import { useArtifactStore } from "../stores/artifact";
import { computePending } from "../lib/pending";

/**
 * The "waiting for your review" banner. Now driven by the shared computePending
 * selector (lib/pending) so it counts the SAME set as the TurnIndicator and the
 * cross-project badge — drafts of any reviewable type plus unanswered/un-resolved
 * questions — instead of its old narrow decision|plan-only filter.
 *
 * Every counted draft also gets a quick "Dismiss" here (marks it obsolete), so
 * an abandoned draft can be cleared from the banner without opening the artifact
 * and hunting for the tertiary dismiss link — a "waiting" signal you can't clear
 * is just a nag.
 */
export function PendingBanner() {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const comments = useArtifactStore((s) => s.comments);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);

  const { drafts, questions, total } = computePending(artifacts, comments);
  if (total === 0) return null;

  return (
    <div className="px-3 py-1.5 bg-accent-amber-dim/50 border-b border-accent-amber/15 flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse shrink-0" />
      <span className="text-2xs text-accent-amber font-medium shrink-0">
        {total} item{total > 1 ? "s" : ""} waiting for you
      </span>
      <div className="flex gap-1 ml-auto items-center min-w-0 overflow-x-auto">
        {drafts.slice(0, 3).map((a) => (
          <span key={a.id} className="flex items-center bg-accent-amber-dim rounded shrink-0">
            <button
              onClick={() => selectArtifact(a.id)}
              className="px-2 py-0.5 text-accent-amber rounded-l text-2xs hover:bg-accent-amber-dim/80 transition-colors"
              title={a.title}
            >
              {a.title.slice(0, 28)}{a.title.length > 28 ? "…" : ""}
            </button>
            {/* Quick dismiss — clears an abandoned/moot draft without opening it. */}
            <button
              onClick={() => void updateArtifactStatus(a.id, "obsolete")}
              className="px-1.5 py-0.5 text-accent-amber/70 hover:text-accent-amber hover:bg-accent-amber-dim/80 rounded-r text-2xs border-l border-accent-amber/20"
              title="Dismiss — overcome by new information"
              aria-label={`Dismiss ${a.title}`}
            >
              ✕
            </button>
          </span>
        ))}
        {questions.slice(0, 2).map(({ artifactId, comment }) => (
          <button
            key={comment.id}
            onClick={() => selectArtifact(artifactId)}
            className="px-2 py-0.5 bg-accent-violet-dim text-accent-violet rounded text-2xs shrink-0 hover:bg-accent-violet-dim/80 transition-colors"
            title={comment.content}
          >
            ❓ {comment.content.slice(0, 24)}{comment.content.length > 24 ? "…" : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
