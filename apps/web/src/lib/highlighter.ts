import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

const PRELOAD_LANGS = [
  "typescript",
  "javascript",
  "json",
  "css",
  "html",
  "python",
  "rust",
  "go",
  "bash",
  "yaml",
  "markdown",
  "sql",
  "diff",
] as const;

async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (initPromise) return initPromise;

  initPromise = createHighlighter({
    themes: ["vitesse-dark", "vitesse-light"],
    langs: [...PRELOAD_LANGS],
  });

  highlighter = await initPromise;
  return highlighter;
}

/**
 * Highlight code and return an array of HTML strings, one per line.
 * Returns null while loading.
 */
export async function highlightLines(
  code: string,
  lang: string,
  theme: "vitesse-dark" | "vitesse-light" = "vitesse-dark",
): Promise<string[]> {
  const h = await getHighlighter();

  const resolvedLang = PRELOAD_LANGS.includes(lang as any) ? lang : "text";

  const tokens = h.codeToTokens(code, {
    lang: resolvedLang as any,
    theme,
  });

  return tokens.tokens.map((lineTokens) =>
    lineTokens
      .map((token) => {
        const style = token.color ? `color:${token.color}` : "";
        const escaped = token.content
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return style ? `<span style="${style}">${escaped}</span>` : escaped;
      })
      .join(""),
  );
}

const EXT_MAP: Record<string, string> = {
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
  bash: "bash",
  yaml: "yaml",
  yml: "yaml",
  diff: "diff",
};

export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? "text";
}
