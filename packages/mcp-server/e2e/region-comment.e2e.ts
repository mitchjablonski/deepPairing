import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * #159 — region-anchored diagram comments (#140) driven against REAL geometry.
 *
 * This is the only layer that can test the drag path at all: happy-dom/jsdom
 * return all-zero rects, so the unit tests cover the pure geometry
 * (mermaidRegion.ts) but not the pipeline that feeds it — a real Mermaid SVG's
 * node boxes, the pointer-capture overlay, and the gutter clamping. It
 * retroactively covers the two live field-fix rounds (#172/#173: bounded well,
 * pointer capture, gutter clamp) that shipped exactly because no automated
 * layer exercised a real drag.
 *
 * Coordinates come from boundingBox() at run time — never hardcoded pixels.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");

let proc: ChildProcess | undefined;
let projectRoot: string;
// K2 — isolated HOME; scratch dirs are never the real ~/.deeppairing.
let home: string;
let baseURL: string;

const SID = "region";

async function waitForDaemon(root: string): Promise<{ base: string; token: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        if (res.ok && info.authToken) return { base: `http://localhost:${info.port}`, token: info.authToken };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("daemon did not come up");
}

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-region-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-region-"));
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;

  // A single-artifact session: a plan whose diagram renders directly. LR
  // orientation puts the two nodes side by side, so the flex-centered well
  // has real left/right gutters — the exact geometry of the #173 field bug.
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  const reg = await fetch(`${baseURL}/api/internal/sessions/${SID}/register`, { method: "POST", headers: h, body: "{}" });
  if (!reg.ok) throw new Error(`seed register failed: ${reg.status}`);
  await fetch(`${baseURL}/api/internal/sessions/${SID}/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "plan_region", type: "plan", title: "Login flow plan",
      content: {
        steps: [{ description: "wire the auth gate", reasoning: "because" }],
        estimatedChanges: 1,
        visuals: [{ id: "vis_login", kind: "diagram", title: "Login flow", source: "graph LR; AuthGate[Auth gate] --> LoginForm[Login form]" }],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed plan failed: ${r.status}`); });
});

test.afterAll(async () => {
  // I1 — teardown barrier (see daemon-harness.ts).
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

/** Open the session and wait until the REAL Mermaid engine has produced the
 *  SVG (the region overlay only exists over a rendered diagram). */
async function openDiagram(page: Page): Promise<void> {
  await page.goto(`${baseURL}/?session=${SID}`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15_000 });
  await page.waitForSelector(".dp-mermaid svg g.node", { timeout: 15_000 });
}

/** A real pointer drag with intermediate moves (pointermove must fire for the
 *  marquee), from/to page coordinates. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test("drag over a rendered node opens the composer with THAT node, and the posted comment survives a reload un-flagged", async ({ page }) => {
  await openDiagram(page);

  const node = page.locator(".dp-mermaid svg g.node", { hasText: "Login form" });
  const nb = await node.boundingBox();
  expect(nb, "the Login form node has real geometry").toBeTruthy();

  // Drag a marquee fully INSIDE the node box — real coordinates from the
  // rendered SVG, comfortably above the 4px click threshold.
  await drag(
    page,
    { x: nb!.x + 5, y: nb!.y + 5 },
    { x: nb!.x + nb!.width - 5, y: nb!.y + nb!.height - 5 },
  );

  // The composer opened with the RIGHT node label in the region context —
  // this is the hit-test against real geometry, the thing no unit layer sees.
  await expect(page.getByText("Commenting on [Login form]")).toBeVisible({ timeout: 10_000 });

  // Post the comment through the composer's real CommentThread input. The
  // page has other comment textareas (the artifact-level thread), so target
  // the one the region layer just FOCUSED — its open-composer contract moves
  // focus into the composer's textarea, which is also the a11y behavior the
  // component pins. ⌘/Ctrl+Enter is the composer's real send path.
  const composerInput = page.locator("textarea:focus");
  await composerInput.waitFor({ timeout: 10_000 });
  await composerInput.fill("This form needs a rate limit.");
  await composerInput.press("Control+Enter");

  // Persisted + rendered: the highlight draws on the diagram and is NOT
  // flagged missing, and the text mirror names the node.
  const highlight = page.locator('[data-testid="dp-region-highlight"]');
  await expect(highlight).toHaveCount(1, { timeout: 10_000 });
  await expect(highlight).toHaveAttribute("data-region-missing", "false");
  await expect(page.getByText("on region [Login form]")).toBeVisible();
  await expect(page.getByText("This form needs a rate limit.").first()).toBeVisible();

  // Reload — the comment must come back from the store, still anchored to the
  // node (not "node no longer in this diagram", the crying-wolf failure mode).
  await page.reload();
  await page.waitForSelector(".dp-mermaid svg g.node", { timeout: 15_000 });
  const rehydrated = page.locator('[data-testid="dp-region-highlight"]');
  await expect(rehydrated).toHaveCount(1, { timeout: 10_000 });
  await expect(rehydrated).toHaveAttribute("data-region-missing", "false");
  await expect(page.getByText("on region [Login form]")).toBeVisible();
  await expect(page.getByText("This form needs a rate limit.").first()).toBeVisible();
});

test("a drag STARTING in the well's left gutter clamps to the diagram and still selects the leftmost node (#173)", async ({ page }) => {
  await openDiagram(page);

  const overlay = page.getByTestId("dp-region-overlay");
  const ob = await overlay.boundingBox();
  const auth = page.locator(".dp-mermaid svg g.node", { hasText: "Auth gate" });
  const ab = await auth.boundingBox();
  expect(ob && ab).toBeTruthy();

  // Prove there IS a gutter: the leftmost node sits well right of the well's
  // left edge (the flex-centered narrow diagram). If this ever fails, the
  // layout changed and the test needs a narrower diagram, not deletion.
  expect(ab!.x - ob!.x, "left gutter exists inside the capture well").toBeGreaterThan(12);

  // The exact field bug: start LEFT of the leftmost node (inside the well's
  // gutter — pre-#173 dead zone), sweep right across the node. normalizeRect
  // clamps the rect back into the SVG box, so the node must be selected.
  await drag(
    page,
    { x: ob!.x + 3, y: ab!.y + 3 },
    { x: ab!.x + ab!.width - 5, y: ab!.y + ab!.height - 5 },
  );

  await expect(page.getByText("Commenting on [Auth gate]")).toBeVisible({ timeout: 10_000 });

  // Leave the surface clean (no comment posted from this test).
  await page.getByRole("button", { name: "Cancel region comment" }).click();
  await expect(page.getByText("Commenting on [Auth gate]")).toHaveCount(0);
});
