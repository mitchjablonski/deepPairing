/**
 * X4 — MCP elicitation primitives, lifted out of server.ts so the helper
 * + handler modules can import them without a circular dep through server.ts.
 *
 * Two exports:
 * - ELICIT_APPROVE_SCHEMA: the structured-input schema we send to the
 *   client when we want a quick "approve here vs. review in the UI" check.
 *   Single boolean property, no required fields — the absence of `approve`
 *   means "go review."
 * - decideElicitResponse: pure decision-from-result helper, exported so
 *   unit tests can pin the contract without spinning up an SDK transport.
 */
export const ELICIT_APPROVE_SCHEMA = {
  type: "object" as const,
  properties: {
    approve: {
      type: "boolean" as const,
      description: "Set true to approve here. Leave unset / false to review in the companion UI.",
      default: false,
    },
  },
  required: [],
};

/**
 * Truth table:
 *   action=accept,  content.approve === true       → "approve"
 *   action=accept,  content.approve absent/false   → "review"
 *   action=decline                                 → "review"
 *   action=cancel                                  → "review"
 *   anything else                                  → null
 */
export function decideElicitResponse(
  result: { action?: string; content?: unknown } | null | undefined,
): "approve" | "review" | null {
  if (!result) return null;
  if (result.action === "accept") {
    const approved = (result.content as any)?.approve === true;
    return approved ? "approve" : "review";
  }
  if (result.action === "decline" || result.action === "cancel") return "review";
  return null;
}
