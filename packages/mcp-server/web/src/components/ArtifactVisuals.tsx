import type { PlanVisual, PlanVisualFile } from "@deeppairing/shared";
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
 * The visuals section shared by plan and spec artifacts — diagrams / file maps
 * / prototypes the human can comment on directly so planning isn't a wall of
 * prose. Each visual is a first-class COMMENTABLE block (comments anchor to
 * `visualId`), so the human comments on the architecture itself and the agent
 * iterates via revise_artifact — reusing the whole existing review loop.
 */
export function ArtifactVisuals({ artifactId, visuals }: { artifactId: string; visuals: PlanVisual[] }) {
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
    return <FileMap files={visual.files ?? []} />;
  }

  // prototype — the sandboxed iframe renderer lands in a dedicated PR (its
  // security model deserves its own review). Until then, degrade clearly.
  return (
    <div className="text-2xs text-text-muted italic rounded border border-dashed border-border-default p-3 text-center">
      Interactive prototype — sandboxed rendering ships in an upcoming update.
    </div>
  );
}

// --- file_map: a directory tree of planned operations ------------------------

interface TreeNode {
  name: string;
  file?: PlanVisualFile; // present on a leaf that corresponds to a file op
  children: Map<string, TreeNode>;
}

function buildTree(files: PlanVisualFile[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const f of files) {
    const parts = (f.path ?? "").split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.file = f;
      node = child;
    });
  }
  return root;
}

function FileMap({ files }: { files: PlanVisualFile[] }) {
  if (files.length === 0) return <div className="text-2xs text-text-muted">No files listed.</div>;

  const counts = files.reduce(
    (acc, f) => {
      acc[f.change ?? "modify"]++;
      return acc;
    },
    { create: 0, modify: 0, delete: 0 } as Record<string, number>,
  );
  const tree = buildTree(files);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 text-[10px] text-text-muted">
        {counts.create > 0 && <span className="text-accent-green">+{counts.create} new</span>}
        {counts.modify > 0 && <span className="text-accent-amber">~{counts.modify} changed</span>}
        {counts.delete > 0 && <span className="text-accent-red">−{counts.delete} removed</span>}
      </div>
      <ul className="font-mono text-2xs">
        {[...tree.children.values()].map((child) => (
          <TreeRow key={child.name} node={child} depth={0} />
        ))}
      </ul>
    </div>
  );
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const isDir = node.children.size > 0 && !node.file;
  const s = node.file ? changeStyle[node.file.change ?? "modify"] : null;
  return (
    <>
      <li className="flex items-baseline gap-1.5 py-0.5" style={{ paddingLeft: `${depth * 12}px` }}>
        {isDir ? (
          <span className="text-text-muted">{node.name}/</span>
        ) : (
          <>
            <span className={`shrink-0 w-3 text-center font-bold ${s?.cls ?? "text-text-muted"}`}>
              {s?.glyph ?? "·"}
            </span>
            <span className="text-text-primary break-all">{node.name}</span>
            {node.file?.note && <span className="text-text-muted italic">— {node.file.note}</span>}
          </>
        )}
      </li>
      {[...node.children.values()].map((child) => (
        <TreeRow key={child.name} node={child} depth={depth + 1} />
      ))}
    </>
  );
}
