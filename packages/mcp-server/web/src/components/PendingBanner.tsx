import { useArtifactStore } from "../stores/artifact";

export function PendingBanner() {
  const { artifacts, selectArtifact } = useArtifactStore();

  const pending = artifacts.filter(
    (a) => (a.type === "decision" || a.type === "plan") && a.status === "draft",
  );

  if (pending.length === 0) return null;

  return (
    <div className="px-3 py-1.5 bg-accent-amber-dim/50 border-b border-accent-amber/15 flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse shrink-0" />
      <span className="text-2xs text-accent-amber font-medium">
        {pending.length} item{pending.length > 1 ? "s" : ""} waiting for your review
      </span>
      <div className="flex gap-1 ml-auto">
        {pending.slice(0, 3).map((a) => (
          <button
            key={a.id}
            onClick={() => selectArtifact(a.id)}
            className="px-2 py-0.5 bg-accent-amber-dim text-accent-amber rounded text-2xs
                       hover:bg-accent-amber-dim/80 transition-colors"
          >
            {a.title.slice(0, 30)}{a.title.length > 30 ? "..." : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
