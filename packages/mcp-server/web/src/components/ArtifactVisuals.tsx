import type { Comment, PlanVisual, PlanVisualFile, PlanVisualAnnotation } from "@deeppairing/shared";
import { MermaidDiagram } from "./MermaidDiagram";
import { PrototypeFrame } from "./PrototypeFrame";
import { CommentableCode } from "./CommentableCode";
import { CommentTrigger, AskTrigger } from "./CommentThread";
import { useArtifactStore } from "../stores/artifact";

const kindLabel: Record<string, string> = {
  diagram: "Diagram",
  file_map: "File map",
  prototype: "Prototype",
  annotated_code: "Annotated code",
};

/** Lowercase noun for the comment call-to-action ("Comment on this diagram"). */
const kindNoun: Record<string, string> = {
  diagram: "diagram",
  file_map: "file map",
  prototype: "prototype",
  annotated_code: "code",
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
        const noun = kindNoun[v.kind] ?? "visual";
        return (
          <div
            key={v.id}
            data-comment-anchor={`visual:${v.id}`}
            className="group bg-surface-secondary rounded-lg border border-white/[0.06] p-3 space-y-2 transition-colors hover:border-accent-blue/25"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-surface-elevated text-text-muted">
                {kindLabel[v.kind] ?? v.kind}
              </span>
              {v.title && (
                <span className="text-sm font-semibold text-text-primary truncate">{v.title}</span>
              )}
            </div>

            <VisualBody artifactId={artifactId} visual={v} />

            {v.caption && <div className="text-2xs text-text-secondary leading-relaxed">{v.caption}</div>}

            {/* Discoverable comment affordance. A bare top-right icon was too easy
                to miss on a tall diagram/prototype, so the primary call-to-action
                is a labelled bar at the BOTTOM — where the eye lands after reading
                the visual. Comments still anchor to this visual's id, so the
                whole existing comment → check_feedback → revise loop is reused. */}
            <div className="flex items-stretch gap-2 pt-2 border-t border-white/[0.05]">
              <CommentTrigger
                variant="pill"
                fullWidth
                label={`Comment on this ${noun}`}
                artifactId={artifactId}
                target={{ visualId: v.id }}
                existingCount={existing}
              />
              <AskTrigger variant="pill" fullWidth artifactId={artifactId} target={{ visualId: v.id }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function VisualBody({ artifactId, visual, readOnly = false }: { artifactId: string; visual: PlanVisual; readOnly?: boolean }) {
  // Defensive even though the coercer shapes visuals upstream: a renderer must
  // never throw on a malformed field (legacy/partial content) — degrade instead.
  if (visual.kind === "diagram") {
    return typeof visual.source === "string" && visual.source.trim() ? (
      <MermaidDiagram source={visual.source} />
    ) : (
      <div className="text-2xs text-text-muted">No diagram source provided.</div>
    );
  }

  if (visual.kind === "file_map") {
    return <FileMap files={Array.isArray(visual.files) ? visual.files : []} />;
  }

  if (visual.kind === "annotated_code") {
    return typeof visual.code === "string" && visual.code.length > 0 ? (
      <AnnotatedCode artifactId={artifactId} visual={visual} readOnly={readOnly} />
    ) : (
      <div className="text-2xs text-text-muted">No code provided.</div>
    );
  }

  // prototype — agent-authored HTML, run in a hardened sandbox (see PrototypeFrame).
  return <PrototypeFrame html={typeof visual.html === "string" ? visual.html : ""} readOnly={readOnly} />;
}

// --- annotated_code: real code + line-anchored agent notes, per-line commentable
function AnnotatedCode({ artifactId, visual, readOnly = false }: { artifactId: string; visual: PlanVisual; readOnly?: boolean }) {
  const allComments = useArtifactStore((s) => s.comments[artifactId]) ?? [];
  const filePath = typeof visual.filePath === "string" ? visual.filePath : undefined;
  const lineStart = typeof visual.lineStart === "number" && Number.isFinite(visual.lineStart) ? visual.lineStart : 1;

  // Existing human line-comments on THIS file, keyed by absolute line. Mirrors
  // the {lineStart,lineEnd,filePath} target shape LineComposer submits, and
  // scopes by filePath so two annotated_code visuals don't cross-show comments.
  // Skipped entirely in readOnly (revision-diff preview): the diff is about the
  // code+annotation delta, and showing the live artifact's comments on both the
  // Before AND After panes (keyed by line, not version) makes them identical.
  const commentsByLine = new Map<number, Comment[]>();
  for (const c of readOnly ? [] : allComments) {
    const t = c.target as { lineStart?: number; lineEnd?: number; filePath?: string; findingIndex?: number; stepIndex?: number; evidenceIndex?: number };
    if (t?.lineStart == null || t.findingIndex != null || t.stepIndex != null || t.evidenceIndex != null) continue;
    if (filePath != null && t.filePath !== filePath) continue;
    const start = Math.floor(Number(t.lineStart));
    if (!Number.isFinite(start)) continue;
    const end = t.lineEnd == null ? start : Math.floor(Number(t.lineEnd));
    const safeEnd = Math.min(Number.isFinite(end) ? Math.max(start, end) : start, start + 200);
    for (let line = start; line <= safeEnd; line++) {
      commentsByLine.set(line, [...(commentsByLine.get(line) ?? []), c]);
    }
  }

  // Agent annotations keyed by absolute line.
  const annotationsByLine = new Map<number, PlanVisualAnnotation[]>();
  for (const a of Array.isArray(visual.annotations) ? visual.annotations : []) {
    if (typeof a?.line !== "number" || !Number.isFinite(a.line)) continue;
    annotationsByLine.set(a.line, [...(annotationsByLine.get(a.line) ?? []), a]);
  }

  return (
    <CommentableCode
      code={visual.code ?? ""}
      filePath={filePath}
      language={typeof visual.language === "string" ? visual.language : undefined}
      lineStart={lineStart}
      artifactId={artifactId}
      commentsByLine={commentsByLine}
      annotationsByLine={annotationsByLine}
      targetContext={{ visualId: visual.id }}
      readOnly={readOnly}
    />
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
    const parts = String(f?.path ?? "").split("/").filter(Boolean);
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
