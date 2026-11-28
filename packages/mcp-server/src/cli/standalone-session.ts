import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { errorMessage, isClosedArtifactStatus, PAGE_HTML_MAX_BYTES } from "@deeppairing/shared";
import { z } from "zod";
import { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { ERROR_CODES } from "../error-codes.js";
import { MAX_DECISION_WAIT_MS } from "../mcp/tools/decision-feedback.js";
import { createStandaloneSessionId, isStandaloneSessionForProject, isStandaloneSessionId } from "../standalone-session-id.js";
import type { ToolResult } from "../mcp/tools/types.js";
import { readBoundedPageFile } from "./page-file.js";
import type { PageLintWarning } from "../mcp/page-lint.js";
import { readSessionDirectories } from "./session-selection.js";
import { pageRevisionFeedbackIdsSchema } from "../store/page-revision-feedback.js";

const SESSION_REQUEST_TIMEOUT_MS = 5_000;
const PRESENT_OPTIONS_USAGE = "Usage: deeppairing present options --session-id ID --request-id UUID --file options.json";
const PRESENT_PAGE_USAGE = "Usage: deeppairing present page --session-id ID --request-id UUID (--file page.html | --path page-inside-project.html) --title T [--summary S] [--concept C]";
const PRESENT_USAGE = `${PRESENT_OPTIONS_USAGE}\n       ${PRESENT_PAGE_USAGE.replace(/^Usage: /, "")}`;
const READ_DECISION_USAGE = "Usage: deeppairing read-decision --session-id ID --decision-id ID [--wait-ms MS]";
const READ_PAGE_FEEDBACK_USAGE = "Usage: deeppairing read-page-feedback --session-id ID --artifact-id ID";
const REVISE_PAGE_USAGE = "Usage: deeppairing revise-page --session-id ID --artifact-id ID --request-id UUID --file page.html --reason TEXT [--ack-comment-id ID ...]";
const PRESENT_OPTIONS_RETRY = "Reuse the request ID for unchanged input. Use a new UUID if you change the input.";
const requestIdSchema = z.string().uuid().transform((id) => id.toLowerCase());

export type PresentPageReceipt = { sessionId: string; requestId: string } & (
  | {
    artifactId: string; companionUrl: string; sourcePath?: string; replayed?: true;
    status?: string; currentArtifactId?: string; currentVersion?: number; currentStatus?: string; note?: string;
    /** #714 gap 6 — non-blocking authoring lint from the present. */
    warnings?: PageLintWarning[]; isError?: never;
  }
  | { isError: true; code: string; reason?: string; message: string }
);

type PresentOptionsReceipt = { sessionId: string; requestId: string } & (
  | { artifactId: string; decisionId: string; companionUrl: string; replayed?: true; isError?: never }
  | { isError: true; code: string; reason?: string; message: string }
);

function requireStandaloneSession(projectRoot: string, sessionId: string): void {
  if (!isStandaloneSessionId(sessionId)) throw new Error("Use a standalone session ID returned by deeppairing open.");
  if (!isStandaloneSessionForProject(sessionId, projectRoot) || !readSessionDirectories(projectRoot).includes(sessionId)) {
    throw new Error("No standalone session with that ID exists in this project.");
  }
}

async function connectStandaloneSession(projectRoot: string, sessionId: string) {
  const { port, authToken } = await ensureDaemon(projectRoot);
  if (!authToken) throw new Error("The project's daemon did not advertise an authentication token. Run deeppairing doctor.");
  const client = new DaemonClient(port, sessionId, projectRoot, authToken);
  const companionUrl = `http://localhost:${port}/?session=${encodeURIComponent(sessionId)}`;
  return { client, companionUrl };
}

export async function standaloneSession(
  projectRoot: string,
  command: "open" | "resume",
  args: string[],
): Promise<{ sessionId: string; companionUrl: string; endedAt?: string }> {
  let sessionId: string;
  if (command === "resume") {
    if (args.length !== 1) throw new Error("Usage: deeppairing resume <standalone-session-id>");
    sessionId = args[0]!;
    requireStandaloneSession(projectRoot, sessionId);
  } else {
    if (args.length !== 0) throw new Error("Usage: deeppairing open");
    sessionId = createStandaloneSessionId(projectRoot);
  }

  const { client, companionUrl } = await connectStandaloneSession(projectRoot, sessionId);
  try {
    const { endedAt } = await client.openStandaloneReview(command, projectRoot, AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS));
    if (endedAt) {
      const historyUrl = new URL(companionUrl);
      historyUrl.search = "";
      historyUrl.searchParams.set("history", sessionId);
      return { sessionId, companionUrl: historyUrl.href, endedAt };
    }
  } catch (err) {
    const recovery = command === "open" ? ` If the request reached the daemon, recover with 'deeppairing resume ${sessionId}'.` : "";
    throw new Error(`${errorMessage(err)}${recovery}`);
  }
  return { sessionId, companionUrl };
}

export async function standaloneReadDecision(projectRoot: string, args: string[]) {
  const { values } = parseArgs({
    args,
    options: { "session-id": { type: "string" }, "decision-id": { type: "string" }, "wait-ms": { type: "string" } },
  });
  const { "session-id": sessionId, "decision-id": decisionId, "wait-ms": requestedWait } = values;
  if (!sessionId || !decisionId?.trim()) throw new Error(READ_DECISION_USAGE);
  let waitMs: number | undefined;
  if (requestedWait !== undefined) {
    waitMs = Number(requestedWait);
    if (!/^\d+$/.test(requestedWait) || waitMs < 1 || waitMs > MAX_DECISION_WAIT_MS) {
      throw new Error("--wait-ms must be a whole number from 1 to 30000.");
    }
  }
  requireStandaloneSession(projectRoot, sessionId);
  const { client } = await connectStandaloneSession(projectRoot, sessionId);
  return client.readStandaloneDecision(projectRoot, decisionId,
    AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS + (waitMs ?? 0)), waitMs);
}

export async function standaloneReadPageFeedback(projectRoot: string, args: string[]) {
  const { values } = parseArgs({
    args,
    options: { "session-id": { type: "string" }, "artifact-id": { type: "string" } },
  });
  const { "session-id": sessionId, "artifact-id": artifactId } = values;
  if (!sessionId || !artifactId?.trim()) throw new Error(READ_PAGE_FEEDBACK_USAGE);
  requireStandaloneSession(projectRoot, sessionId);
  const { client } = await connectStandaloneSession(projectRoot, sessionId);
  return client.readStandalonePageFeedback(projectRoot, artifactId, AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS));
}

export async function standaloneRevisePage(projectRoot: string, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "session-id": { type: "string" }, "artifact-id": { type: "string" },
      "request-id": { type: "string" }, file: { type: "string" }, reason: { type: "string" },
      "ack-comment-id": { type: "string", multiple: true },
    },
  });
  const { "session-id": sessionId, "artifact-id": artifactId, "request-id": rawRequestId, file, reason } = values;
  if (!sessionId || !artifactId?.trim() || !rawRequestId || !file || !reason?.trim()) throw new Error(REVISE_PAGE_USAGE);
  requireStandaloneSession(projectRoot, sessionId);
  const requestId = requestIdSchema.safeParse(rawRequestId);
  if (!requestId.success) throw new Error(`--request-id must be a UUID. ${PRESENT_OPTIONS_RETRY}`);
  const requestedIds = values["ack-comment-id"];
  const acknowledgement = pageRevisionFeedbackIdsSchema.optional().safeParse(requestedIds);
  if (!acknowledgement.success) throw new Error("--ack-comment-id accepts up to 50 unique comment IDs, each 1–128 characters.");

  const receipt = { sessionId, requestId: requestId.data };
  const read = readBoundedPageFile(file, PAGE_HTML_MAX_BYTES);
  if (!read.ok) {
    return {
      ...receipt, isError: true, code: ERROR_CODES.body_too_large,
      message: `The page file is at least ${read.size} bytes, over the ${PAGE_HTML_MAX_BYTES}-byte page cap. Trim it, and use a new request ID for the changed input.`,
    };
  }
  if (!read.bytes.toString("utf8").trim()) throw new Error("The page file is empty.");
  const { client, companionUrl } = await connectStandaloneSession(projectRoot, sessionId);
  let result;
  try {
    result = await client.reviseStandalonePage(projectRoot, requestId.data, artifactId.trim(), read.bytes.toString("base64"),
      reason.trim(), AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS), acknowledgement.data);
  } catch (err) {
    if (err instanceof Error && "status" in err && err.status === 413) {
      return { ...receipt, isError: true, code: ERROR_CODES.body_too_large, message: errorMessage(err).replace(/^\[deepPairing\] /, "") };
    }
    throw new Error(`${errorMessage(err)} If retrying, use the same --request-id and revision input.`);
  }
  const details = result.structuredContent ?? {};
  if (result.isError) {
    return {
      ...receipt, ...details, isError: true,
      code: details.code ?? result._meta?.code ?? ERROR_CODES.validation_error,
      message: result.content[0]?.text ?? "The daemon refused the page revision.",
    };
  }
  if (details.sessionId !== sessionId || details.parentArtifactId !== artifactId.trim() ||
    typeof details.artifactId !== "string" || typeof details.version !== "number" ||
    (acknowledgement.data && JSON.stringify(details.acknowledgedCommentIds) !== JSON.stringify([...acknowledgement.data].sort()))) {
    throw new Error("The daemon did not confirm the page revision. If retrying, use the same --request-id and revision input.");
  }
  return { ...details, ...receipt, companionUrl, isError: undefined };
}

export async function standalonePresent(projectRoot: string, args: string[]): Promise<PresentOptionsReceipt | PresentPageReceipt> {
  if (args[0] === "page") return standalonePresentPage(projectRoot, args.slice(1));
  if (args[0] !== "options") throw new Error(PRESENT_USAGE);
  const { values } = parseArgs({
    args: args.slice(1),
    options: { "session-id": { type: "string" }, "request-id": { type: "string" }, file: { type: "string" } },
  });
  const { "session-id": sessionId, "request-id": rawRequestId, file } = values;
  if (!sessionId || !rawRequestId || !file) throw new Error(PRESENT_OPTIONS_USAGE);
  requireStandaloneSession(projectRoot, sessionId);
  const requestId = requestIdSchema.safeParse(rawRequestId);
  if (!requestId.success) throw new Error(`--request-id must be a UUID. ${PRESENT_OPTIONS_RETRY}`);

  const json = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    throw new Error("The options file must contain valid JSON.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The options file must contain a JSON object.");

  const { client, companionUrl } = await connectStandaloneSession(projectRoot, sessionId);
  let result;
  try {
    result = await client.presentStandaloneOptions(projectRoot, requestId.data, input as Record<string, unknown>, AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS));
  } catch (err) {
    throw new Error(`${errorMessage(err)} If retrying, use the same --request-id and options input.`);
  }
  const receipt = { sessionId, requestId: requestId.data };
  if (result.isError) {
    const { code: structuredCode, reason } = result.structuredContent ?? {};
    const metaCode = result._meta?.code;
    const code = typeof structuredCode === "string" ? structuredCode : typeof metaCode === "string" ? metaCode : "present_options_refused";
    const message = result.content[0]?.text ?? "The daemon refused the options proposal.";
    return {
      ...receipt,
      isError: true,
      code,
      ...(typeof reason === "string" ? { reason } : {}),
      message: code === ERROR_CODES.standalone_operation_conflict ? message : `${message} ${PRESENT_OPTIONS_RETRY}`,
    };
  }
  const { artifactId, decisionId, replayed } = result.structuredContent ?? {};
  if (typeof artifactId !== "string" || typeof decisionId !== "string") throw new Error("The daemon did not confirm the options presentation. If retrying, use the same --request-id and options input.");
  return { ...receipt, artifactId, decisionId, companionUrl, ...(replayed === true ? { replayed: true as const } : {}) };
}

/**
 * Resolve `--path` against the CLI's cwd and express it relative to the
 * project root (the daemon accepts only project-relative paths and re-checks
 * containment itself). Refuses a path that lands outside the root.
 */
function projectRelativePath(projectRoot: string, requested: string): string {
  if (!requested) throw new Error(PRESENT_PAGE_USAGE);
  const target = path.resolve(process.cwd(), requested);
  const inside = (root: string) => {
    const rel = path.relative(root, target);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : undefined;
  };
  let rel = inside(projectRoot);
  if (rel === undefined) {
    try { rel = inside(realpathSync(projectRoot)); } catch { /* keep the lexical answer */ }
  }
  if (rel === undefined) {
    throw new Error(`--path ${requested} is outside the project root (${projectRoot}). Use --file to present a page from elsewhere.`);
  }
  return rel.split(path.sep).join("/");
}

/**
 * #679/#680 — present an HTML page without MCP. `--file` sends the page inline
 * (any readable file; not watched). `--path` names a file inside the project:
 * the daemon reads it through presentPage's own contained reader, and the page
 * is file-backed, so later saves record new versions while it is under review.
 */
async function standalonePresentPage(projectRoot: string, args: string[]): Promise<PresentPageReceipt> {
  const { values } = parseArgs({
    args,
    options: {
      "session-id": { type: "string" }, "request-id": { type: "string" },
      file: { type: "string" }, path: { type: "string" },
      title: { type: "string" }, summary: { type: "string" }, concept: { type: "string" },
    },
  });
  const { "session-id": sessionId, "request-id": rawRequestId, file, path: pagePath, title, summary, concept } = values;
  if (!sessionId || !rawRequestId || !title?.trim() || (file === undefined) === (pagePath === undefined)) {
    throw new Error(PRESENT_PAGE_USAGE);
  }
  requireStandaloneSession(projectRoot, sessionId);
  const requestId = requestIdSchema.safeParse(rawRequestId);
  if (!requestId.success) throw new Error(`--request-id must be a UUID. ${PRESENT_OPTIONS_RETRY}`);

  const receipt = { sessionId, requestId: requestId.data };
  const meta = { title, ...(summary !== undefined ? { summary } : {}), ...(concept !== undefined ? { concept } : {}) };
  let page: { htmlBase64: string } | { path: string };
  if (file !== undefined) {
    const read = readBoundedPageFile(file, PAGE_HTML_MAX_BYTES);
    if (!read.ok) {
      return {
        ...receipt, isError: true, code: ERROR_CODES.body_too_large,
        message: `The page file is at least ${read.size} bytes, over the ${PAGE_HTML_MAX_BYTES}-byte page cap. Trim it, and use a new request ID for the changed input.`,
      };
    }
    if (!read.bytes.toString("utf8").trim()) throw new Error("The page file is empty.");
    page = { htmlBase64: read.bytes.toString("base64") };
  } else {
    page = { path: projectRelativePath(projectRoot, pagePath ?? "") };
  }

  const { client, companionUrl } = await connectStandaloneSession(projectRoot, sessionId);
  let result;
  try {
    result = await client.presentStandalonePage(projectRoot, requestId.data, { ...meta, ...page }, AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS));
  } catch (err) {
    if (err instanceof Error && "status" in err && err.status === 413) {
      return { ...receipt, isError: true, code: ERROR_CODES.body_too_large, message: errorMessage(err).replace(/^\[deepPairing\] /, "") };
    }
    throw new Error(`${errorMessage(err)} If retrying, use the same --request-id and page input.`);
  }
  return pageReceiptFromResult(receipt, companionUrl, result);
}

/**
 * Map the daemon's present-page tool result to the CLI's JSON receipt
 * (exported for tests: the CLI layer has no process-level unit harness).
 */
export function pageReceiptFromResult(
  receipt: { sessionId: string; requestId: string },
  companionUrl: string,
  result: ToolResult,
): PresentPageReceipt {
  if (result.isError) {
    const { code: structuredCode, reason } = result.structuredContent ?? {};
    const metaCode = result._meta?.code;
    const code = typeof structuredCode === "string" ? structuredCode : typeof metaCode === "string" ? metaCode : "present_page_refused";
    const message = result.content[0]?.text ?? "The daemon refused the page.";
    return {
      ...receipt,
      isError: true,
      code,
      ...(typeof reason === "string" ? { reason } : {}),
      message: code === ERROR_CODES.standalone_operation_conflict ? message : `${message} ${PRESENT_OPTIONS_RETRY}`,
    };
  }
  const { artifactId, sourcePath, replayed, status, currentArtifactId, currentVersion, currentStatus, warnings } = result.structuredContent ?? {};
  if (typeof artifactId !== "string") throw new Error("The daemon did not confirm the page presentation. If retrying, use the same --request-id and page input.");
  const moved = typeof currentArtifactId === "string" && typeof currentVersion === "number";
  return {
    ...receipt, artifactId, companionUrl,
    ...(typeof sourcePath === "string" ? { sourcePath } : {}),
    ...(replayed === true ? { replayed: true as const } : {}),
    ...(Array.isArray(warnings) && warnings.length > 0 ? { warnings: warnings as PageLintWarning[] } : {}),
    ...(typeof status === "string" ? { status } : {}),
    ...(moved ? { currentArtifactId, currentVersion, ...(typeof currentStatus === "string" ? { currentStatus } : {}) } : {}),
    ...(replayed === true && moved && currentArtifactId !== artifactId
      ? { note: `replayed; the page has since moved to v${currentVersion} (${currentArtifactId})` }
      : replayed === true && typeof status === "string" && isClosedArtifactStatus(status)
        ? { note: `replayed; the page is ${status}` }
        : {}),
  };
}
