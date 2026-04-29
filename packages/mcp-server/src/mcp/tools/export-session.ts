import { formatSessionMarkdown } from "../../export/format-markdown.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handleExportSession(ctx: ToolContext, args: any): Promise<ToolResult> {
  const format = (args?.format ?? "full") as
    | "full"
    | "pr-description"
    | "pr-comments"
    | "adr"
    | "replay"
    | "learnings";
  const state: any = await ctx.store.getFullState();
  // Include learner annotations when exporting as replay.
  if (format === "replay" && typeof (ctx.store as any).getAnnotations === "function") {
    state.annotations = await (ctx.store as any).getAnnotations();
  }
  // R3: the learnings format cross-references retrospectives. Attach the
  // session memory (rejected approaches) and retrospectives when the
  // store exposes them.
  if (format === "learnings") {
    if (typeof (ctx.store as any).getSessionMemory === "function") {
      state.sessionMemory = await (ctx.store as any).getSessionMemory();
    }
    if (typeof (ctx.store as any).getRetrospectives === "function") {
      state.retrospectives = await (ctx.store as any).getRetrospectives();
    }
  }
  const markdown = formatSessionMarkdown(state, format);
  return {
    content: [{ type: "text", text: markdown }],
  };
}
