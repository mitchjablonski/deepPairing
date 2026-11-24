import { HtmlAnchorSchema, type HtmlAnchor } from "@deeppairing/shared";

/**
 * #680 slice 2 — the PARENT side of the page frame's postMessage protocol.
 *
 * The frame is an opaque-origin sandbox, so `event.origin` is "null" for every
 * such frame and proves nothing. Identity is `event.source`: a message counts
 * only when it came from THIS page's iframe contentWindow. Even then its payload
 * is untrusted (after Run, agent script shares the frame with the annotator and
 * could post a spoofed anchor), so every anchor is re-parsed against the shared
 * Zod schema, which caps every field. A spoofed-but-valid anchor can at most
 * point the composer at a different spot the human can see before submitting:
 * an anchor only OPENS the composer, it never creates a comment.
 *
 * Imports Zod (via the shared schema), so only the lazily loaded PageArtifact
 * chunk may import this module — never the entry chunk (the D6 split).
 */

type FrameMessage = Pick<MessageEvent, "source" | "data">;

function fromFrame(event: FrameMessage, frame: Window | null | undefined): Record<string, unknown> | null {
  if (!frame || event.source !== frame) return null;
  const d = event.data as unknown;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  return d as Record<string, unknown>;
}

/** A valid `{dp:"anchor", anchor}` from this frame → the parsed anchor; else null. */
export function acceptAnchorMessage(event: FrameMessage, frame: Window | null | undefined): HtmlAnchor | null {
  const d = fromFrame(event, frame);
  if (!d || d.dp !== "anchor") return null;
  const parsed = HtmlAnchorSchema.safeParse(d.anchor);
  return parsed.success ? parsed.data : null;
}

/** The most pins a status report may describe (the annotator caps at 500). */
const MAX_PINS = 500;

/** A valid `{dp:"pins-status", found:boolean[]}` from this frame → `found`; else null. */
export function acceptPinsStatus(event: FrameMessage, frame: Window | null | undefined): boolean[] | null {
  const d = fromFrame(event, frame);
  if (!d || d.dp !== "pins-status") return null;
  const found = d.found;
  if (!Array.isArray(found) || found.length > MAX_PINS || !found.every((f) => typeof f === "boolean")) return null;
  return found as boolean[];
}

/** `{dp:"ready"}` from this frame: the annotator is listening, send pins. */
export function isReadyMessage(event: FrameMessage, frame: Window | null | undefined): boolean {
  const d = fromFrame(event, frame);
  return !!d && d.dp === "ready";
}

/** #714 — `{dp:"toggle-pointing"}` from this frame: the reviewer pressed the
 *  pointing shortcut while focus was inside the page. It can only flip the
 *  pointing mode (the parent also requires the frame to own focus). */
export function isTogglePointingMessage(event: FrameMessage, frame: Window | null | undefined): boolean {
  const d = fromFrame(event, frame);
  return !!d && d.dp === "toggle-pointing";
}
