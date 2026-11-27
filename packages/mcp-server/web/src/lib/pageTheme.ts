/**
 * #714 gap 13 — does an agent-authored page opt into a dark rendering?
 *
 * The page's own content stays as authored: a page that says nothing about
 * colour schemes keeps its white canvas even in the companion's dark theme
 * (its text colours assume one). A page that declares it supports dark — a
 * `<meta name="color-scheme" content="… dark …">`, a CSS `color-scheme`
 * naming dark, a `prefers-color-scheme: dark` media query, or `light-dark()`
 * — is rendered with a dark colour scheme when the companion is dark, so its
 * own dark styles apply.
 *
 * Read from the raw HTML text, never by running it. A false positive only
 * changes the frame's colour scheme, nothing else.
 */
const META_RE = /<meta\b[^>]*>/gi;
const NAME_RE = /\bname\s*=\s*["']?\s*color-scheme\b/i;
const CONTENT_RE = /\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CSS_SCHEME_RE = /(?:^|[\s;{"'])color-scheme\s*:\s*[^;}"'<]*\bdark\b/i;
const MEDIA_RE = /prefers-color-scheme\s*:\s*dark/i;
const LIGHT_DARK_RE = /\blight-dark\s*\(/i;

export function pageOptsIntoDark(html: string): boolean {
  if (!html) return false;
  for (const tag of html.match(META_RE) ?? []) {
    if (!NAME_RE.test(tag)) continue;
    const m = CONTENT_RE.exec(tag);
    const content = (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").toLowerCase();
    if (/\bdark\b/.test(content) && !/\bonly\s+light\b/.test(content)) return true;
  }
  return CSS_SCHEME_RE.test(html) || MEDIA_RE.test(html) || LIGHT_DARK_RE.test(html);
}
