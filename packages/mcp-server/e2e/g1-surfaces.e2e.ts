import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * G1 (#198) — real-browser verification + PR screenshots for the batch's three
 * visible surfaces, both themes:
 *   (a) suggested edits on the CHANGESET surface — a posted suggestion renders
 *       as a first-class SuggestionCard (state pill + mini-diff) on the diff row.
 *   (b) the REQUEST COMPOSER banner — the human can initiate (presets + input).
 *   (c) the WITHDRAWN state — a retracted (agent-withdrawn) artifact reads
 *       "Retracted by agent" with its reason readable in the thread.
 *
 * One daemon, kept LIVE (registered) so the composer renders. Screenshots land
 * in $DP198_SHOTS.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP198_SHOTS ?? path.join(os.tmpdir(), "dp-198-shots");

let proc: ChildProcess;
let baseURL: string;
let projectRoot: string;
let home: string;

async function waitForDaemon(root: string): Promise<{ base: string; token: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port && info.authToken) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        if (res.ok) return { base: `http://localhost:${info.port}`, token: info.authToken };
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
  fs.mkdirSync(SHOTS, { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-198-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-198-"));
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  const post = (route: string, body: unknown) =>
    fetch(`${baseURL}/api/internal/sessions/s/${route}`, { method: "POST", headers: h, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error(`seed ${route} failed: ${r.status}`); });

  await post("register", { title: "G1 surfaces" });

  // (a) A changeset (draft) + a first-class suggested edit on a new-side line.
  await post("artifacts", {
    id: "cs_1", type: "changeset", title: "Move TTL refresh into middleware",
    content: {
      summary: "Centralize the sliding-window refresh",
      files: [{
        path: "auth/middleware.ts", changeType: "modified", stats: { additions: 2, deletions: 1 },
        hunks: [{
          header: "@@ -24,3 +24,4 @@",
          lines: [
            { kind: "ctx", content: "const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
            { kind: "del", content: "const s = await store.get(sid);", oldLine: 26 },
            { kind: "add", content: "const s = await store.getAndTouch(sid);", newLine: 26 },
          ],
        }],
      }],
    },
  });
  await post("comments", {
    id: "sug_1", artifactId: "cs_1", author: "human", intent: "suggestion",
    content: "prefer an explicit sliding flag",
    target: { artifactId: "cs_1", filePath: "auth/middleware.ts", lineStart: 26, lineEnd: 26 },
    suggestion: {
      originalText: "const s = await store.getAndTouch(sid);",
      replacementText: "const s = await store.getAndTouch(sid, { sliding: true });",
      lineStart: 26, lineEnd: 26, state: "pending",
    },
  });

  // (c) A withdrawn (retracted) artifact. #204 (UX L1) — the reason now lives in
  // ONE place: the inline "↩ Retracted by agent" surface (retractReason on the
  // content). The agent's thread comment is just the bare "Withdrawn." marker (no
  // second copy of the sentence), matching what withdraw_artifact posts.
  await post("artifacts", {
    id: "res_ret", type: "research", title: "Cache-invalidation sweep",
    content: {
      summary: "Draft I took back.",
      findings: [{ category: "Architecture", title: "Stale keys", detail: "Some keys never expire.", significance: "medium" }],
      retractReason: "I conflated two unrelated cache layers — re-scoping before re-presenting.",
    },
  });
  await post("artifacts/res_ret/status", { status: "retracted" });
  await post("comments", { id: "wd_1", artifactId: "res_ret", author: "agent", content: "Withdrawn." });
});

test.afterAll(async () => {
  if (proc) await teardownDaemon(proc, portOf(baseURL));
  for (const dir of [projectRoot, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function load(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${baseURL}/?session=s`);
  await page.evaluate((t) => localStorage.setItem("dp-theme", t), theme);
  await page.reload();
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.waitForTimeout(600);
}

async function selectArtifact(page: Page, title: string): Promise<void> {
  await page.getByText(title, { exact: false }).first().click();
  await page.waitForTimeout(400);
}

test("(b) request composer + (a) changeset suggestion card + (c) withdrawn state, both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await load(page, theme);

    // (b) Request composer: #204 (M3) — the row is COLLAPSED to a trigger; click
    // it to expand the composer (opens on the Explain preset), then confirm the
    // preset chips + input show and the example helper text persists (L3).
    await expect(page.getByTestId("request-composer")).toBeVisible();
    await page.getByTestId("request-composer-trigger").click();
    await expect(page.getByRole("button", { name: /Explain how…/ })).toBeVisible();
    await expect(page.getByLabel(/Your request to Claude/i)).toBeVisible();
    await expect(page.getByTestId("request-example-hint")).toContainText("the auth middleware works");
    await page.screenshot({ path: path.join(SHOTS, `request-composer-${theme}.png`), clip: { x: 0, y: 0, width: 1200, height: 240 } });

    // (a) Changeset suggestion card.
    await selectArtifact(page, "Move TTL refresh into middleware");
    const card = page.getByTestId("suggestion-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("suggestion-state-pill")).toHaveText(/PENDING/);
    await page.screenshot({ path: path.join(SHOTS, `changeset-suggestion-${theme}.png`), fullPage: false });

    // (c) Withdrawn state. #204 — the reason renders ONCE (inline "Retracted by
    // agent" surface); the thread marker is the bare "Withdrawn." (no duplicate
    // sentence). The per-finding verdict triad is dimmed + disabled (UX L2).
    await selectArtifact(page, "Cache-invalidation sweep");
    // "Retracted by agent" appears in both the sidebar chip and the panel footer;
    // the reason string is unique to the inline (single) reason surface.
    await expect(page.getByText(/Retracted by agent/i).first()).toBeVisible();
    await expect(page.getByText(/I conflated two unrelated cache layers/i)).toBeVisible();
    // The verdict triad is disabled on a retracted artifact (read-only write axis).
    await expect(page.getByRole("button", { name: /Approve finding 1/i })).toBeDisabled();
    await page.screenshot({ path: path.join(SHOTS, `withdrawn-${theme}.png`), fullPage: false });
  }
});
