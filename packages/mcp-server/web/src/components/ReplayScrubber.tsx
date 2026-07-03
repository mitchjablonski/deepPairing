import { useEffect, useMemo, useState } from "react";
import { useReplayStore, useAnnotationsByEvent } from "../stores/replay";
import type { TimelineEvent } from "../lib/timeline";

const svgDefaults = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function KindIcon({ kind, size = 11 }: { kind: string; size?: number }) {
  const viewBox = "0 0 12 12";
  switch (kind) {
    case "artifact_created":
      return (
        <svg width={size} height={size} viewBox={viewBox} {...svgDefaults} aria-hidden="true">
          <path d="M6 2v8M2 6h8" />
        </svg>
      );
    case "artifact_status_changed":
      return (
        <svg width={size} height={size} viewBox={viewBox} {...svgDefaults} aria-hidden="true">
          <path d="M2 6a4 4 0 017-2.6M10 6a4 4 0 01-7 2.6" />
          <path d="M9 2v2h-2M3 10V8h2" />
        </svg>
      );
    case "comment_added":
      return (
        <svg width={size} height={size} viewBox={viewBox} {...svgDefaults} aria-hidden="true">
          <path d="M2 3.5A1.5 1.5 0 013.5 2h5A1.5 1.5 0 0110 3.5V7a1.5 1.5 0 01-1.5 1.5H5L3 10.5V8.5H3.5A1.5 1.5 0 012 7V3.5z" />
        </svg>
      );
    case "decision_resolved":
      return (
        <svg width={size} height={size} viewBox={viewBox} {...svgDefaults} aria-hidden="true">
          <path d="M6 2v8M3 4l3-2 3 2M2 7l4-1.5M6 5.5L10 7M2 7a1.5 1.5 0 003 0M7 7a1.5 1.5 0 003 0" />
        </svg>
      );
    case "plan_reviewed":
      return (
        <svg width={size} height={size} viewBox={viewBox} {...svgDefaults} aria-hidden="true">
          <path d="M3 2h6a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" />
          <path d="M4 5h4M4 7h4M4 9h2" />
        </svg>
      );
    default:
      return (
        <svg width={size} height={size} viewBox={viewBox} {...svgDefaults} aria-hidden="true">
          <circle cx="6" cy="6" r="1.5" />
        </svg>
      );
  }
}

function NoteIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" {...svgDefaults} aria-hidden="true">
      <path d="M2 2h7l1 1v7a1 1 0 01-1 1H2z" />
      <path d="M4 5h4M4 7h3" />
    </svg>
  );
}

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
  const active = useReplayStore((s) => s.active);
  const events = useReplayStore((s) => s.events);
  const cursor = useReplayStore((s) => s.cursor);
  const playing = useReplayStore((s) => s.playing);
  const speed = useReplayStore((s) => s.speed);
  const exitReplay = useReplayStore((s) => s.exitReplay);
  const setCursor = useReplayStore((s) => s.setCursor);
  const stepForward = useReplayStore((s) => s.stepForward);
  const stepBackward = useReplayStore((s) => s.stepBackward);
  const play = useReplayStore((s) => s.play);
  const pause = useReplayStore((s) => s.pause);
  const setSpeed = useReplayStore((s) => s.setSpeed);
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
      else if (e.key === " ") { e.preventDefault(); if (playing) pause(); else play(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [active, playing, stepForward, stepBackward, play, pause]);

  const { minT, span } = useMemo(() => {
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
              <span className="relative flex items-center justify-center">
                <KindIcon kind={event.kind} size={11} />
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
  const addAnnotation = useReplayStore((s) => s.addAnnotation);
  const removeAnnotation = useReplayStore((s) => s.removeAnnotation);
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
        <span className="text-text-muted"><KindIcon kind={event.kind} size={11} /></span>
        <span className="font-mono text-text-muted">{formatTime(event.at)}</span>
        <span className="truncate">{event.label}</span>
        <button
          onClick={() => setAnnotating(!annotating)}
          className="ml-auto shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-accent-violet hover:bg-accent-violet-dim/40"
          title="Leave a learner note on this event"
        >
          <NoteIcon size={10} />
          note
        </button>
      </div>

      {myAnnotations.length > 0 && (
        <div className="space-y-1 pl-4">
          {myAnnotations.map((a) => (
            <div
              key={a.id}
              className="flex items-start gap-2 text-2xs text-text-secondary bg-accent-violet-dim/20 border border-accent-violet/20 rounded px-2 py-1"
            >
              <span className="text-accent-violet shrink-0 mt-0.5"><NoteIcon size={10} /></span>
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
            className="px-2 py-0.5 bg-accent-violet-strong text-white text-2xs rounded hover:bg-accent-violet-strong/80 disabled:opacity-50"
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
