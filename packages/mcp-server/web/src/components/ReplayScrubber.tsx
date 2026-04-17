import { useEffect, useMemo, useState } from "react";
import { useReplayStore, useAnnotationsByEvent } from "../stores/replay";
import type { TimelineEvent } from "../lib/timeline";

const kindIcon: Record<string, string> = {
  artifact_created: "➕",
  artifact_status_changed: "🔄",
  comment_added: "💬",
  decision_resolved: "⚖️",
  plan_reviewed: "📋",
};

const kindLabel: Record<string, string> = {
  artifact_created: "Created",
  artifact_status_changed: "Status",
  comment_added: "Comment",
  decision_resolved: "Decision",
  plan_reviewed: "Plan",
};

/**
 * Horizontal scrubber above the artifact panel while the user is in replay
 * mode. Shows every timeline event as a marker; arrow keys / buttons step
 * the cursor; Space plays at 1x/4x/16x.
 *
 * The scrubber is the replay surface's "chess clock" — clear what moment
 * we're viewing, easy to step back and reconsider.
 */
export function ReplayScrubber() {
  const {
    active, events, cursor, playing, speed,
    exitReplay, setCursor, stepForward, stepBackward,
    play, pause, setSpeed,
  } = useReplayStore();
  const annotationsByEventId = useAnnotationsByEvent();
  const [hoverEvent, setHoverEvent] = useState<TimelineEvent | null>(null);
  const [annotatingEvent, setAnnotatingEvent] = useState<string | null>(null);

  // Keyboard: ArrowLeft/Right step, Space play/pause, Esc exit.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === "]") { e.preventDefault(); stepForward(); }
      else if (e.key === "ArrowLeft" || e.key === "[") { e.preventDefault(); stepBackward(); }
      else if (e.key === " ") { e.preventDefault(); playing ? pause() : play(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [active, playing, stepForward, stepBackward, play, pause]);

  const { minT, maxT, span } = useMemo(() => {
    if (events.length === 0) return { minT: 0, maxT: 0, span: 1 };
    const first = new Date(events[0].at).getTime();
    const last = new Date(events[events.length - 1].at).getTime();
    return { minT: first, maxT: last, span: Math.max(1, last - first) };
  }, [events]);

  const cursorIdx = events.findIndex((e) => e.at === cursor);
  const totalEvents = events.length;
  const shownEvents = cursorIdx + 1;

  if (!active) return null;

  return (
    <div className="border-b border-border-default bg-surface-secondary px-4 py-2 shrink-0">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-2xs font-semibold text-accent-amber uppercase tracking-wide">
          Replay mode
        </span>
        <span className="text-2xs text-text-muted">
          {shownEvents} / {totalEvents} events
        </span>

        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={stepBackward}
            className="px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-primary hover:bg-surface-hover"
            title="Previous event ([)"
            aria-label="Step backward"
          >
            ◀
          </button>
          <button
            onClick={() => (playing ? pause() : play())}
            className="px-2 py-0.5 rounded text-2xs text-text-primary bg-accent-blue-dim hover:bg-accent-blue-dim/80"
            title={playing ? "Pause (Space)" : "Play (Space)"}
          >
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>
          <button
            onClick={stepForward}
            className="px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-primary hover:bg-surface-hover"
            title="Next event (])"
            aria-label="Step forward"
          >
            ▶
          </button>

          <div className="flex items-center gap-0.5 bg-surface-elevated rounded p-0.5 ml-2">
            {([1, 4, 16] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-1.5 py-0.5 rounded text-2xs ${
                  speed === s ? "bg-surface-hover text-text-primary" : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>

          <button
            onClick={exitReplay}
            className="ml-2 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-primary hover:bg-surface-hover"
            title="Exit replay (Esc)"
          >
            Exit
          </button>
        </div>
      </div>

      {/* Timeline bar */}
      <div className="relative h-6 bg-surface-elevated rounded">
        {/* Progress fill */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-accent-amber/20 rounded-l"
          style={{
            width: span > 0 && cursorIdx >= 0
              ? `${((new Date(cursor).getTime() - minT) / span) * 100}%`
              : "0%",
          }}
        />

        {/* Event markers */}
        {events.map((event) => {
          const t = new Date(event.at).getTime();
          const left = span > 0 ? ((t - minT) / span) * 100 : 0;
          const isActive = event.at === cursor;
          const isPast = event.at <= cursor;
          const hasAnnotations = annotationsByEventId.get(event.id)?.length ?? 0;
          return (
            <button
              key={event.id}
              onClick={() => setCursor(event.at)}
              onMouseEnter={() => setHoverEvent(event)}
              onMouseLeave={() => setHoverEvent(null)}
              className={`absolute top-0 bottom-0 w-3 -translate-x-1/2 flex items-center justify-center text-[10px] transition-colors ${
                isActive
                  ? "text-accent-amber"
                  : isPast
                    ? "text-text-secondary hover:text-text-primary"
                    : "text-text-muted opacity-50 hover:opacity-80"
              }`}
              style={{ left: `${left}%` }}
              title={`${event.label}\n${event.at}`}
            >
              <span className="relative">
                {kindIcon[event.kind] ?? "•"}
                {hasAnnotations > 0 && (
                  <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-accent-violet" />
                )}
              </span>
            </button>
          );
        })}

        {/* Hover tooltip */}
        {hoverEvent && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-surface-elevated border border-border-default rounded shadow-lg text-2xs text-text-primary whitespace-nowrap pointer-events-none max-w-[320px] truncate z-10">
            <span className="mr-1.5 opacity-60">{kindLabel[hoverEvent.kind]}</span>
            {hoverEvent.label}
          </div>
        )}
      </div>

      {/* Current event detail + annotation affordance */}
      {cursorIdx >= 0 && (
        <CurrentEventRow
          event={events[cursorIdx]}
          annotating={annotatingEvent === events[cursorIdx].id}
          setAnnotating={(on) => setAnnotatingEvent(on ? events[cursorIdx].id : null)}
        />
      )}
    </div>
  );
}

function CurrentEventRow({
  event,
  annotating,
  setAnnotating,
}: {
  event: TimelineEvent;
  annotating: boolean;
  setAnnotating: (on: boolean) => void;
}) {
  const { addAnnotation, removeAnnotation } = useReplayStore();
  const annotationsByEventId = useAnnotationsByEvent();
  const myAnnotations = annotationsByEventId.get(event.id) ?? [];
  const [note, setNote] = useState("");

  const save = async () => {
    const trimmed = note.trim();
    if (!trimmed) return;
    await addAnnotation(event.id, trimmed);
    setNote("");
    setAnnotating(false);
  };

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-2 text-2xs text-text-secondary">
        <span>{kindIcon[event.kind] ?? "•"}</span>
        <span className="font-mono text-text-muted">{formatTime(event.at)}</span>
        <span className="truncate">{event.label}</span>
        <button
          onClick={() => setAnnotating(!annotating)}
          className="ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px] text-accent-violet hover:bg-accent-violet-dim/40"
          title="Leave a learner note on this event"
        >
          📝 note
        </button>
      </div>

      {myAnnotations.length > 0 && (
        <div className="space-y-1 pl-4">
          {myAnnotations.map((a) => (
            <div
              key={a.id}
              className="flex items-start gap-2 text-2xs text-text-secondary bg-accent-violet-dim/20 border border-accent-violet/20 rounded px-2 py-1"
            >
              <span className="text-accent-violet shrink-0">📝</span>
              <span className="flex-1 whitespace-pre-wrap">{a.note}</span>
              <button
                onClick={() => removeAnnotation(a.id)}
                className="shrink-0 text-text-muted hover:text-accent-red text-[10px]"
                title="Delete note"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {annotating && (
        <div className="flex gap-1.5 pl-4">
          <input
            type="text"
            autoFocus
            placeholder="Note to future-you..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); save(); }
              if (e.key === "Escape") { setNote(""); setAnnotating(false); }
            }}
            className="flex-1 px-2 py-0.5 bg-surface-primary border border-border-default rounded text-2xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet"
          />
          <button
            onClick={save}
            disabled={!note.trim()}
            className="px-2 py-0.5 bg-accent-violet text-white text-2xs rounded hover:bg-accent-violet/80 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}
