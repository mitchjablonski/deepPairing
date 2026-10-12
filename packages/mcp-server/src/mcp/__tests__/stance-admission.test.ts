/**
 * #499 review P2 — the §6 step-0 probe only lets a tool continue on a
 * DEFINITIVE "no operation" (or a daemon too old to have the route). A fake
 * store stands in for DaemonClient's thrown errors (fakes, not mocks).
 */
import { describe, expect, it } from "vitest";
import { beginStanceOperation } from "../stance-admission.js";
import type { ToolContext } from "../tools/types.js";

const httpError = (status: number, code?: string) => Object.assign(new Error(`[deepPairing] request failed (${status})`), { status, ...(code ? { code } : {}) });
const ctxWith = (run: () => Promise<Record<string, unknown>>) => ({ store: { runStanceOperation: run } } as unknown as ToolContext);

describe("beginStanceOperation", () => {
  it("continues on a definitive none, and on an older daemon's bare 404", async () => {
    expect((await beginStanceOperation(ctxWith(async () => ({ status: "none" })), "present_options", {})).refusal).toBeUndefined();
    expect((await beginStanceOperation(ctxWith(async () => { throw httpError(404); }), "present_options", {})).refusal).toBeUndefined();
  });

  it("refuses (retryable) on a server or transport failure — never a silent fall-through", async () => {
    for (const err of [httpError(500), httpError(503, "lock_busy"), new Error("daemon connection lost"), httpError(404, "session_not_registered")]) {
      const out = await beginStanceOperation(ctxWith(async () => { throw err; }), "present_options", {});
      expect(out.refusal?.isError).toBe(true);
      expect((out.refusal as { _meta?: { retryable?: boolean } })._meta?.retryable).toBe(true);
    }
  });

  it("refuses (not retryable) on an inconsistent stamp", async () => {
    const out = await beginStanceOperation(ctxWith(async () => { throw httpError(409, "stance_exception_operation_inconsistent"); }), "present_options", {});
    expect((out.refusal as { _meta?: { retryable?: boolean } })._meta?.retryable).toBe(false);
  });

  it("a store without the operation route (non-daemon) just continues", async () => {
    expect((await beginStanceOperation({ store: {} } as unknown as ToolContext, "present_options", {})).refusal).toBeUndefined();
  });
});
