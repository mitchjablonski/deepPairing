import path from "node:path";
import { formatSessionMarkdown } from "../../export/format-markdown.js";
import { assembleSessionHtml, writeSessionHtml } from "../../export/html-export.js";
import { resolveProjectRoot } from "../../project-root.js";
import { SERVER_VERSION } from "../../version.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function handleExportSession(ctx: ToolContext, args: any): Promise<ToolResult> {
  const format = (args?.format ?? "full") as
    | "full"
    | "pr-description"
    | "pr-comments"
    | "adr"
    | "replay"
    | "learnings"
    | "html";
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

  // Q5 — the shareable page. Unlike the six markdown formats (which return the
  // text for the human to paste), this one WRITES A FILE and returns its path:
  // a whole HTML page in the tool reply would blow the agent's context for no
  // benefit — the artifact here is the file, and the human wants its path.
  if (format === "html") {
    const generatedAt = new Date().toISOString();
    // getFullState already carries sessionMemory (the recorded stances the gate
    // enforces); fetch it explicitly for stores whose full state omits it.
    if (!state.sessionMemory && typeof (ctx.store as any).getSessionMemory === "function") {
      state.sessionMemory = await (ctx.store as any).getSessionMemory();
    }
    const { projectRoot } = resolveProjectRoot();
    const narrative = typeof args?.narrative === "string" ? args.narrative : undefined;
    const audience = typeof args?.audience === "string" ? args.audience : undefined;
    // Default INCLUDE — the diffs are the point. `includeCode: false` is the
    // opt-out for a repo whose code shouldn't leave the building.
    const includeCode = args?.includeCode !== false;
    const html = await assembleSessionHtml(state, {
      store: ctx.store as any,
      narrative,
      audience,
      includeCode,
      projectRoot,
      version: SERVER_VERSION,
      generatedAt,
    });
    const file = writeSessionHtml(projectRoot, state.sessionId, html, generatedAt);
    const relative = path.relative(projectRoot, file) || path.basename(file);
    const kb = Math.max(1, Math.round(Buffer.byteLength(html, "utf-8") / 1024));
    const narrativeNote = narrative
      ? "Your narrative leads the page."
      : "No narrative was supplied, so the page opens with an auto-generated summary — compose one and re-export for a page a stranger can actually follow (see /deeppairing:share).";
    return {
      content: [
        {
          type: "text",
          text:
            `Shareable session page written (${kb} KB, self-contained — no network requests, opens from disk).\n\n` +
            `Path: ${file}\n` +
            `Relative: ${relative}\n\n` +
            `${narrativeNote}${includeCode ? "" : " Code bodies were omitted (includeCode: false)."}\n` +
            `Give the human the path above and tell them they can open it in a browser or send the file to anyone.`,
        },
      ],
    };
  }

  const markdown = formatSessionMarkdown(state, format);
  return {
    content: [{ type: "text", text: markdown }],
  };
}
