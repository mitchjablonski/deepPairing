import { errorMessage } from "@deeppairing/shared";
import { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { createStandaloneSessionId, isStandaloneSessionForProject, isStandaloneSessionId } from "../standalone-session-id.js";
import { readSessionDirectories } from "./session-selection.js";

const SESSION_REQUEST_TIMEOUT_MS = 5_000;

export async function standaloneSession(
  projectRoot: string,
  command: "open" | "resume",
  args: string[],
): Promise<{ sessionId: string; companionUrl: string }> {
  let sessionId: string;
  if (command === "resume") {
    if (args.length !== 1) throw new Error("Usage: deeppairing resume <standalone-session-id>");
    sessionId = args[0]!;
    if (!isStandaloneSessionId(sessionId)) throw new Error("Use a standalone session ID returned by deeppairing open.");
    if (!isStandaloneSessionForProject(sessionId, projectRoot) || !readSessionDirectories(projectRoot).includes(sessionId)) {
      throw new Error("No standalone session with that ID exists in this project.");
    }
  } else {
    if (args.length !== 0) throw new Error("Usage: deeppairing open");
    sessionId = createStandaloneSessionId(projectRoot);
  }

  const { port, authToken } = await ensureDaemon(projectRoot);
  if (!authToken) throw new Error("The project's daemon did not advertise an authentication token. Run deeppairing doctor.");
  const client = new DaemonClient(port, sessionId, projectRoot, authToken);
  try {
    await client.openStandaloneReview(command, projectRoot, AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS));
  } catch (err) {
    const recovery = command === "open" ? ` If the request reached the daemon, recover with 'deeppairing resume ${sessionId}'.` : "";
    throw new Error(`${errorMessage(err)}${recovery}`);
  }
  return { sessionId, companionUrl: `http://localhost:${port}/?session=${encodeURIComponent(sessionId)}` };
}
