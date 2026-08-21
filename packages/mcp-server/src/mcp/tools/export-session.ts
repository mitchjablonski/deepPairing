import path from "node:path";
import { formatSessionMarkdown } from "../../export/format-markdown.js";
import {
  assembleSessionHtml,
  scanExportForSecrets,
  secretCountOf,
  secretLabelsOf,
  secretWarningFor,
  writeSessionHtml,
} from "../../export/html-export.js";
import { resolveProjectRoot } from "../../project-root.js";
import { SERVER_VERSION } from "../../version.js";
import type { ToolContext, ToolResult } from "./types.js";

/** The optional store methods this tool reads, named once instead of cast at
 *  every call site. Both are absent on read-only/fake stores. */
interface ExportCapableStore {
  getAnnotations?(): unknown;
  getSessionMemory?(): unknown;
}

export async function handleExportSession(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const store = ctx.store as unknown as ExportCapableStore;
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
  if (format === "replay" && typeof store.getAnnotations === "function") {
    state.annotations = await store.getAnnotations();
  }
  // R3: the learnings format surfaces the session's rejected approaches.
  // Attach the session memory when the store exposes it.
  if (format === "learnings") {
    if (typeof store.getSessionMemory === "function") {
      state.sessionMemory = await store.getSessionMemory();
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
    if (!state.sessionMemory && typeof store.getSessionMemory === "function") {
      state.sessionMemory = await store.getSessionMemory();
    }
    const { projectRoot } = resolveProjectRoot();
    const narrative = typeof args?.narrative === "string" ? args.narrative : undefined;
    const audience = typeof args?.audience === "string" ? args.audience : undefined;
    // Default INCLUDE — the diffs are the point. `includeCode: false` is the
    // opt-out for a repo whose code shouldn't leave the building.
    const includeCode = args?.includeCode !== false;
    // F6/R3 — warn-only secret check on what is about to leave the building.
    // Scanned ONCE, here: the labels ride onto the page as its banner and the
    // sentence goes back to the agent, so the two can never disagree about what
    // was found. The narrative is included because it is composed at export
    // time — no artifact holds it, so no create-time scan has ever seen it.
    const secretMatches = scanExportForSecrets(state, { narrative });
    const html = await assembleSessionHtml(state, {
      store: ctx.store as any,
      narrative,
      audience,
      includeCode,
      projectRoot,
      version: SERVER_VERSION,
      generatedAt,
      secretLabels: secretLabelsOf(secretMatches),
      secretCount: secretCountOf(secretMatches),
    });
    const file = writeSessionHtml(projectRoot, state.sessionId, html, generatedAt);
    const relative = path.relative(projectRoot, file) || path.basename(file);
    const kb = Math.max(1, Math.round(Buffer.byteLength(html, "utf-8") / 1024));
    const narrativeNote = narrative
      ? "Your narrative leads the page."
      : "No narrative was supplied, so the page opens with an auto-generated summary — compose one and re-export for a page a stranger can actually follow (see /deeppairing:share).";
    const secretWarning = secretMatches.length ? secretWarningFor(state, { narrative }) : null;
    return {
      content: [
        {
          type: "text",
          text:
            `Shareable session page written (${kb} KB, self-contained — no network requests, opens from disk).\n\n` +
            `Path: ${file}\n` +
            `Relative: ${relative}\n\n` +
            `${narrativeNote}${includeCode ? "" : " Code bodies were omitted (includeCode: false)."}\n` +
            (secretWarning
              ? `\n${secretWarning}\nThe page itself carries the same warning as a banner, so they will see it when they open the file.\nTell the human this before they send it.\n`
              : "") +
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
