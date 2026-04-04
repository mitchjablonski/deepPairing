import type { AgentEvent } from "@deeppairing/shared";

interface CachedFile {
  path: string;
  content: string;
  language: string;
  capturedAt: string;
}

/**
 * Captures file contents from Read tool results during a session.
 * When the agent reads a file, we cache the content so the human
 * can browse the full file — not just the snippet in the evidence.
 */
export class FileCache {
  private files = new Map<string, CachedFile>();

  /**
   * Process an agent event. If it's a Read tool result, cache the content.
   */
  processEvent(event: AgentEvent): void {
    if (event.type === "tool_result" && event.tool === "Read") {
      const path = this.extractFilePath(event);
      if (path && event.output) {
        this.files.set(path, {
          path,
          content: event.output,
          language: this.detectLanguage(path),
          capturedAt: new Date().toISOString(),
        });
      }
    }

    // Also capture from tool_call to get the file path for correlation
    if (event.type === "tool_call" && event.tool === "Read" && event.input) {
      const filePath = (event.input as any).file_path;
      if (filePath) {
        // Store a placeholder keyed by toolCallId for later correlation
        this.pendingReads.set(event.toolCallId, filePath);
      }
    }
  }

  private pendingReads = new Map<string, string>();

  private extractFilePath(event: AgentEvent & { type: "tool_result" }): string | null {
    // Try to get path from the pending reads map
    const pending = this.pendingReads.get(event.toolCallId);
    if (pending) {
      this.pendingReads.delete(event.toolCallId);
      return pending;
    }

    // Fallback: try to extract from the output (line-numbered content typically starts with "1\t")
    // This is fragile, so we prefer the toolCallId correlation above
    return null;
  }

  private detectLanguage(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const langMap: Record<string, string> = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      py: "python",
      rs: "rust",
      go: "go",
      rb: "ruby",
      java: "java",
      css: "css",
      html: "html",
      json: "json",
      md: "markdown",
      sql: "sql",
      sh: "bash",
      yaml: "yaml",
      yml: "yaml",
    };
    return langMap[ext] ?? "text";
  }

  getFile(path: string): CachedFile | undefined {
    return this.files.get(path);
  }

  getAllPaths(): string[] {
    return Array.from(this.files.keys());
  }

  /**
   * Get file content with specific lines highlighted.
   * Returns the full content plus metadata about which lines to highlight.
   */
  getFileWithHighlight(
    path: string,
    highlightStart: number,
    highlightEnd: number,
  ): { content: string; language: string; highlightStart: number; highlightEnd: number } | null {
    const file = this.files.get(path);
    if (!file) return null;

    return {
      content: file.content,
      language: file.language,
      highlightStart,
      highlightEnd,
    };
  }
}
