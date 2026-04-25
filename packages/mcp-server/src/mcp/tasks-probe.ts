/**
 * S6 — MCP Tasks (SEP-1686) capability probe.
 *
 * Today: always false. The @modelcontextprotocol/sdk version we depend on
 * (1.29.x as of 2026-04) does not yet ship the Tasks primitive — there is
 * no `Server#emitTask`, no TaskUpdateNotification, no `tasks/get` request
 * handler. When the SDK lands Tasks (tracked roadmap item for 2026-Q3 per
 * the SEP-1686 discussion), flip MCP_TASKS_ENABLED to `true` and the
 * present_* handlers will emit a TaskHandle alongside the existing text
 * content (legacy clients still get the text path).
 *
 * Why a flag, not a feature detect on `server`: the SDK's type surface
 * will change shape when Tasks lands, and we want the diff that turns
 * this on to be a single `false → true` toggle plus filling in the body
 * of `maybeEmitTaskHandle` — not a sprawl of `if (server.emitTask)`
 * guards across five tool handlers.
 *
 * Pointer: https://github.com/modelcontextprotocol/specification/discussions/1686
 *
 * Until the SDK ships Tasks, the TaskHandle abstraction in
 * packages/shared/src/schemas/task-handle.ts and the converter in
 * task-handles.ts are exercised by tests and available to any
 * consumer that wants the lifecycle view today.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Artifact } from "@deeppairing/shared";
import type { IStore } from "../store/store-interface.js";
import { taskHandleForArtifact } from "./task-handles.js";

export const MCP_TASKS_ENABLED = false as const;

/**
 * Seam for emitting an MCP Task from a present_* tool handler. Today this
 * is a no-op (MCP_TASKS_ENABLED === false). When the SDK ships Tasks, the
 * implementer should:
 *
 *   1. Build the handle: `const handle = await taskHandleForArtifact(artifact, store);`
 *   2. Emit via the SDK call (name TBD — likely `server.emitTask(handle)` or
 *      a notification along the lines of `notifications/tasks/created`).
 *   3. Subsequent status changes (approve/reject/revise) should call
 *      `server.updateTask(...)` from the routes that mutate artifact status.
 *
 * Keeping this helper async so future Tasks emission doesn't change the
 * call sites' shape.
 */
export async function maybeEmitTaskHandle(
  _server: Server,
  _artifact: Artifact,
  _store: IStore,
): Promise<void> {
  if (!MCP_TASKS_ENABLED) return;
  // TODO(2026-Q3, MCP Tasks SDK ships): build the handle and emit it.
  //   const handle = await taskHandleForArtifact(_artifact, _store);
  //   await _server.emitTask(handle);  // exact API TBD per SDK release
  // Reference taskHandleForArtifact so the import isn't pruned by the
  // `MCP_TASKS_ENABLED === false` dead-code branch above.
  void taskHandleForArtifact;
}
