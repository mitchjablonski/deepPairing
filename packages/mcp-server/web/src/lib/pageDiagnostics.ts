import { formatPageRenderIssues, pageRenderIssuesWakeKey, parsePageRenderIssues, type PageRenderIssueItem } from "@deeppairing/shared";
import type { PageDiagnostics } from "./pageAnchorMessages";

/**
 * #714 gap 12 — wording for a page's render diagnostics (script errors,
 * assets that didn't load, requests the frame's policy blocked), as the
 * annotator reports them. Pure and type-only, so it is cheap to test.
 *
 * The banner text (with redacted samples, a second gate after the
 * annotator's: after Run the page's own script could post a report) stays in
 * the companion. The agent gets only the closed page-issues grammar.
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

/** The agent-facing summary: the closed page-issues grammar (kinds, counts,
 *  error CLASS names, tag + attribute, directive names). NEVER a sample:
 *  after Run an error message is whatever the page's script chose, which may
 *  be text the reviewer typed into the page or an instruction aimed at the
 *  agent. null when there is nothing to report. */
export function diagnosticsAgentSummary(d: PageDiagnostics, ctx: { version: number; running: boolean }): string | null {
  const items: PageRenderIssueItem[] = [
    ...d.scriptErrors.classes.map((c) => ({ kind: "script" as const, key: c.key, count: c.count })),
    ...d.rejections.classes.map((c) => ({ kind: "rejection" as const, key: c.key, count: c.count })),
    ...d.resources.map((r) => ({ kind: "resource" as const, key: r.key, count: r.count })),
    ...d.blocked.map((b) => ({ kind: "blocked" as const, key: b.key, count: b.count })),
  ];
  return formatPageRenderIssues({ version: ctx.version, running: ctx.running, items });
}

/** What makes a report worth re-posting at once: the set of kinds/keys
 *  (counts alone are re-posted at most once a minute; the daemon re-arms the
 *  agent on the same key anyway). */
export function diagnosticsWakeKey(summary: string): string {
  const parsed = parsePageRenderIssues(summary);
  return parsed ? pageRenderIssuesWakeKey(parsed) : summary;
}
