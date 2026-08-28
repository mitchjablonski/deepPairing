/**
 * Structural helpers for reading fields off a caught error whose static type is
 * `unknown` (the default for `catch` variables under `useUnknownInCatchVariables`).
 *
 * These read the property STRUCTURALLY rather than via `instanceof`, so they
 * behave identically to the historical `err?.message` / `err?.code` /
 * `err?.name` access these replaced — including for non-`Error` throws (plain
 * objects, DOMException-shaped AbortError/TimeoutError, etc.). No behavior
 * change: they exist purely to let call sites drop the `any` annotation.
 */

/**
 * Read a string `.message` off a caught value. When absent, returns `fallback`
 * if given, else `String(err)` — matching `err?.message ?? String(err)` (no
 * fallback) and `err?.message ?? "literal"` (with fallback) call sites.
 */
export function errorMessage(err: unknown, fallback?: string): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback ?? String(err);
}

/** Read a `.code` (Node `ErrnoException` shape), or `undefined` when absent. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Read a `.name` (e.g. "AbortError" / "TimeoutError"), or `undefined` when absent. */
export function errorName(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}
