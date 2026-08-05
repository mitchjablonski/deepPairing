import type { Comment } from "@deeppairing/shared";
import { partitionSuggestions } from "./CommentableCode";
import { SuggestionCard } from "./SuggestionCard";
import { LineCommentChips } from "./LineComments";

/**
 * F2 (#202) — the ONE diff-row feedback wrapper, extracted from the
 * near-identical `LineFeedback` (CodeChangeArtifact) and `ChangesetLineFeedback`
 * (ChangesetArtifact) wrappers. It splits a line's comments into suggested-edit
 * CARDS (SuggestionCard, with their agent/human replies pulled in — rendered
 * ALWAYS, even while the composer is open) vs plain comment chips (hidden when
 * `hideChips`, i.e. that line's composer is open).
 *
 * The two former copies diverged only in the `side` passed to LineCommentChips
 * (the changeset's del-side (#186) bucketing) — parameterized here as an
 * optional prop; code_change omits it and the chips read "new" exactly as
 * before. Byte-equivalent to both originals.
 */
export function SuggestionLineFeedback({
  lineComments,
  lineNum,
  artifactId,
  filePath,
  hideChips,
  onOpenLine,
  side,
}: {
  lineComments: Comment[];
  lineNum: number;
  artifactId: string;
  filePath?: string;
  hideChips: boolean;
  onOpenLine: () => void;
  /** Changeset only: the side-qualified anchor so a removed line keeps its own
   *  bucket (#186). Omitted on the code_change surface (reads "new"). */
  side?: "old" | "new";
}) {
  const { suggestions, repliesBySuggestion, chips } = partitionSuggestions(lineComments);
  return (
    <>
      {suggestions.length > 0 && (
        <div className="ml-[5.5rem] mr-3 my-1.5 space-y-2">
          {suggestions.map((sc) => (
            <SuggestionCard key={sc.id} comment={sc} replies={repliesBySuggestion[sc.id] ?? []} filePath={filePath} />
          ))}
        </div>
      )}
      {chips.length > 0 && !hideChips && (
        <div className="ml-[5.5rem] mr-3 my-1">
          <LineCommentChips
            lineNum={lineNum}
            comments={chips}
            artifactId={artifactId}
            filePath={filePath}
            side={side}
            onOpenLine={onOpenLine}
          />
        </div>
      )}
    </>
  );
}
