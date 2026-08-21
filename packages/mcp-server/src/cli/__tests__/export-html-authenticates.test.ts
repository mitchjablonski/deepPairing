/**
 * R3 — `deeppairing export --format html` must authenticate like the browser.
 *
 * The failure it pins is the quietest kind. II2 made the daemon fail-closed on
 * a missing `X-Project-Hash`; the CLI's export fetch kept sending only
 * `X-Session-Id`, so from that flip onward the request 403'd, `res.ok` was
 * false, and the code fell through to its LOCAL fallback without a word. The
 * command still printed a path and still exited 0 — it just produced a
 * different document from the one the UI produces for the same session,
 * missing the gate breadcrumbs, with nothing anywhere saying so.
 *
 * Nothing at runtime can catch that: a silent fallback looks exactly like a
 * daemon that wasn't running. So the guard is structural — the two headers must
 * travel together on the export fetch. The behavioural half (both paths render
 * the same page) is pinned in http/__tests__/routes.export-html.test.ts.
 *
 * SEAM NOTE: this asserts on the ~15-line `format === "html"` block of
 * cli/init.ts only. The rest of that file is R1's.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const initSource = fs.readFileSync(path.resolve(here, "..", "init.ts"), "utf-8");

/** The `format === "html"` block, sliced out so a header elsewhere in the file
 *  can never satisfy this test by accident. */
function exportHtmlBlock(): string {
  const start = initSource.indexOf('if (format === "html")');
  expect(start).toBeGreaterThan(-1);
  const end = initSource.indexOf("/api/export?format=", start);
  expect(end).toBeGreaterThan(start);
  return initSource.slice(start, end);
}

describe("R3 — the CLI's html export authenticates like the UI", () => {
  it("sends X-Project-Hash alongside X-Session-Id on the daemon fetch", () => {
    const block = exportHtmlBlock();
    expect(block).toContain("/api/export.html");
    expect(block).toContain("X-Session-Id");
    // Without this the daemon fail-closes and the command silently degrades.
    expect(block).toContain("X-Project-Hash");
    expect(block).toContain("projectHashOf");
  });

  it("gives the local fallback a store, so it can read the gate breadcrumbs", () => {
    // A store-less assembleSessionHtml gathers no preflight traces, which is
    // the second half of "the CLI produced a different page".
    expect(exportHtmlBlock()).toMatch(/store:\s*new FileStore\(/);
  });
});
