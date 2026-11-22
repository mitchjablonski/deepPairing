import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { PAGE_HTML_MAX_BYTES, type PageContent } from "@deeppairing/shared";
import { preflightArtifact } from "../artifact-preflight.js";
import { validatePresentPageInput, pageTooLargeError, type ToolErrorResponse } from "../validate-tool-input.js";
import { maybeEmitTaskHandle } from "../tasks-probe.js";
import { persistPreflightTrace, formatPreflightTraceSummary, notifyResourcesListChanged, revisionNudge, linkServedRequest, hashPresentArgs, buildDedupResponse, formatStyleWarnings } from "../tool-helpers.js";
import { resolveProjectRoot } from "../../project-root.js";
import { TOOL_ERROR_CODES, TOOL_ERROR_RETRYABLE } from "../../error-codes.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * #680 slice 1 — present an agent-authored HTML PAGE for review.
 *
 * The page is its own artifact (`type: "page"`), rendered full-width in the
 * companion inside the same opaque-origin, no-network sandbox PrototypeFrame
 * uses. It is a reviewable draft like research/plan: the human approves,
 * requests changes or rejects with a reason, and a reject feeds rejection
 * memory exactly as the structured types do.
 *
 * The moat holds on this path too: before anything is stored, the page's
 * VISIBLE text (tags, scripts and styles stripped — page-text.ts) plus the
 * title, summary and declared concept go through the SAME preflight gate every
 * other present_* tool runs (preflightArtifact → artifactProposal "page"). A
 * match is refused with the stored reason, identically.
 *
 * `presentPage` is the one handler: the MCP tool calls it today and the
 * standalone CLI (#679) is meant to call the same function, so both entry
 * points share validation, file reading, the gate and the refusal text.
 */

export interface PresentPageOptions {
  /** The project root a `path` must stay inside. Defaults to the resolved
   *  project root (CLAUDE_PROJECT_DIR → DEEPPAIRING_PROJECT_ROOT → cwd). */
  projectRoot?: string;
}

type PageSource =
  | { ok: true; html: string; sourcePath: string }
  | { ok: false; error: ToolErrorResponse };

function refuse(message: string): { ok: false; error: ToolErrorResponse } {
  const code = TOOL_ERROR_CODES.INPUT_VALIDATION_FAILED;
  return {
    ok: false,
    error: {
      content: [{ type: "text", text: `${code}: present_page refused — ${message} The artifact was NOT created.` }],
      isError: true,
      _meta: { code, retryable: TOOL_ERROR_RETRYABLE[code] },
    },
  };
}

/** Inside `root` (or equal to it — callers reject the root itself separately)? */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Read a page from a file inside the project root. Refuses a path that
 * escapes the root (`../`, an absolute path elsewhere) and a symlink whose
 * target resolves outside it; caps the file at PAGE_HTML_MAX_BYTES before
 * reading. Returns the html and the project-relative (posix) source path.
 */
export function readPageSource(projectRoot: string, requested: string): PageSource {
  if (requested.includes("\0")) return refuse("`path` contains a NUL byte.");
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(projectRoot);
  } catch {
    return refuse("the project root could not be resolved, so `path` cannot be checked. Pass the page inline as `html`.");
  }
  // Lexical check first, so a path outside the project is refused without
  // probing whether it exists.
  const lexical = path.resolve(projectRoot, requested);
  if (!isWithin(projectRoot, lexical) && !isWithin(rootReal, lexical)) {
    return refuse(`\`path\` "${requested}" is outside the project root. Write the page inside the project, or pass it inline as \`html\`.`);
  }
  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    return refuse(`no file at \`path\` "${requested}" (resolved inside the project root).`);
  }
  // Symlink check: the RESOLVED target must also be inside the real root.
  if (!isWithin(rootReal, real)) {
    return refuse(`\`path\` "${requested}" resolves (through a symlink) outside the project root.`);
  }
  // Open once and work from the descriptor. O_NOFOLLOW refuses a symlink
  // swapped in for the FINAL component since the realpath above, and
  // O_NONBLOCK keeps a FIFO from hanging the open (both are absent on
  // Windows, where they are omitted). O_NOFOLLOW does not cover PARENT
  // directories: one swapped for a symlink between the realpath and the open
  // could still redirect it. The re-check after the open narrows that window
  // (the path must still resolve to the same in-root file) but cannot close
  // it entirely without openat-style APIs Node doesn't expose. Acceptable for
  // a local tool reading the agent's own project, where the actor able to race
  // the filesystem already has the same access.
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(real, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0));
  } catch {
    return refuse(`\`path\` "${requested}" could not be opened.`);
  }
  let html: string;
  try {
    let again: string;
    try {
      again = fs.realpathSync(lexical);
    } catch {
      return refuse(`\`path\` "${requested}" changed while it was being read.`);
    }
    if (again !== real || !isWithin(rootReal, again)) {
      return refuse(`\`path\` "${requested}" changed while it was being read.`);
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return refuse(`\`path\` "${requested}" is not a regular file.`);
    if (stat.size > PAGE_HTML_MAX_BYTES) return { ok: false, error: pageTooLargeError("present_page", stat.size) };
    // Read at most cap + 1 bytes, so a file that grew after the fstat is
    // caught without reading all of it.
    const buf = Buffer.alloc(PAGE_HTML_MAX_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const got = fs.readSync(fd, buf, total, buf.length - total, total);
      if (got === 0) break;
      total += got;
    }
    if (total > PAGE_HTML_MAX_BYTES) return { ok: false, error: pageTooLargeError("present_page", total) };
    html = buf.subarray(0, total).toString("utf8");
  } catch {
    return refuse(`\`path\` "${requested}" could not be read.`);
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  if (!html.trim()) return refuse(`the file at \`path\` "${requested}" is empty.`);
  const sourcePath = path.relative(rootReal, real).split(path.sep).join("/");
  return { ok: true, html, sourcePath };
}

/** The reusable present-page handler (MCP today, CLI #679 next). */
export async function presentPage(
  ctx: ToolContext,
  args: Record<string, unknown> | null | undefined,
  opts: PresentPageOptions = {},
): Promise<ToolResult> {
  const validated = validatePresentPageInput(args);
  if (!validated.ok) return validated.error;
  const input = validated.data;

  let html: string;
  let sourcePath: string | undefined;
  if (input.path !== undefined) {
    const source = readPageSource(opts.projectRoot ?? resolveProjectRoot().projectRoot, input.path);
    if (!source.ok) return source.error;
    html = source.html;
    sourcePath = source.sourcePath;
  } else {
    html = input.html ?? "";
  }

  const content: PageContent = {
    title: input.title,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    html,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(input.concept !== undefined ? { concept: input.concept } : {}),
  };

  // The rejection gate — the same path every present_* tool takes. The page
  // projection (artifact-preflight.ts "page") feeds the title, summary, the
  // page's visible text and the declared concept; a match returns the stored
  // reason as REJECTED_APPROACH_BLOCKED and nothing is created.
  const pre = (await preflightArtifact(ctx, "present_page", "page", input.title, content))!;
  if (!pre.ok) return pre.response;

  // N2 — short-window de-dup for an identical, still-draft page. Hash the
  // RESOLVED html, not just the args: re-presenting an edited file under the
  // same `path` is a new page, not a duplicate.
  const dedup = await ctx.helpers.beginPresentIdempotency("present_page", hashPresentArgs({ ...(args ?? {}), html }));
  if (dedup.duplicate) return buildDedupResponse(dedup.duplicate, ctx.store.getLivePort?.() ?? ctx.port);
  const reviewPort = ctx.store.getLivePort?.() ?? ctx.port;

  const id = `art_${nanoid(10)}`;
  let artifact: Awaited<ReturnType<typeof ctx.store.createArtifact>>;
  try {
    // #162 parity — the secret scan runs inside createArtifact; a page can
    // inline config samples like any other prose surface.
    artifact = await ctx.store.createArtifact({
      id,
      type: "page",
      title: input.title,
      content,
      feature: typeof args?.feature === "string" ? args.feature : undefined,
      presentedBy: typeof args?.presentedBy === "string" ? args.presentedBy : undefined,
    });
  } catch (e) {
    dedup.abort?.();
    throw e;
  }
  dedup.commit?.(id);
  const secretMatches = artifact.secretWarnings ?? [];
  await persistPreflightTrace(ctx.store, ctx.broadcast, artifact, "present_page", pre.trace);
  ctx.broadcast({ type: "artifact_created", artifact });
  if (secretMatches.length > 0) {
    ctx.broadcast({
      type: "secret_warning",
      artifactId: artifact.id,
      patterns: secretMatches.map((m) => m.pattern),
      labels: secretMatches.map((m) => m.label),
    });
  }
  notifyResourcesListChanged(ctx.server);
  await maybeEmitTaskHandle(ctx.server, artifact, ctx.store);
  await ctx.helpers.autoNameSession(artifact.title);
  const servedNote = await linkServedRequest(ctx.store, args, artifact.id);

  const traceSummary = formatPreflightTraceSummary(pre.trace);
  const nudge = await revisionNudge(ctx.store, "page", input.title, id);
  const from = sourcePath ? ` from ${sourcePath}` : "";
  // #680 slice 3 — the daemon watches a file-backed page while it is under review.
  const watchNote = sourcePath
    ? ` While it is under review, saving ${sourcePath} records a new version automatically (after ~2s of quiet, at most one per 10s); check_feedback tells you when, and which page comments lost their spot.`
    : "";
  return {
    content: [{
      type: "text",
      text:
        `Page "${artifact.title}" presented for review (${id})${from}. ` +
        `Your pair reviews it at localhost:${reviewPort}, in a sandboxed frame with no network; scripts run only when they click Run. ` +
        `Call check_feedback for their verdict and comments.${watchNote}${servedNote}${traceSummary}${nudge}${formatStyleWarnings(artifact.type, artifact.content)}${await ctx.helpers.getPassiveFeedback()}`,
    }],
  };
}

/** MCP entry point — `handle(ctx, args)` like every other tool. */
export function handlePresentPage(ctx: ToolContext, args: Record<string, unknown> | null | undefined): Promise<ToolResult> {
  return presentPage(ctx, args);
}
