import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// E4 — vite is EXACT-PINNED to 8.0.3 in package.json: 8.1.x changed the
// chunking heuristics and hoisted the lazy renderers' shared dependency
// (zod + @deeppairing/shared) back into the ENTRY chunk — +29kB gz,
// giving back half of D6's code-split win (449/133 → 555/162). Before
// re-bumping, verify `ZodError` stays OUT of dist/web/assets/index-*.js
// and the entry stays ~135kB gz (or add manualChunks to force the split).

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      // #714 gap 11 — a second page: the isolated Mermaid renderer frame for
      // agent pages (served by the daemon with a strict CSP, no token). It
      // imports mermaid, which the app already code-splits, so the chunk is
      // shared rather than duplicated.
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        "mermaid-renderer": fileURLToPath(new URL("./mermaid-renderer.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 3848, // Dev server — production uses the MCP server's HTTP on 3847
    proxy: {
      "/api": "http://localhost:3847",
      "/ws": {
        target: "ws://localhost:3847",
        ws: true,
      },
    },
  },
});
