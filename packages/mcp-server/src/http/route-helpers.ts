import type { Context } from "hono";
import { ERROR_CODES } from "../error-codes.js";

export const NO_SESSION_RESPONSE = {
  error: "No active deepPairing session. Start Claude Code with deepPairing configured to create one.",
  code: ERROR_CODES.no_active_session,
};

/** Parse JSON without conflating malformed input with a valid literal null. */
export async function readJsonValue(
  c: Context,
): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const invalid = () =>
    ({ ok: false as const, res: c.json({ error: "invalid JSON", code: ERROR_CODES.validation_error }, 400) });
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return invalid();
  }
  if (raw.trim() === "") return invalid();
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return invalid();
  }
}

export function getSessionId(c: Context): string | undefined {
  return c.req.header("X-Session-Id") ?? undefined;
}
