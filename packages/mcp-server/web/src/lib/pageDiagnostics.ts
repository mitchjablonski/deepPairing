import type { PageDiagnostics } from "./pageAnchorMessages";

/**
 * #714 gap 12 — wording for a page's render diagnostics (script errors,
 * assets that didn't load, requests the frame's policy blocked), as the
 * annotator reports them. Pure and type-only, so it is cheap to test.
 *
 * Everything here is TEXT for a passive banner and for the bounded note the
 * agent gets in check_feedback. Samples are redacted again here (a second gate
 * after the annotator's): after Run the page's own script could post a report.
 */

/** CSP directives whose blocks also fire an `error` on the element (an img,
 *  video, script or stylesheet link), so the resource count already covers
 *  them; the headline counts only the other blocks (fetches, fonts, frames). */
const ELEMENT_PAIRED_DIRECTIVES = new Set(["img-src", "media-src", "script-src", "script-src-elem", "style-src", "style-src-elem"]);
const IMAGE_TAGS = new Set(["img", "image", "input"]);
const MEDIA_TAGS = new Set(["video", "audio", "source", "track"]);

/** URLs, data: and blob: URIs replaced; whitespace collapsed; clipped. */
export function redactDiagnosticText(s: string, max = 120): string {
  const t = s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(?:data|blob):[^\s"'<>()]*/gi, "[data URI]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]*/gi, "[url]")
    .replace(/(^|[\s("'=])\/\/[^\s"'<>()]+/g, "$1[url]");
  return t.length > max ? t.slice(0, max) : t;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const tagOf = (key: string) => key.split(" ", 1)[0] ?? "";
const sum = (list: ReadonlyArray<{ count: number }>) => list.reduce((n, x) => n + x.count, 0);

export function hasDiagnostics(d: PageDiagnostics | null | undefined): d is PageDiagnostics {
  return !!d && (d.scriptErrors.count > 0 || d.rejections.count > 0 || d.resources.length > 0 || d.blocked.length > 0);
}

/** "2 script errors and 3 images that didn't load", or null when clean. */
export function diagnosticsHeadline(d: PageDiagnostics): string | null {
  const parts: string[] = [];
  const scripts = d.scriptErrors.count + d.rejections.count;
  if (scripts > 0) parts.push(plural(scripts, "script error", "script errors"));
  const images = sum(d.resources.filter((r) => IMAGE_TAGS.has(tagOf(r.key))));
  const media = sum(d.resources.filter((r) => MEDIA_TAGS.has(tagOf(r.key))));
  const other = sum(d.resources) - images - media;
  if (images > 0) parts.push(`${plural(images, "image", "images")} that didn't load`);
  if (media > 0) parts.push(`${plural(media, "media file", "media files")} that didn't load`);
  if (other > 0) parts.push(`${plural(other, "other asset", "other assets")} that didn't load`);
  let blocked = sum(d.blocked.filter((b) => !ELEMENT_PAIRED_DIRECTIVES.has(b.key)));
  // Only element-paired blocks and no element error seen: still say something.
  if (parts.length === 0 && blocked === 0) blocked = sum(d.blocked);
  if (blocked > 0) parts.push(plural(blocked, "blocked request", "blocked requests"));
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const keyList = (list: ReadonlyArray<{ key: string; count: number }>) => list.map((x) => `${x.key} ×${x.count}`).join(", ");

/** The banner's details, one line per kind, as plain text. */
export function diagnosticsDetails(d: PageDiagnostics): string[] {
  const out: string[] = [];
  const samples = (list: readonly string[]) => list.map((s) => redactDiagnosticText(s)).filter(Boolean).join(" · ");
  if (d.scriptErrors.count > 0) {
    const s = samples(d.scriptErrors.samples);
    out.push(`Script errors (${d.scriptErrors.count})${s ? `: ${s}` : ""}`);
  }
  if (d.rejections.count > 0) {
    const s = samples(d.rejections.samples);
    out.push(`Unhandled promise rejections (${d.rejections.count})${s ? `: ${s}` : ""}`);
  }
  if (d.resources.length > 0) out.push(`Didn't load: ${keyList(d.resources)}`);
  if (d.blocked.length > 0) out.push(`Blocked by the frame's no-network policy: ${keyList(d.blocked)}`);
  if (d.resources.length > 0 || d.blocked.some((b) => b.key === "img-src" || b.key === "media-src" || b.key === "font-src")) {
    out.push("Relative and external asset paths can't load in the review frame; the page should inline them as data: URIs.");
  }
  return out;
}

/** The agent-facing summary (one line, at most 500 characters: the
 *  render-failure lane's cap). No URL ever: resources are tag + attribute,
 *  blocks are directive names, samples are redacted. */
export function diagnosticsAgentSummary(d: PageDiagnostics, ctx: { version: number; running: boolean }): string {
  const parts: string[] = [];
  const samples = (list: readonly string[]) => list.map((s) => redactDiagnosticText(s, 80)).filter(Boolean).join(" | ");
  if (d.scriptErrors.count > 0) {
    const s = samples(d.scriptErrors.samples);
    parts.push(`${plural(d.scriptErrors.count, "script error", "script errors")}${s ? ` (${s})` : ""}`);
  }
  if (d.rejections.count > 0) {
    const s = samples(d.rejections.samples);
    parts.push(`${plural(d.rejections.count, "unhandled rejection", "unhandled rejections")}${s ? ` (${s})` : ""}`);
  }
  if (d.resources.length > 0) parts.push(`didn't load: ${keyList(d.resources).replace(/×/g, "x")}`);
  if (d.blocked.length > 0) parts.push(`blocked by the frame's no-network CSP: ${keyList(d.blocked).replace(/×/g, "x")}`);
  const text = `v${ctx.version}, ${ctx.running ? "with the page's scripts running" : "before Run (scripts off)"}: ${parts.join("; ")}`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}
