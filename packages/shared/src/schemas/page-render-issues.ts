/**
 * #714 gap 12 — the ONE wire grammar for a `page` artifact's render issues on
 * the render-failure lane (reserved visual id PAGE_RENDER_ISSUES_VISUAL_ID).
 *
 * The page's frame is untrusted once its scripts run: an error message can be
 * anything the page script chose (including text the reviewer typed into a
 * prototype field, or an instruction aimed at the agent). So what reaches the
 * AGENT is data only, in a closed grammar the daemon re-parses at its boundary:
 * kinds, counts, and keys from FIXED allowlists only: error class names
 * (`TypeError`; else `Error`), resource tag + attribute pairs (`img src`;
 * else `other resource`) and CSP3 directive names (`img-src`; else `other`).
 * No free text, no URL. (Counts are the one page-influenced value left: a
 * narrow, accepted residual.) The human's banner keeps the redacted samples; they never
 * leave the companion.
 *
 *   v2 scripts-on | script TypeError=3; rejection Error=1; resource img src=2; blocked img-src=2
 */

export const PAGE_RENDER_ISSUES_VISUAL_ID = "dp-page-render-issues";

/** The ONLY error class names the agent may see (standard JS errors and
 *  common DOMException names); anything else becomes "Error". A fixed list,
 *  not a pattern: a pattern like /[A-Z]\w*Error/ would let the page spell a
 *  word of its choosing ("Hunter2Error"). The annotator carries a copy (it
 *  runs in the frame and can't import); a parity test holds the two equal. */
export const PAGE_ERROR_CLASSES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError", "InternalError", "DOMException", "SecurityError", "NetworkError", "AbortError", "NotAllowedError", "NotFoundError", "NotSupportedError", "InvalidStateError", "QuotaExceededError", "TimeoutError", "DataCloneError"] as const;
const PAGE_ERROR_CLASS_SET: ReadonlySet<string> = new Set(PAGE_ERROR_CLASSES);
export function isPageErrorClass(name: unknown): name is string {
  return typeof name === "string" && PAGE_ERROR_CLASS_SET.has(name);
}
/** A resource is named only by one of these tag + loading-attribute pairs
 *  (each tag with its own attributes); anything else is PAGE_RESOURCE_OTHER.
 *  A fixed list, not a pattern: a token pattern would let a forged report
 *  spell words of its choosing. The annotator carries a copy (parity test). */
export const PAGE_RESOURCE_KEYS = ["img src", "img srcset", "source src", "source srcset", "video src", "video poster", "audio src", "track src", "script src", "link href", "iframe src", "frame src", "embed src", "object data", "input src", "image href", "use href"] as const;
export const PAGE_RESOURCE_OTHER = "other resource";
/** A CSP block is named only by a CSP3 directive name; anything else is
 *  PAGE_DIRECTIVE_OTHER. The annotator carries a copy (parity test). */
export const PAGE_CSP_DIRECTIVES = ["default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "img-src", "font-src", "connect-src", "media-src", "object-src", "frame-src", "child-src", "worker-src", "manifest-src", "base-uri", "form-action", "frame-ancestors", "navigate-to", "prefetch-src", "sandbox", "trusted-types", "require-trusted-types-for", "upgrade-insecure-requests", "report-uri", "report-to"] as const;
export const PAGE_DIRECTIVE_OTHER = "other";
const RESOURCE_SET: ReadonlySet<string> = new Set<string>([...PAGE_RESOURCE_KEYS, PAGE_RESOURCE_OTHER]);
const DIRECTIVE_SET: ReadonlySet<string> = new Set<string>([...PAGE_CSP_DIRECTIVES, PAGE_DIRECTIVE_OTHER]);
export function isPageResourceKey(key: unknown): key is string {
  return typeof key === "string" && RESOURCE_SET.has(key);
}
export function isPageDirective(key: unknown): key is string {
  return typeof key === "string" && DIRECTIVE_SET.has(key);
}
/** Onto the allowlist: a known pair stays, anything else is "other resource". */
export function pageResourceKey(key: unknown): string {
  return isPageResourceKey(key) ? key : PAGE_RESOURCE_OTHER;
}
/** Onto the allowlist: a CSP3 directive stays, anything else is "other". */
export function pageDirective(key: unknown): string {
  return isPageDirective(key) ? key : PAGE_DIRECTIVE_OTHER;
}

export const PAGE_RENDER_ISSUE_KINDS = ["script", "rejection", "resource", "blocked"] as const;
export type PageRenderIssueKind = (typeof PAGE_RENDER_ISSUE_KINDS)[number];
export interface PageRenderIssueItem {
  kind: PageRenderIssueKind;
  key: string;
  count: number;
}
export interface PageRenderIssues {
  version: number;
  /** Were the page's own scripts running (after Run)? */
  running: boolean;
  items: PageRenderIssueItem[];
}

/** Bounds: per kind, total length (the lane's 500-character cap). */
export const PAGE_RENDER_ISSUES_LIMITS = { perKind: 8, maxCount: 9999, maxLength: 500 } as const;

/** The largest version the grammar carries (HEAD_RE: at most six digits). */
const PAGE_RENDER_ISSUES_MAX_VERSION = 999_999;

export function pageErrorClass(name: unknown): string {
  return isPageErrorClass(name) ? name : "Error";
}

/** The canonical position of a key within its kind: its index in the kind's
 *  allowlist, the catch-all ("other resource" / "other") last. Caps keep the
 *  lowest-ranked keys, so the retained subset never depends on discovery
 *  order. The annotator ranks the same way from its copies (parity test). */
export function pageRenderIssueKeyRank(kind: PageRenderIssueKind, key: string): number {
  const list: readonly string[] = kind === "script" || kind === "rejection" ? PAGE_ERROR_CLASSES
    : kind === "resource" ? PAGE_RESOURCE_KEYS : PAGE_CSP_DIRECTIVES;
  const i = list.indexOf(key);
  return i === -1 ? list.length : i;
}

function validKey(kind: PageRenderIssueKind, key: string): boolean {
  if (kind === "script" || kind === "rejection") return isPageErrorClass(key);
  if (kind === "resource") return isPageResourceKey(key);
  return isPageDirective(key);
}

/**
 * The wire text. Invalid items are dropped (never sent half-checked);
 * duplicate (kind, key) pairs are merged; trailing items are dropped to stay
 * within the length cap. Returns null when nothing valid remains.
 */
export function formatPageRenderIssues(p: PageRenderIssues): string | null {
  if (!Number.isInteger(p.version) || p.version < 1 || p.version > PAGE_RENDER_ISSUES_MAX_VERSION) return null;
  const merged: PageRenderIssueItem[] = [];
  for (const kind of PAGE_RENDER_ISSUE_KINDS) {
    // Every distinct key of this kind first (the allowlists are finite, so
    // this is bounded), then the canonical order, then the per-kind cap: the
    // same keys always retain the same subset, whatever order they arrived in.
    const ofKind: PageRenderIssueItem[] = [];
    for (const raw of p.items) {
      // A key outside its allowlist is mapped ("Error", "other resource",
      // "other"), never dropped.
      const key = raw.kind === "script" || raw.kind === "rejection" ? pageErrorClass(raw.key)
        : raw.kind === "resource" ? pageResourceKey(raw.key) : pageDirective(raw.key);
      const it = { ...raw, key };
      if (it.kind !== kind || !validKey(kind, it.key) || !Number.isInteger(it.count) || it.count < 1) continue;
      const count = Math.min(it.count, PAGE_RENDER_ISSUES_LIMITS.maxCount);
      const same = ofKind.find((m) => m.key === it.key);
      if (same) { same.count = Math.min(same.count + count, PAGE_RENDER_ISSUES_LIMITS.maxCount); continue; }
      ofKind.push({ kind, key: it.key, count });
    }
    ofKind.sort((a, b) => pageRenderIssueKeyRank(kind, a.key) - pageRenderIssueKeyRank(kind, b.key));
    merged.push(...ofKind.slice(0, PAGE_RENDER_ISSUES_LIMITS.perKind));
  }
  if (merged.length === 0) return null;
  const head = `v${p.version} ${p.running ? "scripts-on" : "scripts-off"} | `;
  // Which items fit is decided at the WIDEST encoding (largest version, the
  // longer run state, every count at the cap), so the included subset, and
  // with it the wake key, depends only on the kinds and keys: a count gaining
  // a digit near the cap can never push a trailing item out and re-arm an
  // acknowledged report. The actual text is no longer than that bound.
  const widestHead = `v${PAGE_RENDER_ISSUES_MAX_VERSION} scripts-off | `.length;
  const widestCount = String(PAGE_RENDER_ISSUES_LIMITS.maxCount).length;
  let budget = widestHead, body = "";
  for (const m of merged) {
    const widest = `${m.kind} ${m.key}=`.length + widestCount + (body ? 2 : 0);
    if (budget + widest > PAGE_RENDER_ISSUES_LIMITS.maxLength) break;
    budget += widest;
    const item = `${m.kind} ${m.key}=${m.count}`;
    body = body ? `${body}; ${item}` : item;
  }
  return body ? head + body : null;
}

const HEAD_RE = /^v([1-9][0-9]{0,5}) (scripts-on|scripts-off) \| (.+)$/;
const ITEM_RE = /^(script|rejection|resource|blocked) (.+)=([1-9][0-9]{0,3})$/;

/** Strict parse of the wire text: null for anything outside the grammar. */
export function parsePageRenderIssues(text: unknown): PageRenderIssues | null {
  if (typeof text !== "string" || text.length > PAGE_RENDER_ISSUES_LIMITS.maxLength) return null;
  const head = HEAD_RE.exec(text);
  if (!head) return null;
  const items: PageRenderIssueItem[] = [];
  const perKind: Record<string, number> = {};
  for (const raw of head[3]!.split("; ")) {
    const m = ITEM_RE.exec(raw);
    if (!m) return null;
    const kind = m[1] as PageRenderIssueKind;
    const key = m[2]!;
    if (!validKey(kind, key)) return null;
    if (items.some((i) => i.kind === kind && i.key === key)) return null;
    perKind[kind] = (perKind[kind] ?? 0) + 1;
    if (perKind[kind]! > PAGE_RENDER_ISSUES_LIMITS.perKind) return null;
    items.push({ kind, key, count: Number(m[3]) });
  }
  return { version: Number(head[1]), running: head[2] === "scripts-on", items };
}

/**
 * What re-arms (and may wake) the agent: the SET of kinds and keys. Counts
 * are not part of it, so a page whose interval keeps throwing the same
 * TypeError updates the stored counts without waking anyone again.
 */
export function pageRenderIssuesWakeKey(p: PageRenderIssues): string {
  return p.items.map((i) => `${i.kind}:${i.key}`).sort().join("\n");
}

/** Agent-facing prose, built only from the parsed data (no page text). */
export function describePageRenderIssues(p: PageRenderIssues): string {
  const parts = p.items.map((i) => {
    if (i.kind === "script") return `${i.count} ${i.key}`;
    if (i.kind === "rejection") return `${i.count} unhandled rejection${i.count === 1 ? "" : "s"} (${i.key})`;
    if (i.kind === "resource") return `${i.count} ${i.key} that didn't load`;
    return i.key === PAGE_DIRECTIVE_OTHER ? `${i.count} blocked by another CSP directive` : `${i.count} blocked by CSP ${i.key}`;
  });
  return `v${p.version}, ${p.running ? "with its scripts running" : "before Run"}: ${parts.join(", ")}`;
}
