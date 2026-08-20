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
import fs from "node:fs";
import path from "node:path";
import type { Artifact } from "@deeppairing/shared";
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
 */
export function readGuardrailFires(projectRoot: string | undefined): HtmlGuardrailFire[] {
  if (!projectRoot) return [];
  try {
    const p = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    const fires = Array.isArray(parsed?.fires) ? parsed.fires : [];
    return fires
      .filter((f: any) => f && typeof f === "object" && typeof f.at === "string")
      .map((f: any) => ({ at: f.at, hook: typeof f.hook === "string" ? f.hook : undefined, reason: typeof f.reason === "string" ? f.reason : undefined }));
  } catch {
    return [];
  }
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
  return formatSessionHtml(enriched, {
    ...renderOptions,
    projectName: renderOptions.projectName ?? (projectRoot ? path.basename(projectRoot) : undefined),
  });
}

/** `session-<id>-<yyyy-mm-dd>.html` — stable per session per day, so
 *  re-exporting the same session on the same day overwrites rather than
 *  littering the directory. */
export function htmlExportFileName(sessionId: string, generatedAt = new Date().toISOString()): string {
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "session";
  const day = generatedAt.slice(0, 10);
  return `session-${safeId}-${day}.html`;
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
