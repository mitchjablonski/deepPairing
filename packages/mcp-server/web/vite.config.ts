import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
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
