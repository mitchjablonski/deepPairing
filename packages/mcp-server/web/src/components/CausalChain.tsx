import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { ArtifactIcon } from "./icons/ArtifactIcons";

const typeOrder = ["research", "decision", "plan", "code_change", "reasoning"];

/**
 * Horizontal breadcrumb flow showing the causal chain of artifacts.
 * Finding → Decision → Plan → Code Change
 * Each node is clickable to navigate to that artifact.
 */
export function CausalChain() {
  const { artifacts, selectedArtifactId, selectArtifact } = useArtifactStore();

  const visible = artifacts.filter((a) => a.status !== "superseded");
  if (visible.length <= 1) return null;

  // Build the chain: use relatedArtifactIds if available, otherwise chronological by type
  const chain = buildChain(visible, selectedArtifactId);
  if (chain.length <= 1) return null;

  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-border-subtle overflow-x-auto">
      {chain.map((node, i) => (
        <div key={node.id} className="flex items-center gap-0.5 shrink-0">
          {i > 0 && (
            <span className="text-text-muted text-[10px] mx-0.5">→</span>
          )}
          <button
            onClick={() => selectArtifact(node.id)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs transition-colors ${
              node.id === selectedArtifactId
                ? "bg-accent-blue-dim text-accent-blue font-medium"
                : "text-text-muted hover:text-text-secondary hover:bg-surface-hover"
            }`}
            title={node.title}
          >
            <ArtifactIcon type={node.type} className="w-3 h-3" />
            <span className="max-w-24 truncate">{node.shortTitle}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

interface ChainNode {
  id: string;
  type: string;
  title: string;
  shortTitle: string;
}

function buildChain(artifacts: Artifact[], selectedId: string | null): ChainNode[] {
  // If the selected artifact has relatedArtifactIds, build chain from those
  const selected = artifacts.find((a) => a.id === selectedId);
  if (selected?.relatedArtifactIds && selected.relatedArtifactIds.length > 0) {
    const related = selected.relatedArtifactIds
      .map((id) => artifacts.find((a) => a.id === id))
      .filter(Boolean) as Artifact[];

    const chain = [...related, selected];
    // Sort by type order
    chain.sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type));

    return chain.map(toNode);
  }

  // Fallback: deduplicate by type, take the first of each type in chronological order
  const byType = new Map<string, Artifact>();
  const sorted = [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const art of sorted) {
    if (!byType.has(art.type)) {
      byType.set(art.type, art);
    }
  }

  // Order by type hierarchy
  const chain: Artifact[] = [];
  for (const type of typeOrder) {
    const art = byType.get(type);
    if (art) chain.push(art);
  }

  return chain.map(toNode);
}

function toNode(a: Artifact): ChainNode {
  // Shorten title for the breadcrumb
  const words = a.title.split(" ");
  const shortTitle = words.length > 4
    ? words.slice(0, 3).join(" ") + "..."
    : a.title;

  return {
    id: a.id,
    type: a.type,
    title: a.title,
    shortTitle,
  };
}
