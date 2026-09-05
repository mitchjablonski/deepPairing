import { test as base, expect } from "@playwright/test";
import { BoundedDiagnosticTail } from "./diagnostics.js";
import { attachActiveDaemonOutputs } from "./daemon-harness.js";

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const filesWithStartedTests = new Set<string>();

// A failed beforeAll skips auto-fixtures entirely. This hook is registered
// before each spec's own teardown hook, so startup/seed tails are attached
// before that spec kills and unregisters its daemon.
base.afterAll(async ({}, testInfo) => {
  if (!filesWithStartedTests.has(testInfo.file)) {
    await attachActiveDaemonOutputs(testInfo, { force: true });
  }
});

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

/** Auto-fixture that attaches a bounded, credential-redacted browser log on failure. */
export const test = base.extend<{ browserDiagnostics: void }>({
  browserDiagnostics: [async ({ browser, page }, use, testInfo) => {
    filesWithStartedTests.add(testInfo.file);
    const diagnostics = new BoundedDiagnosticTail(MAX_DIAGNOSTIC_BYTES);
    const record = (line: string) => diagnostics.record(line);
    const watchPage = (target: typeof page) => {
      target.on("console", (message) => record(`[console.${message.type()}] ${message.text()}`));
      target.on("pageerror", (error) => record(`[pageerror] ${error.stack ?? error.message}`));
      target.on("requestfailed", (request) =>
        record(`[requestfailed] ${request.method()} ${safeUrl(request.url())} ${request.failure()?.errorText ?? "unknown"}`),
      );
    };
    watchPage(page);
    // Capture pages created through browser.newContext() by screenshot specs too.
    const mutableBrowser = browser as typeof browser & { newContext: typeof browser.newContext };
    const originalNewContext = browser.newContext.bind(browser);
    mutableBrowser.newContext = async (...args) => {
      const context = await originalNewContext(...args);
      context.on("page", watchPage);
      return context;
    };
    try {
      await use();
    } finally {
      mutableBrowser.newContext = originalNewContext;
      await attachActiveDaemonOutputs(testInfo);
      if (testInfo.status !== testInfo.expectedStatus && diagnostics.lines.length) {
        await testInfo.attach("browser-diagnostics", {
          body: diagnostics.body(),
          contentType: "text/plain",
        });
      }
    }
  }, { auto: true }],
});

export { expect };
export type { Page, Locator, Browser, BrowserContext, TestInfo } from "@playwright/test";
