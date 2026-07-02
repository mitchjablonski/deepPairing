// PP3 — type-only import (erased at build): shiki + its Oniguruma regex engine
// must NOT land in the eager entry bundle. Everything is dynamically imported
// in getHighlighter so the engine code-splits into its own chunk, loaded only
// when the first code block actually renders (like MermaidDiagram).
//
// B5 — fine-grained @shikijs/* imports replace the full `shiki` bundle. The
// full bundle made vite emit EVERY grammar as its own chunk (~300 files,
// ~10 MB of dist) even though highlightLines caps languages to PRELOAD_LANGS
// and falls back to "text" — those chunks were unreachable dead weight in the
// published package. Now only the 13 grammars + 2 themes are emitted.
import type { HighlighterCore } from "@shikijs/core";

let highlighter: HighlighterCore | null = null;
let initPromise: Promise<HighlighterCore> | null = null;

// B5 review — ONE map is the source of truth for both the supported-language
// check and the grammar imports, so the two can't drift (a drift silently
// downgraded that language to plaintext). Each thunk is a dynamic import →
// its own lazy chunk.
const LANG_IMPORTS = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  bash: () => import("@shikijs/langs/bash"),
  yaml: () => import("@shikijs/langs/yaml"),
  markdown: () => import("@shikijs/langs/markdown"),
  sql: () => import("@shikijs/langs/sql"),
  diff: () => import("@shikijs/langs/diff"),
} as const;

const PRELOAD_LANGS = Object.keys(LANG_IMPORTS) as ReadonlyArray<keyof typeof LANG_IMPORTS>;

async function getHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return highlighter;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
      import("@shikijs/core"),
      import("@shikijs/engine-oniguruma"),
    ]);
    return createHighlighterCore({
      themes: [import("@shikijs/themes/vitesse-dark"), import("@shikijs/themes/vitesse-light")],
      langs: Object.values(LANG_IMPORTS).map((load) => load()),
      // B5 review — the wasm comes from the SAME pinned engine package (not the
      // floating `shiki` re-export), so the engine and its wasm can't skew
      // across versions. `shiki` is no longer a dependency at all.
      engine: createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined")),
    });
  })().catch((err) => {
    // PP3 — the lazy chunk can 404 (stale tab after a daemon rebuild). Don't
    // cache the rejected promise: reset so a later render retries instead of
    // highlighting being permanently dead. (A reload prompt also fires via
    // vite:preloadError.)
    initPromise = null;
    throw err;
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
