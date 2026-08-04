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
  // R3: the learnings format surfaces the session's rejected approaches.
  // Attach the session memory when the store exposes it.
  if (format === "learnings") {
    if (typeof (ctx.store as any).getSessionMemory === "function") {
      state.sessionMemory = await (ctx.store as any).getSessionMemory();
    }
  }
  const markdown = formatSessionMarkdown(state, format);
  return {
    content: [{ type: "text", text: markdown }],
  };
}
