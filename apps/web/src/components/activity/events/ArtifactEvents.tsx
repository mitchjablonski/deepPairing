import type { AgentEvent } from "@deeppairing/shared";
import { useArtifactStore } from "../../../stores/artifact";
import { ArtifactIcon } from "../../icons/ArtifactIcons";

export function ArtifactCreatedEvent({ event }: { event: AgentEvent & { type: "artifact_created" } }) {
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);

  return (
    <button
      onClick={() => selectArtifact(event.artifact.id)}
      className="mx-3 my-2 w-[calc(100%-1.5rem)] text-left p-3 bg-accent-blue-dim/40 border border-accent-blue/15 rounded-lg hover:bg-accent-blue-dim/60 transition-colors"
    >
      <div className="flex items-center gap-2">
        <ArtifactIcon type={event.artifact.type} className="w-4 h-4 text-accent-blue" />
        <span className="text-sm font-medium text-text-primary">{event.artifact.title}</span>
        <span className="ml-auto px-1.5 py-0.5 text-2xs font-medium bg-accent-blue-dim text-accent-blue rounded">
          {event.artifact.status}
        </span>
      </div>
      <p className="text-xs text-text-muted mt-1 ml-7">Click to view in artifact panel →</p>
    </button>
  );
}

export function ArtifactUpdatedEvent({ event }: { event: AgentEvent & { type: "artifact_updated" } }) {
  return (
    <div className="mx-3 my-1 px-3 py-1.5 bg-accent-blue-dim/30 border-l-2 border-accent-blue rounded-r text-xs">
      <span className="font-semibold text-accent-blue">Artifact updated</span>{" "}
      <span className="text-text-muted">→ {event.status}</span>
    </div>
  );
}

export function CommentAddedEvent({ event }: { event: AgentEvent & { type: "comment_added" } }) {
  return (
    <div className="mx-3 my-1 px-3 py-1.5 bg-accent-blue-dim/20 border-l-2 border-accent-blue/50 rounded-r text-xs">
      <span className="font-medium text-accent-blue">
        {event.comment.author === "human" ? "You" : "Agent"}
      </span>{" "}
      <span className="text-text-muted">
        commented: {event.comment.content.slice(0, 80)}{event.comment.content.length > 80 ? "..." : ""}
      </span>
    </div>
  );
}
