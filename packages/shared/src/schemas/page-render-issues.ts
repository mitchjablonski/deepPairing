/**
 * #714 gap 12 — the ONE wire grammar for a `page` artifact's render issues on
 * the render-failure lane (reserved visual id PAGE_RENDER_ISSUES_VISUAL_ID).
 *
 * The page's frame is untrusted once its scripts run: an error message can be
 * anything the page script chose (including text the reviewer typed into a
 * prototype field, or an instruction aimed at the agent). So what reaches the
 * AGENT is data only, in a closed grammar the daemon re-parses at its boundary:
 * kinds, counts, error CLASS names (`TypeError`; anything else is `Error`),
 * resource keys (tag + loading attribute) and CSP directive names. No free
 * text, no URL. The human's banner keeps the redacted samples; they never
 * leave the companion.
 *
 *   v2 scripts-on | script TypeError=3; rejection Error=1; resource img src=2; blocked img-src=2
 */

export const PAGE_RENDER_ISSUES_VISUAL_ID = "dp-page-render-issues";

/** An error class name the agent may see; anything else becomes "Error". */
export const PAGE_ERROR_CLASS_RE = /^[A-Z][A-Za-z0-9]{0,40}(Error|Exception)$/;
/** A resource named only by tag + loading attribute ("img src"). */
export const PAGE_RESOURCE_KEY_RE = /^[a-z][a-z0-9-]{0,31} (?:src|srcset|href|xlink:href|poster|data)$/;
/** A CSP block named only by its directive ("img-src"). */
export const PAGE_DIRECTIVE_RE = /^[a-z][a-z-]{0,39}$/;

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

export function pageErrorClass(name: unknown): string {
  return typeof name === "string" && PAGE_ERROR_CLASS_RE.test(name) ? name : "Error";
}

function validKey(kind: PageRenderIssueKind, key: string): boolean {
  if (kind === "script" || kind === "rejection") return key === "Error" || PAGE_ERROR_CLASS_RE.test(key);
  if (kind === "resource") return PAGE_RESOURCE_KEY_RE.test(key);
  return PAGE_DIRECTIVE_RE.test(key);
}

/**
 * The wire text. Invalid items are dropped (never sent half-checked);
 * duplicate (kind, key) pairs are merged; trailing items are dropped to stay
 * within the length cap. Returns null when nothing valid remains.
 */
export function formatPageRenderIssues(p: PageRenderIssues): string | null {
  if (!Number.isInteger(p.version) || p.version < 1 || p.version > 999_999) return null;
  const merged: PageRenderIssueItem[] = [];
  const perKind: Record<string, number> = {};
  for (const kind of PAGE_RENDER_ISSUE_KINDS) {
    for (const it of p.items) {
      if (it.kind !== kind || !validKey(kind, it.key) || !Number.isInteger(it.count) || it.count < 1) continue;
      const count = Math.min(it.count, PAGE_RENDER_ISSUES_LIMITS.maxCount);
      const same = merged.find((m) => m.kind === kind && m.key === it.key);
      if (same) { same.count = Math.min(same.count + count, PAGE_RENDER_ISSUES_LIMITS.maxCount); continue; }
      if ((perKind[kind] ?? 0) >= PAGE_RENDER_ISSUES_LIMITS.perKind) continue;
      perKind[kind] = (perKind[kind] ?? 0) + 1;
      merged.push({ kind, key: it.key, count });
    }
  }
  if (merged.length === 0) return null;
  const head = `v${p.version} ${p.running ? "scripts-on" : "scripts-off"} | `;
  let body = "";
  for (const m of merged) {
    const item = `${m.kind} ${m.key}=${m.count}`;
    const next = body ? `${body}; ${item}` : item;
    if (head.length + next.length > PAGE_RENDER_ISSUES_LIMITS.maxLength) break;
    body = next;
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
    return `${i.count} blocked by CSP ${i.key}`;
  });
  return `v${p.version}, ${p.running ? "with its scripts running" : "before Run"}: ${parts.join(", ")}`;
}
