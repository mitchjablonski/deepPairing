import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
    ],
    // Tests in web/src/components/**/__tests__ or ending .dom.test.(ts|tsx)
    // run in happy-dom so React Testing Library + user-event work. Everything
    // else stays in node for speed and realism.
    environmentMatchGlobs: [
      ["web/src/components/**/__tests__/**", "happy-dom"],
      ["web/src/**/*.dom.test.*", "happy-dom"],
    ],
    setupFiles: ["./web/src/__tests__/setup.ts"],
  },
});
