import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * Q4 (round-12 "the UX rider") — SCREENSHOT CAPTURE + live measurement for the
 * two defects that are fundamentally about GEOMETRY, so a class-name unit pin
 * isn't evidence:
 *
 *   1. the diagram well. Round 12 measured a 13-node flowchart rendering
 *      718×1954px inside a 1121px container (the only cap was max-width), so
 *      IMPLEMENTATION STEPS started three screens down and Expand / View source
 *      — the two controls that FIX an oversized diagram — sat 1416px BELOW the
 *      fold. You had to scroll past the problem to reach its remedy.
 *   2. the CHANGED FILES picker. A plain `truncate` ellipsizes tail-first inside
 *      a 240px rail, so every row read "packages/mc…".
 *
 * BEFORE/AFTER in one run: the spec measures the shipped state, then RECREATES
 * the old geometry in-page (drop the cap, move the controls back below the
 * canvas; restore the single tail-truncating span) and measures that. Same
 * fixture, same browser, same frame — a far tighter comparison than screenshots
 * taken against two checkouts, and it can't rot into a stale baseline.
 *
 * The measurements ALWAYS assert; PNGs are written only under CAPTURE_Q4=1.
 *
 * Refresh: CAPTURE_Q4=1 npx playwright test q4-capture.e2e.ts
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const OUT = path.resolve(__dir, "../test-results/q4");

let proc: ChildProcess | undefined;
let projectRoot: string;
let home: string;
let baseURL: string;

/** The round-12 repro: a 13-node flowchart. Tall enough to blow past any
 *  viewport at every width this app is reviewed at. */
const FLOWCHART_13 = [
  "flowchart TD",
  "  A[Client request] --> B[Auth middleware]",
  "  B --> C{Session cookie?}",
  "  C -->|no| D[401 challenge]",
  "  C -->|yes| E[Session store lookup]",
  "  E --> F{Found and fresh?}",
  "  F -->|no| G[Expire and clear cookie]",
  "  G --> D",
  "  F -->|yes| H[Touch TTL]",
  "  H --> I[Attach principal]",
  "  I --> J[Route handler]",
  "  J --> K[Audit log write]",
  "  K --> L[Response]",
  "  D --> M[Redirect to login]",
].join("\n");

/** Deliberately deep paths that share a long prefix — the picker repro. */
const DEEP_PATHS = [
  "packages/mcp-server/src/mcp/tools/check-feedback-delivery.ts",
  "packages/mcp-server/web/src/components/artifacts/ChangesetArtifact.tsx",
  "packages/mcp-server/src/store/artifact-store.ts",
];

async function waitForDaemon(root: string): Promise<{ base: string; token: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        if (res.ok && info.authToken) return { base: `http://localhost:${info.port}`, token: info.authToken };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("daemon did not start");
}

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-q4-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-q4-"));
  if (process.env.CAPTURE_Q4) fs.mkdirSync(OUT, { recursive: true });
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };

  await fetch(`${baseURL}/api/internal/sessions/q4/register`, { method: "POST", headers: h, body: "{}" })
    .then((r) => { if (!r.ok) throw new Error(`register failed: ${r.status}`); });

  await fetch(`${baseURL}/api/internal/sessions/q4/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "plan_q4", type: "plan", title: "Session TTL refresh — the request path",
      content: {
        steps: [
          { description: "Move the TTL touch into the auth middleware", reasoning: "One place owns the sliding window." },
          { description: "Fail closed on an expired session", reasoning: "A stale principal is worse than a re-login." },
          { description: "Audit the refresh", reasoning: "The security review will ask." },
        ],
        estimatedChanges: 3,
        visuals: [{ id: "vis_q4", kind: "diagram", title: "Request path", source: FLOWCHART_13 }],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed plan failed: ${r.status}`); });

  await fetch(`${baseURL}/api/internal/sessions/q4/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_q4", type: "changeset", title: "Deep paths in the picker",
      content: {
        summary: "Three files whose paths share a long prefix.",
        files: DEEP_PATHS.map((p) => ({
          path: p,
          changeType: "modified",
          stats: { additions: 3, deletions: 1 },
          hunks: [{
            header: "@@ -24,3 +24,4 @@",
            lines: [
              { kind: "ctx", content: "const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
              { kind: "add", content: "const s = await store.getAndTouch(sid);", newLine: 26 },
            ],
          }],
        })),
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed changeset failed: ${r.status}`); });
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// Cold daemon + hydration on WSL /mnt/c is slow (9P); these assertions are
// about layout, not timing.
test.describe.configure({ retries: 2, timeout: 120_000 });

const CAPTURE = !!process.env.CAPTURE_Q4;

async function newPage(browser: import("@playwright/test").Browser, theme: "dark" | "light", width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem("dp-theme", t), theme);
  return { context, page };
}

async function shot(page: import("@playwright/test").Page, name: string) {
  if (CAPTURE) await page.screenshot({ path: path.join(OUT, name), fullPage: true });
}

async function open(page: import("@playwright/test").Page, id: string) {
  await page.goto(`${baseURL}/?session=q4`);
  await page.locator("[data-artifact-item]").first().waitFor({ state: "visible", timeout: 60000 });
  await page.locator(`[data-artifact-item="${id}"]`).click({ timeout: 15000 });
  await page.waitForSelector(`[data-artifact-id="${id}"]`, { timeout: 15000 });
}

/** Document-space top edge of an element (scroll-independent). */
async function pageY(loc: import("@playwright/test").Locator): Promise<number> {
  return loc.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 900] as const) {
    test(`Q4 #1 diagram — capped well, controls above the canvas (${theme}, ${width})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, theme, width);
      await open(page, "plan_q4");

      const well = page.locator(".dp-mermaid-well").first();
      const controls = page.locator(".dp-mermaid-controls").first();
      const steps = page.getByRole("heading", { name: /^Implementation Steps/i }).first();
      await well.locator("svg").first().waitFor({ timeout: 30000 });
      await steps.waitFor({ timeout: 15000 });

      // --- AFTER (shipped) ---------------------------------------------------
      const svgHeight = await well.locator("svg").first().evaluate((el) => el.getBoundingClientRect().height);
      const afterWell = (await well.boundingBox())!;
      const afterSteps = await pageY(steps);
      const afterControls = await pageY(controls);
      const afterWellTop = await pageY(well);

      // The well is capped at 60vh (900px viewport ⇒ 540px) and scrolls inside.
      expect(afterWell.height).toBeLessThanOrEqual(0.6 * 900 + 4);
      expect(await well.evaluate((el) => getComputedStyle(el).overflowY)).toMatch(/auto|scroll/);
      // The fixture really is oversized — otherwise the cap proves nothing.
      expect(svgHeight).toBeGreaterThan(afterWell.height);
      // The controls sit ABOVE the canvas, and both are within the first screen.
      expect(afterControls).toBeLessThan(afterWellTop);
      expect(afterControls).toBeLessThan(900);
      // Expand + View source are both there, above the fold.
      await expect(controls.getByRole("button", { name: /Expand/ })).toBeVisible();
      await expect(controls.getByRole("button", { name: /View source/ })).toBeVisible();
      // The capped well is keyboard-reachable (axe scrollable-region-focusable).
      expect(await well.getAttribute("tabindex")).toBe("0");

      await shot(page, `diagram-after-${theme}-${width}.png`);

      // --- BEFORE (the round-12 geometry, recreated in-page) ------------------
      const before = await page.evaluate(() => {
        const w = document.querySelector(".dp-mermaid-well") as HTMLElement;
        const c = document.querySelector(".dp-mermaid-controls") as HTMLElement;
        w.style.maxHeight = "none";
        w.style.overflow = "visible";
        // Controls back below the canvas, where round 12 found them.
        w.parentElement!.appendChild(c);
        return null;
      });
      void before;
      await page.waitForTimeout(120);
      const beforeSteps = await pageY(steps);
      const beforeControls = await pageY(controls);
      const beforeWellHeight = (await well.boundingBox())!.height;

      await shot(page, `diagram-before-${theme}-${width}.png`);

      // The deltas this batch exists for. Reported in the failure message so a
      // regression tells you the number, not just "false".
      const msg =
        `well ${beforeWellHeight.toFixed(0)}px → ${afterWell.height.toFixed(0)}px; ` +
        `IMPLEMENTATION STEPS page-y ${beforeSteps.toFixed(0)} → ${afterSteps.toFixed(0)}; ` +
        `controls page-y ${beforeControls.toFixed(0)} → ${afterControls.toFixed(0)} ` +
        `(viewport 900px)`;
      expect(afterSteps, msg).toBeLessThan(beforeSteps);
      expect(afterControls, msg).toBeLessThan(900); // now above the fold
      expect(beforeControls, msg).toBeGreaterThan(afterControls);
      // …and where the uncapped diagram genuinely overruns the viewport (it does
      // at every width this app is reviewed at), the controls WERE below the
      // fold — the round-12 finding, reproduced rather than asserted from memory.
      if (afterWellTop + beforeWellHeight > 900) {
        expect(beforeControls, msg).toBeGreaterThan(900);
      }
      // eslint-disable-next-line no-console
      console.log(`[q4 ${theme} ${width}] ${msg}`);

      await context.close();
    });

    test(`Q4 #2 picker — the basename survives (${theme}, ${width})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, theme, width);
      await open(page, "cs_q4");

      const basenames = page.getByTestId("changeset-rail-file-basename");
      await basenames.first().waitFor({ timeout: 30000 });
      expect(await basenames.count()).toBe(3);

      // --- AFTER: every row shows its filename, fully, with real width -------
      const texts = await basenames.allTextContents();
      expect(texts).toEqual([
        "check-feedback-delivery.ts",
        "ChangesetArtifact.tsx",
        "artifact-store.ts",
      ]);
      // Head truncation: the DIRECTORY collapses first, so the basename gets
      // essentially the whole row. (In a 240px rail a long basename can still
      // clip its own tail — but it is the half that names the file, and it
      // never overflows onto the stat bar.)
      const geom = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="changeset-rail-file-path"]')].map((label) => {
          const dir = label.querySelector<HTMLElement>('[data-testid="changeset-rail-file-dir"]');
          const base = label.querySelector<HTMLElement>('[data-testid="changeset-rail-file-basename"]')!;
          const stats = label.closest("button")!.querySelector<HTMLElement>(".shrink-0:not([data-testid])");
          return {
            dirWidth: dir ? dir.getBoundingClientRect().width : 0,
            baseWidth: base.getBoundingClientRect().width,
            baseRight: base.getBoundingClientRect().right,
            rowRight: label.closest("button")!.getBoundingClientRect().right,
            statsPresent: !!stats,
          };
        }),
      );
      for (const g of geom) {
        expect(g.baseWidth, `basename must win the row: ${JSON.stringify(g)}`).toBeGreaterThan(g.dirWidth);
        expect(g.baseWidth).toBeGreaterThan(40);
        // …and it stays INSIDE the row rather than painting over the stat bar.
        expect(g.baseRight).toBeLessThanOrEqual(g.rowRight + 1);
      }
      // The full path is still one hover away on every row.
      const labels = page.getByTestId("changeset-rail-file-path");
      for (let i = 0; i < 3; i++) {
        expect(await labels.nth(i).getAttribute("title")).toBe(DEEP_PATHS[i]);
      }
      await shot(page, `picker-after-${theme}-${width}.png`);

      // --- BEFORE: the single tail-truncating span, recreated ----------------
      await page.evaluate(() => {
        for (const label of document.querySelectorAll<HTMLElement>('[data-testid="changeset-rail-file-path"]')) {
          const full = label.getAttribute("title") ?? "";
          const span = document.createElement("span");
          span.className = "flex-1 min-w-0 truncate";
          span.dataset.q4Before = "1";
          span.textContent = full;
          // Replace the FLEX ITEM (the wrapper), not the label inside it — an
          // inline span nested one level deeper has clientWidth 0 and can't be
          // measured for overflow.
          (label.parentElement ?? label).replaceWith(span);
        }
      });
      await page.waitForTimeout(120);
      await shot(page, `picker-before-${theme}-${width}.png`);

      // Prove the "before" really did lose the filename: with a tail-first
      // truncate at this rail width the row overflows, so the ellipsis eats the
      // TAIL — which is exactly where the basename lives.
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-q4-before="1"]')].map((el) => ({
          overflowed: el.scrollWidth > el.clientWidth + 1,
          // How much of the path fits: the fraction that survives the clip.
          visibleFraction: el.clientWidth / el.scrollWidth,
        })),
      );
      expect(clipped.length).toBe(3);
      expect(
        clipped.every((c) => c.overflowed),
        `rail rows must overflow when tail-truncated: ${JSON.stringify(clipped)}`,
      ).toBe(true);
      // eslint-disable-next-line no-console
      console.log(
        `[q4 picker ${theme} ${width}] tail-truncate showed ` +
          clipped.map((c) => `${(c.visibleFraction * 100).toFixed(0)}%`).join(" / ") +
          " of each path; head-truncate shows 100% of every basename",
      );

      await context.close();
    });
  }
}
