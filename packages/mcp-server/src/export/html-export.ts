/**
 * Q5 — assembly + delivery for the `html` export.
 *
 * `format-html.ts` is PURE (state in, page out). This module is the impure
 * half the three surfaces share, so the MCP tool, the HTTP route and the CLI
 * all produce the SAME page from the same inputs:
 *
 *   - `gatherPreflightTraces` — the persisted per-artifact preflight traces
 *     (the gate's breadcrumbs). Capped; a store without the optional getter
 *     simply yields none.
 *   - `readGuardrailFires` — the project-scoped guardrail hook fire log from
 *     `.deeppairing/hooks-state.json` (the renderer filters it to the
 *     session's own time window).
 *   - `assembleSessionHtml` — the one call that turns a session state into the
 *     shareable page.
 *   - `writeSessionHtml` — deterministic `.deeppairing/exports/` destination,
 *     so "tell the human the file path" is a real path every time.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Artifact } from "@deeppairing/shared";
import { scanContentForSecrets, scanForSecrets, type SecretMatch } from "../secret-scan.js";
import {
  formatSessionHtml,
  type HtmlExportOptions,
  type HtmlGuardrailFire,
  type HtmlPreflightTrace,
  type HtmlSessionState,
} from "./format-html.js";

/** How many artifacts we'll fetch a preflight trace for. In daemon mode each
 *  is an HTTP round-trip, so cap it — the breadcrumb is a bonus, not the
 *  spine of the page. */
const MAX_TRACE_LOOKUPS = 200;

interface TraceCapableStore {
  getPreflightTrace?(artifactId: string): unknown;
}

export async function gatherPreflightTraces(
  store: TraceCapableStore | undefined,
  artifacts: Artifact[],
): Promise<HtmlPreflightTrace[]> {
  if (!store?.getPreflightTrace) return [];
  const ids = artifacts.slice(0, MAX_TRACE_LOOKUPS).map((a) => a.id);
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return (await store.getPreflightTrace!(id)) as HtmlPreflightTrace | null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((t): t is HtmlPreflightTrace => !!t && typeof t === "object");
}

/**
 * The guardrail hook fire log. Project-scoped, capped at 50 by the writer, and
 * carrying only `{ at, hook, reason }` — the renderer says exactly that much
 * and never more. Unreadable/missing file → no beats (never a fabricated one).
 *
 * F3 — `fires[]` has TWO writers. Besides the preflight lane's
 * `{hook:"preflight", reason:"guardrail:<class>"}` (a real ask: the run stopped
 * and the human confirmed), the STOP hook appends
 * `{hook:"stop", reason:"owes debrief in <sessionId>"}` — which exits 0,
 * fail-open: nothing was stopped and nobody confirmed. Rendering that as a gate
 * moment invented an event AND printed another session's id onto a page written
 * for strangers. So the reader is narrowed at the source: only a preflight fire
 * whose reason names a guardrail class survives. Anything else — a new writer,
 * an unknown shape — is dropped rather than guessed at.
 */
export function readGuardrailFires(projectRoot: string | undefined): HtmlGuardrailFire[] {
  if (!projectRoot) return [];
  try {
    const p = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    const fires: unknown[] = Array.isArray(parsed?.fires) ? parsed.fires : [];
    const out: HtmlGuardrailFire[] = [];
    for (const raw of fires) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as { at?: unknown; hook?: unknown; reason?: unknown; kind?: unknown };
      if (typeof f.at !== "string" || f.hook !== "preflight") continue;
      if (typeof f.reason !== "string" || !/^guardrail:.+/.test(f.reason)) continue;
      // Q1 stamps `kind: "ask"` on the preflight lane's fires. Accept an absent
      // kind (older state files, the generated hook copies) but never a kind we
      // don't recognise — a future `kind: "block"` must not silently inherit
      // the ask wording.
      if (f.kind !== undefined && f.kind !== "ask") continue;
      out.push({ at: f.at, hook: f.hook, reason: f.reason });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * F6 — a LAST-MOMENT secret check on what is about to leave the building.
 *
 * The store already scans artifact content at creation, but this export is the
 * point where the material stops being a local review surface and becomes a
 * file the human hands to someone else. So we re-scan the assembled state and
 * WARN — never block: refusing to export because a fixture contains `AKIA…`
 * would be the tool substituting its judgement for the human's on their own
 * repo. The warning names the field, never the value (mirroring SecretWarning:
 * surfacing a secret to warn about it would re-leak it).
 *
 * Returns null when the export is clean, so a clean run's reply is unchanged.
 */
/**
 * R3 — the scan walks the RENDERED-CONTENT GRAPH, not the raw state blob.
 *
 * F6's scan was blind twice over, and each blindness alone was enough to make
 * it return a clean [] for a page carrying a live AWS key:
 *
 *   1. DEPTH. `scanContentForSecrets` defaulted to maxDepth 6. Rooted at the
 *      whole session state, an evidence snippet sits at depth 8
 *      (`artifacts[0].content.findings[0].evidence[0].snippet`) and a diff line
 *      at depth 10. The walk stopped two levels above every string that
 *      actually holds code. (Fixed at the source too — see DEFAULT_SCAN_DEPTH.)
 *   2. ROOT. This function passed the whole `state`; the STORE scans each
 *      artifact's `content`. So even where both could see a leaf, they reported
 *      different field paths for it — one saying `artifacts[3].content.summary`
 *      and the other `summary` — and no test could compare them.
 *
 * Both are fixed by naming what the page renders and scanning exactly that,
 * artifact content rooted at `content` (parity with the store), plus the two
 * things the store never sees at all: the COMMENT bodies and the agent's
 * NARRATIVE — which is composed at export time, has no artifact, and is the
 * single largest run of free text on the page.
 */
export interface ExportScanInput {
  artifacts?: Array<{ id?: string; type?: string; title?: string; content?: unknown }>;
  comments?: Array<{ content?: unknown }>;
  sessionMemory?: unknown;
}

export interface ExportScanOptions {
  /** The agent-composed narrative, which lives only in the export call. */
  narrative?: string;
}

/** Every secret-shape match in what the page will actually render, deduped per
 *  pattern (first field to hit a pattern wins, as everywhere else). */
export function scanExportForSecrets(state: unknown, options: ExportScanOptions = {}): SecretMatch[] {
  const s = (state ?? {}) as ExportScanInput;
  const out: SecretMatch[] = [];
  // R3 (adversarial F4) — NO global per-pattern dedup across sources. The old
  // `seen` set collapsed 40 distinct AWS keys in 40 artifacts to ONE match, so
  // the banner said "matched 1 credential-shaped value" while all 40 were on the
  // page and a reader who fixed the one named field shipped the other 39.
  // scanContentForSecrets still dedupes WITHIN one artifact's content (one
  // warning per pattern per artifact — a repeated key isn't 5 warnings), but
  // every artifact/comment/field that hits is its own entry now, and the field
  // prefix names the artifact by INDEX + TITLE so each is findable.
  const take = (matches: SecretMatch[], prefix: string): void => {
    for (const m of matches) out.push({ ...m, field: m.field ? `${prefix}.${m.field}` : prefix });
  };
  try {
    (s.artifacts ?? []).forEach((a, i) => {
      if (!a || typeof a !== "object") return;
      const title = typeof a.title === "string" && a.title.trim() ? ` "${a.title.trim()}"` : "";
      // Rooted at `content`, exactly as the store roots it, so a field path in
      // an export warning and a field path in a stored SecretWarning name the
      // same leaf. The `#n "title"` prefix makes 40 hits 40 findable places.
      take(scanContentForSecrets(a.content), `${a.type ?? "artifact"} #${i + 1}${title}`);
    });
    (s.comments ?? []).forEach((c, i) => {
      if (typeof c?.content === "string") take(scanForSecrets(c.content), `comment #${i + 1}`);
    });
    if (typeof options.narrative === "string" && options.narrative) {
      take(scanForSecrets(options.narrative), "narrative");
    }
    if (s.sessionMemory) take(scanContentForSecrets(s.sessionMemory), "sessionMemory");
  } catch {
    return out; // a scan failure must never fail the export
  }
  return out;
}

/** R3 (adversarial F4) — the OCCURRENCE count, distinct from the label list.
 *  The banner's headline number must count every place a secret appears (40),
 *  while its list of names stays deduped by label (`secretLabelsOf`). */
export function secretCountOf(matches: SecretMatch[]): number {
  return matches.length;
}

/** R3 (adversarial F6) — a match whose ONLY home on the page is a code body
 *  (an evidence snippet, a diff line, before/after). With `includeCode: false`
 *  those bodies are dropped, so a "search the page for it" instruction would be
 *  a lie — but a secret in the NARRATIVE or a COMMENT (prose, always rendered)
 *  survives redaction and must still be listed. */
export function isCodeBearingField(field: string | undefined): boolean {
  if (!field) return false;
  if (field.startsWith("narrative") || field.startsWith("comment")) return false;
  return /\.(snippet|content|before|after|preview|replacementText|code)\b/.test(field) ||
    /\.(snippet|content|before|after|preview|replacementText|code)$/.test(field);
}

/** The distinct human-readable labels of a scan, for the page banner and the
 *  HTTP header. Labels only — never a value, never a line. */
export function secretLabelsOf(matches: SecretMatch[]): string[] {
  return Array.from(new Set(matches.map((m) => m.label)));
}

export function secretWarningFor(state: unknown, options: ExportScanOptions = {}): string | null {
  const matches = scanExportForSecrets(state, options);
  if (!matches.length) return null;
  const shown = matches.slice(0, 5).map((m) => {
    const where = m.field ? ` in \`${m.field}\`${m.line != null ? ` (line ${m.line})` : ""}` : "";
    return `${m.label}${where}`;
  });
  const more = matches.length > shown.length ? ` (+${matches.length - shown.length} more)` : "";
  return (
    `⚠️ Possible secret in this export — ${matches.length} match${matches.length === 1 ? "" : "es"} found, review before sharing: ${shown.join("; ")}${more}. ` +
    `The value itself is not printed here. This page is meant to leave the building, so check it first.`
  );
}

/**
 * R3 — the same warning as an ASCII-only, single-line HTTP header value.
 *
 * GET /api/export.html had no warning at all: the MCP tool and the CLI both
 * warned, and the surface the human actually clicks (the Export menu) did not,
 * so the one path with a person on the other end was the silent one. Header
 * values must be ASCII and free of newlines, so this is built from the labels
 * and field paths only (both ASCII by construction) and then defensively
 * stripped — a header that throws on encode would take the whole export down,
 * which is the opposite of warn-never-block.
 */
export function secretWarningHeader(matches: SecretMatch[]): string | null {
  if (!matches.length) return null;
  const parts = matches.slice(0, 8).map((m) => (m.field ? `${m.label} in ${m.field}` : m.label));
  const more = matches.length > parts.length ? ` (+${matches.length - parts.length} more)` : "";
  const raw = `Possible secret in this page - ${matches.length} match${matches.length === 1 ? "" : "es"} found, review before sharing: ${parts.join("; ")}${more}`;
  const ascii = raw.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  return ascii.slice(0, 990) || null;
}

export interface AssembleHtmlOptions extends HtmlExportOptions {
  /** Store used to gather the persisted preflight traces (optional getter). */
  store?: TraceCapableStore;
}

/** Build the shareable page from a session state, gathering the optional
 *  gate evidence the renderer will place on the timeline. */
export async function assembleSessionHtml(
  state: HtmlSessionState,
  options: AssembleHtmlOptions = {},
): Promise<string> {
  const { store, ...renderOptions } = options;
  const projectRoot = renderOptions.projectRoot;
  const enriched: HtmlSessionState = {
    ...state,
    preflightTraces: state.preflightTraces ?? (await gatherPreflightTraces(store, state.artifacts ?? [])),
    guardrailFires: state.guardrailFires ?? readGuardrailFires(projectRoot),
  };
  // R3 — the scan runs HERE, in the one function all three surfaces share, so
  // the banner is a property of the PAGE rather than of whichever caller
  // remembered to ask for it. `secretLabels` passed explicitly by a caller wins
  // (the tool already has the matches in hand and needn't scan twice); its
  // `secretCount` rides along so the headline number is the occurrence count.
  let secretLabels = renderOptions.secretLabels;
  let secretCount = renderOptions.secretCount;
  if (secretLabels === undefined) {
    const matches = scanExportForSecrets(enriched, { narrative: renderOptions.narrative });
    secretLabels = secretLabelsOf(matches);
    secretCount = secretCountOf(matches);
  }
  return formatSessionHtml(enriched, {
    ...renderOptions,
    secretLabels,
    secretCount,
    projectName: renderOptions.projectName ?? (projectRoot ? path.basename(projectRoot) : undefined),
  });
}

/** `session-<id>-<yyyy-mm-dd>.html` — stable per session per day, so
 *  re-exporting the same session on the same day overwrites rather than
 *  littering the directory. */
export function htmlExportFileName(sessionId: string, generatedAt = new Date().toISOString()): string {
  // R3 (adversarial F7) — the filename must NOT carry the session id. The id is
  // `session_<local folder name>_<hash>` — a directory off the exporter's disk —
  // and this string becomes the browser's Content-Disposition, i.e. the name on
  // the email attachment when the page leaves the building. R3 had already
  // stripped the id from the page's masthead for exactly this reason, so echoing
  // it in the download name would reopen the leak one layer down (worse than the
  // pre-R3 anonymous `deeppairing-session.html`, which at least didn't leak).
  //
  // A short, one-way hash of the id keeps per-session uniqueness (so
  // re-exporting overwrites rather than littering, and two sessions the same day
  // don't collide) WITHOUT being reversible to the folder name.
  const token = crypto.createHash("sha1").update(String(sessionId)).digest("hex").slice(0, 8);
  const day = generatedAt.slice(0, 10);
  return `deeppairing-session-${day}-${token}.html`;
}

/** Write the page under `.deeppairing/exports/` and return its absolute path. */
export function writeSessionHtml(
  projectRoot: string,
  sessionId: string,
  html: string,
  generatedAt?: string,
): string {
  const dir = path.join(projectRoot, ".deeppairing", "exports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, htmlExportFileName(sessionId, generatedAt));
  fs.writeFileSync(file, html, "utf-8");
  return file;
}
