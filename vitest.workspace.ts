import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/shared",
  "packages/mcp-server",
  "apps/api",
  {
    test: {
      name: "web",
      root: "apps/web",
      environment: "jsdom",
    },
  },
]);
