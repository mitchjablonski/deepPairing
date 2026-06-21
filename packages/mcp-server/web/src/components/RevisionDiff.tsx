import { useState } from "react";
import type { Artifact, PlanVisual, PlanVisualFile } from "@deeppairing/shared";
import { coercePlanContent, coerceSpecContent } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { VisualBody } from "./ArtifactVisuals";

/**
 * Revision diff — closes the "interact more" loop. When an artifact is revised
 * (revise_artifact mode='supersede'), the new version links to its predecessor
 * via parentId; the old one stays in the store as 'superseded'. Pre-this, the
 * UI just hid the old version and showed the new one, so the human had to
 * eyeball "did my comment actually change this?" against memory. This surfaces
 * the delta directly, anchored to the reason the agent gave for revising.
 *
 * Visuals are diffed per the agreed split (see the conversation): a true
 * semantic diff where the content is structured (file_map), and a side-by-side
 * before→after where it's a render (diagram / annotated_code / prototype).
 */

const kindLabel: Record<string, string> = {
  diagram: "Diagram",
  file_map: "File map",
  prototype: "Prototype",
  annotated_code: "Annotated code",
};

function visualsOf(a: Artifact): PlanVisual[] {
  if (a.type === "plan") return coercePlanContent(a.content).visuals ?? [];
  if (a.type === "spec") return coerceSpecContent(a.content).visuals ?? [];
  return [];
}

/** Did a matched visual's payload actually change? (Compares the field that
 *  matters for its kind; file_map is handled separately via a real diff.) */
function visualChanged(a: PlanVisual, b: PlanVisual): boolean {
  if (a.kind !== b.kind) return true;
  if (a.kind === "diagram") return a.source !== b.source;
  if (a.kind === "prototype") return a.html !== b.html;
  if (a.kind === "annotated_code") {
    return a.code !== b.code || JSON.stringify(a.annotations ?? []) !== JSON.stringify(b.annotations ?? []);
  }
  return false;
}

export function RevisionDiff({ artifact }: { artifact: Artifact }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  // Default open — "what changed" is the whole point of landing on a revision;
  // hiding it behind a collapsed toggle is exactly how the affordance gets
  // missed. The human can collapse it once they've absorbed the delta.
  const [open, setOpen] = useState(true);

  // A revision links to its predecessor via parentId. No parent in the store
  // (a first version, or the parent isn't loaded) → nothing to diff.
  const parent = artifact.parentId ? artifacts.find((a) => a.id === artifact.parentId) : undefined;
  if (!parent) return null;

  return (
    <div className="rounded-lg border border-accent-amber/25 bg-accent-amber-dim/10">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-accent-amber hover:bg-accent-amber-dim/15 rounded-lg transition-colors"
      >
        <span>↻</span>
        <span>What changed since v{parent.version}</span>
        <span className="ml-auto text-text-muted">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {artifact.agentReasoning && (
            <div className="text-2xs text-text-secondary">
              <span className="font-semibold text-accent-amber">Revised:</span> {artifact.agentReasoning}
            </div>
          )}
          <VisualsDiff oldVisuals={visualsOf(parent)} newVisuals={visualsOf(artifact)} artifactId={artifact.id} />
        </div>
      )}
    </div>
  );
}

function VisualsDiff({
  oldVisuals,
  newVisuals,
  artifactId,
}: {
  oldVisuals: PlanVisual[];
  newVisuals: PlanVisual[];
  artifactId: string;
}) {
  const oldById = new Map(oldVisuals.map((v) => [v.id, v]));
  const newById = new Map(newVisuals.map((v) => [v.id, v]));
  const ids = [...new Set([...oldById.keys(), ...newById.keys()])];
  if (ids.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide">Visuals</div>
      {ids.map((id) => {
        const o = oldById.get(id);
        const n = newById.get(id);
        if (!o && n) return <VisualRow key={id} tag="added" visual={n} artifactId={artifactId} />;
        if (o && !n) return <VisualRow key={id} tag="removed" visual={o} artifactId={artifactId} />;
        return <ChangedVisual key={id} old={o!} next={n!} artifactId={artifactId} />;
      })}
    </div>
  );
}

const tagStyle: Record<string, { glyph: string; cls: string; word: string }> = {
  added: { glyph: "＋", cls: "text-accent-green", word: "added" },
  removed: { glyph: "−", cls: "text-accent-red", word: "removed" },
};

function VisualRow({ tag, visual, artifactId }: { tag: "added" | "removed"; visual: PlanVisual; artifactId: string }) {
  const s = tagStyle[tag];
  return (
    <div className="rounded border border-white/[0.06] p-2 space-y-1">
      <div className="flex items-center gap-1.5 text-2xs">
        <span className={`font-bold ${s.cls}`}>{s.glyph}</span>
        <span className={s.cls}>{s.word}</span>
        <span className="text-text-muted">·</span>
        <span className="text-text-secondary">{kindLabel[visual.kind] ?? visual.kind}</span>
        {visual.title && <span className="text-text-primary font-medium truncate">{visual.title}</span>}
      </div>
      {/* Show the body of a removed-or-added visual so the change is concrete. */}
      <div className={tag === "removed" ? "opacity-60" : ""}>
        <VisualBody artifactId={artifactId} visual={visual} />
      </div>
    </div>
  );
}

function ChangedVisual({ old, next, artifactId }: { old: PlanVisual; next: PlanVisual; artifactId: string }) {
  const label = kindLabel[next.kind] ?? next.kind;

  // file_map — a real semantic diff (structured content).
  if (next.kind === "file_map" && old.kind === "file_map") {
    return <FileMapDiff title={next.title ?? label} oldFiles={old.files ?? []} newFiles={next.files ?? []} />;
  }

  // Otherwise, render side-by-side before→after — but only if it actually changed.
  if (!visualChanged(old, next)) {
    return (
      <div className="flex items-center gap-1.5 text-2xs text-text-muted px-2 py-1">
        <span>·</span>
        <span>{label}{next.title ? ` · ${next.title}` : ""}</span>
        <span className="italic">unchanged</span>
      </div>
    );
  }

  return (
    <div className="rounded border border-accent-amber/20 p-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-2xs">
        <span className="text-accent-amber font-bold">~</span>
        <span className="text-accent-amber">changed</span>
        <span className="text-text-muted">·</span>
        <span className="text-text-secondary">{label}</span>
        {next.title && <span className="text-text-primary font-medium truncate">{next.title}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className="text-[9px] uppercase tracking-wide text-text-muted">Before</div>
          <div className="opacity-70"><VisualBody artifactId={artifactId} visual={old} /></div>
        </div>
        <div className="space-y-1">
          <div className="text-[9px] uppercase tracking-wide text-accent-amber">After</div>
          <VisualBody artifactId={artifactId} visual={next} />
        </div>
      </div>
    </div>
  );
}

// --- file_map: semantic diff (added / removed / changed paths) ----------------

function fileKey(f: PlanVisualFile): string {
  return String(f?.path ?? "");
}

function FileMapDiff({ title, oldFiles, newFiles }: { title: string; oldFiles: PlanVisualFile[]; newFiles: PlanVisualFile[] }) {
  const oldByPath = new Map(oldFiles.map((f) => [fileKey(f), f]));
  const newByPath = new Map(newFiles.map((f) => [fileKey(f), f]));
  const added = newFiles.filter((f) => !oldByPath.has(fileKey(f)));
  const removed = oldFiles.filter((f) => !newByPath.has(fileKey(f)));
  const changed = newFiles
    .map((f) => ({ to: f, from: oldByPath.get(fileKey(f)) }))
    .filter((p): p is { to: PlanVisualFile; from: PlanVisualFile } => !!p.from && (p.from.change !== p.to.change || p.from.note !== p.to.note));

  const unchanged = added.length === 0 && removed.length === 0 && changed.length === 0;

  return (
    <div className="rounded border border-accent-amber/20 p-2 space-y-1">
      <div className="flex items-center gap-1.5 text-2xs">
        <span className="text-accent-amber font-bold">~</span>
        <span className="text-text-secondary">File map</span>
        <span className="text-text-primary font-medium truncate">{title}</span>
      </div>
      {unchanged ? (
        <div className="text-2xs text-text-muted italic pl-3">no file changes</div>
      ) : (
        <ul className="font-mono text-2xs space-y-0.5 pl-1">
          {added.map((f) => (
            <li key={`a-${f.path}`} className="flex items-baseline gap-1.5">
              <span className="text-accent-green font-bold w-3">＋</span>
              <span className="text-text-primary break-all">{f.path}</span>
              {f.change && <span className="text-text-muted">({f.change})</span>}
            </li>
          ))}
          {changed.map(({ from, to }) => (
            <li key={`c-${to.path}`} className="flex items-baseline gap-1.5">
              <span className="text-accent-amber font-bold w-3">~</span>
              <span className="text-text-primary break-all">{to.path}</span>
              <span className="text-text-muted">
                ({from.change ?? "modify"}→{to.change ?? "modify"})
              </span>
            </li>
          ))}
          {removed.map((f) => (
            <li key={`r-${f.path}`} className="flex items-baseline gap-1.5">
              <span className="text-accent-red font-bold w-3">−</span>
              <span className="text-text-secondary break-all line-through opacity-70">{f.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
