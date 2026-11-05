import { formatRecordStanceOutcome, parseStanceArguments, recordStance } from "../../store/stance-add.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * #620 — `record_stance`: the MCP door behind `/deeppairing:reject`, for
 * plugin installs that have no `deeppairing` binary. The logic (parse,
 * validate, recovery guard, add-only write) is store/stance-add.ts, shared
 * with `deeppairing stance add`.
 *
 * The tool takes the human's words VERBATIM (`text: "<what> -- <why>"`) and
 * parses them server-side, so the agent passes the request through rather
 * than composing a stance. It accepts only `requestedBy: "user"`: there is no
 * agent-initiated mode. That is a contract stated to the agent, not a proof —
 * see the module header in stance-add.ts.
 */
export const RECORD_STANCE_DESCRIPTION =
  "Record a project stance the HUMAN explicitly asked for, in their own words (normally via /deeppairing:reject). " +
  "Pass their text VERBATIM as `text`: \"<what to avoid> -- <why>\". Do not paraphrase, shorten or fix it, and do not split it yourself. " +
  "NEVER call this on your own initiative, and never to turn your own, a reviewer's, or a tool's prose into a stance. Only when the human asked you to record this exact stance. " +
  "Add-only: it cannot remove, retire, or change an existing stance. " +
  "The stance is project-local and matched by words, not meaning: a later present_* proposal containing it is refused with the reason quoted, and a matching Edit/Write asks the human. " +
  "Show the human the reply verbatim (what was saved, its scope, and what it will and won't catch).";

export async function handleRecordStance(ctx: ToolContext, args: any): Promise<ToolResult> {
  if (args?.requestedBy !== "user") {
    return {
      content: [{ type: "text", text: "record_stance: nothing was recorded. This tool records only a stance the human explicitly asked for (requestedBy: \"user\"), in their words. Ask them, or tell them about /deeppairing:reject." }],
      isError: true,
    };
  }
  if (typeof args?.text !== "string") {
    return {
      content: [{ type: "text", text: "record_stance: nothing was recorded. `text` is required: the human's words, verbatim, as \"<what to avoid> -- <why>\"." }],
      isError: true,
    };
  }
  const { what, why } = parseStanceArguments(args.text);
  const outcome = await recordStance(ctx.store, { what, why, addedVia: "mcp", requestedBy: "user" });
  const { ok, text } = formatRecordStanceOutcome(outcome, "This project");
  return ok ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text: `record_stance: ${text}` }], isError: true };
}
