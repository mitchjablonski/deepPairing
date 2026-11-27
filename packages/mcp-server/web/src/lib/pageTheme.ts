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
 * Read from the raw HTML text, never by running it, and only from what the
 * page actually styles itself with: color-scheme metas, `<style>` contents
 * and `style=""` attributes, after `<pre>`, `<code>`, `<script>`,
 * `<textarea>` and HTML comments are stripped (a CSS sample shown on the
 * page, or prose about dark mode, says nothing about the page itself). A
 * false positive only changes the frame's colour scheme, nothing else.
 */
const STRIP_RE = /<!--[\s\S]*?-->|<(pre|code|script|textarea|xmp|listing|plaintext)\b[\s\S]*?<\/\1\s*>/gi;
const META_RE = /<meta\b[^>]*>/gi;
const NAME_RE = /\bname\s*=\s*["']?\s*color-scheme\b/i;
const CONTENT_RE = /\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const STYLE_ATTR_RE = /<[a-z][^>]*?\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
const CSS_SCHEME_RE = /(?:^|[\s;{])color-scheme\s*:\s*[^;}]*\bdark\b/i;
const MEDIA_RE = /prefers-color-scheme\s*:\s*dark/i;
const LIGHT_DARK_RE = /\blight-dark\s*\(/i;

function cssOptsIn(css: string): boolean {
  return CSS_SCHEME_RE.test(css) || MEDIA_RE.test(css) || LIGHT_DARK_RE.test(css);
}

export function pageOptsIntoDark(html: string): boolean {
  if (!html) return false;
  const doc = html.replace(STRIP_RE, " ");
  for (const tag of doc.match(META_RE) ?? []) {
    if (!NAME_RE.test(tag)) continue;
    const m = CONTENT_RE.exec(tag);
    const content = (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").toLowerCase();
    if (/\bdark\b/.test(content) && !/\bonly\s+light\b/.test(content)) return true;
  }
  for (const m of doc.matchAll(STYLE_BLOCK_RE)) if (cssOptsIn(m[1] ?? "")) return true;
  for (const m of doc.matchAll(STYLE_ATTR_RE)) if (cssOptsIn(m[2] ?? m[3] ?? "")) return true;
  return false;
}
