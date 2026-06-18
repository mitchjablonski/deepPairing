import type { PlanVisual } from "@deeppairing/shared";
import { MermaidDiagram } from "./MermaidDiagram";
import { CommentTrigger, AskTrigger } from "./CommentThread";
import { useArtifactStore } from "../stores/artifact";

const kindLabel: Record<string, string> = {
  diagram: "Diagram",
  file_map: "File map",
  prototype: "Prototype",
};

const changeStyle: Record<string, { glyph: string; cls: string }> = {
  create: { glyph: "+", cls: "text-accent-green" },
  modify: { glyph: "~", cls: "text-accent-amber" },
  delete: { glyph: "−", cls: "text-accent-red" },
};

/**
 * The visuals section of a plan — diagrams / file maps / prototypes that frame
 * the explicit steps so planning isn't a wall of prose. Each visual is a
 * first-class, COMMENTABLE block (comments anchor to `visualId`), so the human
 * comments on the architecture itself and the agent iterates via revise_artifact
 * — reusing the whole existing review loop.
 */
export function PlanVisuals({ artifactId, visuals }: { artifactId: string; visuals: PlanVisual[] }) {
  const comments = useArtifactStore((s) => s.comments[artifactId]) ?? [];
  if (!visuals || visuals.length === 0) return null;

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
        Visuals ({visuals.length})
      </h4>
      {visuals.map((v) => {
        const existing = comments.filter((c) => (c.target as { visualId?: string }).visualId === v.id).length;
        return (
          <div
            key={v.id}
            // Landing target for `dp:focus-artifact` events carrying a visual anchor.
            data-comment-anchor={`visual:${v.id}`}
            className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-surface-elevated text-text-muted">
                  {kindLabel[v.kind] ?? v.kind}
                </span>
                {v.title && (
                  <span className="text-sm font-semibold text-text-primary truncate">{v.title}</span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <AskTrigger artifactId={artifactId} target={{ visualId: v.id }} />
                <CommentTrigger artifactId={artifactId} target={{ visualId: v.id }} existingCount={existing} />
              </div>
            </div>

            <VisualBody visual={v} />

            {v.caption && <div className="text-2xs text-text-secondary leading-relaxed">{v.caption}</div>}
          </div>
        );
      })}
    </div>
  );
}

function VisualBody({ visual }: { visual: PlanVisual }) {
  if (visual.kind === "diagram") {
    return visual.source?.trim() ? (
      <MermaidDiagram source={visual.source} />
    ) : (
      <div className="text-2xs text-text-muted">No diagram source provided.</div>
    );
  }

  if (visual.kind === "file_map") {
    const files = visual.files ?? [];
    if (files.length === 0) return <div className="text-2xs text-text-muted">No files listed.</div>;
    return (
      <ul className="space-y-0.5 font-mono text-2xs">
        {files.map((f, i) => {
          const s = changeStyle[f.change ?? "modify"];
          return (
            <li key={i} className="flex items-baseline gap-2">
              <span className={`shrink-0 w-3 text-center font-bold ${s.cls}`}>{s.glyph}</span>
              <span className="text-text-primary break-all">{f.path}</span>
              {f.note && <span className="text-text-muted italic">— {f.note}</span>}
            </li>
          );
        })}
      </ul>
    );
  }

  // prototype — the sandboxed iframe renderer lands in a dedicated PR (its
  // security model deserves its own review). Until then, degrade clearly.
  return (
    <div className="text-2xs text-text-muted italic rounded border border-dashed border-border-default p-3 text-center">
      Interactive prototype — sandboxed rendering ships in an upcoming update.
    </div>
  );
}
