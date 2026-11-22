import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { errorMessage } from "@deeppairing/shared";
import { z } from "zod";
import { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { ERROR_CODES } from "../error-codes.js";
import { createStandaloneSessionId, isStandaloneSessionForProject, isStandaloneSessionId } from "../standalone-session-id.js";
import { readSessionDirectories } from "./session-selection.js";

const SESSION_REQUEST_TIMEOUT_MS = 5_000;
const PRESENT_OPTIONS_USAGE = "Usage: deeppairing present options --session-id ID --request-id UUID --file options.json";
const PRESENT_OPTIONS_RETRY = "Reuse the request ID for unchanged input. Use a new UUID if you change the input.";
const requestIdSchema = z.string().uuid().transform((id) => id.toLowerCase());

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
): Promise<{ sessionId: string; companionUrl: string }> {
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
    await client.openStandaloneReview(command, projectRoot, AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS));
  } catch (err) {
    const recovery = command === "open" ? ` If the request reached the daemon, recover with 'deeppairing resume ${sessionId}'.` : "";
    throw new Error(`${errorMessage(err)}${recovery}`);
  }
  return { sessionId, companionUrl };
}

export async function standalonePresent(projectRoot: string, args: string[]): Promise<PresentOptionsReceipt> {
  if (args[0] !== "options") throw new Error(PRESENT_OPTIONS_USAGE);
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
