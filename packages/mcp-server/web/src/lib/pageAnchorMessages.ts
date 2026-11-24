import { z } from "zod";
import { HTML_ANCHOR_LIMITS, HtmlAnchorSchema, PAGE_ASK_LIMITS, type HtmlAnchor } from "@deeppairing/shared";
import { LOCATOR_TEXT_MAX, MAX_CHANGE_MARKS } from "./pageVersionDiff";

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

/** #714 gap 2 — one version-change mark, as the companion sends it DOWN to the
 *  frame. Built only from the parsed (never executed) page text; capped the
 *  same way the annotator re-checks it. */
export const PageChangeMarkSchema = z
  .object({
    kind: z.enum(["added", "changed", "moved", "hinted"]),
    tag: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/),
    text: z.string().min(1).max(LOCATOR_TEXT_MAX),
    occurrence: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type PageChangeMark = z.infer<typeof PageChangeMarkSchema>;

export const PageChangesMessageSchema = z
  .object({
    dp: z.literal("changes"),
    marks: z.array(PageChangeMarkSchema).max(MAX_CHANGE_MARKS),
    show: z.boolean(),
  })
  .strict();
export type PageChangesMessage = z.infer<typeof PageChangesMessageSchema>;

/** The `{dp:"changes"}` message for the frame: every mark validated against
 *  the schema (a mark that fails is dropped, never sent half-checked). */
export function buildChangesMessage(marks: readonly unknown[], show: boolean): PageChangesMessage {
  const ok: PageChangeMark[] = [];
  for (const m of marks.slice(0, MAX_CHANGE_MARKS)) {
    const parsed = PageChangeMarkSchema.safeParse(m);
    if (parsed.success) ok.push(parsed.data);
  }
  return PageChangesMessageSchema.parse({ dp: "changes", marks: ok, show });
}

/** A valid `{dp:"changes-status", found:boolean[]}` from this frame → `found`; else null. */
export function acceptChangesStatus(event: FrameMessage, frame: Window | null | undefined): boolean[] | null {
  const d = fromFrame(event, frame);
  if (!d || d.dp !== "changes-status") return null;
  const found = d.found;
  if (!Array.isArray(found) || found.length > MAX_CHANGE_MARKS || !found.every((f) => typeof f === "boolean")) return null;
  return found as boolean[];
}

/** #714 gap 4 — outline bounds; the annotator caps the same way. */
export const OUTLINE_MAX_HEADINGS = 200;
export const OUTLINE_TEXT_MAX = 120;

const LocatorSchema = z.string().min(1).max(HTML_ANCHOR_LIMITS.locator);
/** A section index (-1 = before the first heading or not found on the page). */
const SectionIndexSchema = z.number().int().min(-1).max(OUTLINE_MAX_HEADINGS - 1);

export const PageOutlineHeadingSchema = z
  .object({
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string().min(1).max(OUTLINE_TEXT_MAX),
    locator: LocatorSchema,
  })
  .strict();
export type PageOutlineHeading = z.infer<typeof PageOutlineHeadingSchema>;

export const PageOutlineMessageSchema = z
  .object({
    dp: z.literal("outline"),
    headings: z.array(PageOutlineHeadingSchema).max(OUTLINE_MAX_HEADINGS),
    /** Per pin (same order as the pins the parent sent): its section. */
    pins: z.array(SectionIndexSchema).max(500),
    /** Per change mark (same order as the marks the parent sent): its section. */
    changes: z.array(SectionIndexSchema).max(MAX_CHANGE_MARKS),
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const [key, list] of [["pins", m.pins], ["changes", m.changes]] as const) {
      if (list.some((i) => i >= m.headings.length)) ctx.addIssue({ code: "custom", path: [key], message: "section index out of range" });
    }
  });
export type PageOutlineMessage = z.infer<typeof PageOutlineMessageSchema>;

/** A valid `{dp:"outline"}` from this frame → the parsed outline; else null.
 *  Display-only: after Run agent script could forge one. */
export function acceptOutlineMessage(event: FrameMessage, frame: Window | null | undefined): PageOutlineMessage | null {
  const d = fromFrame(event, frame);
  if (!d || d.dp !== "outline") return null;
  const parsed = PageOutlineMessageSchema.safeParse(d);
  return parsed.success ? parsed.data : null;
}

/** A valid `{dp:"outline-active", index}` from this frame → index (-1 = above
 *  the first heading); else null. */
export function acceptOutlineActive(event: FrameMessage, frame: Window | null | undefined): number | null {
  const d = fromFrame(event, frame);
  if (!d || d.dp !== "outline-active") return null;
  const parsed = SectionIndexSchema.safeParse(d.index);
  return parsed.success ? parsed.data : null;
}

/** #714 gap 5 — an ask the page marks (data-dp-decision / data-dp-question). */
export const PageAskSchema = z
  .object({
    kind: z.enum(["decision", "question"]),
    text: z.string().max(PAGE_ASK_LIMITS.text),
    locator: LocatorSchema,
    id: z.string().min(1).max(PAGE_ASK_LIMITS.id).optional(),
  })
  .strict();
export type PageAsk = z.infer<typeof PageAskSchema>;

export const PageAsksMessageSchema = z
  .object({ dp: z.literal("asks"), asks: z.array(PageAskSchema).max(PAGE_ASK_LIMITS.max) })
  .strict();

/** A valid `{dp:"asks", asks}` from this frame → the asks; else null.
 *  Display-only: an ask never creates a comment by itself. */
export function acceptAsksMessage(event: FrameMessage, frame: Window | null | undefined): PageAsk[] | null {
  const d = fromFrame(event, frame);
  if (!d || d.dp !== "asks") return null;
  const parsed = PageAsksMessageSchema.safeParse(d);
  return parsed.success ? parsed.data.asks : null;
}

/** The element anchor a "Reply" to an ask opens the composer at: the same
 *  shape a click on the ask posts (locator + its text prefix as the quote),
 *  re-validated so a spoofed ask can't produce an invalid anchor. */
export function askAnchor(ask: PageAsk): HtmlAnchor | null {
  const parsed = HtmlAnchorSchema.safeParse({ kind: "element", locator: ask.locator, quote: ask.text });
  return parsed.success ? parsed.data : null;
}
