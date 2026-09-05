import { test, expect, type Page } from "./test.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * H1 (#202) — real-browser verification + PR screenshots for the negotiation-
 * integrity batch, both themes:
 *   (a) the amber open-suggestion rail badge (M1) + the counter's mini-diff (H2)
 *       on a COUNTERED SuggestionCard.
 *   (b) the approve gate (H1): clicking "Approve changeset" while suggestions
 *       are open surfaces the inline confirm naming the count + states + files,
 *       instead of a silent commit.
 *
 * One daemon, kept live. Screenshots land in $DP202_SHOTS.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP202_SHOTS ?? path.join(os.tmpdir(), "dp-202-shots");

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-202-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-202-"));
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

  await post("register", { title: "H1 negotiation" });

  // A single-file changeset, already marked look-right (so the whole-changeset
  // action is the FINALIZING Approve — the path the gate must intercept).
  await post("artifacts", {
    id: "cs_1", type: "changeset", title: "Move TTL refresh into middleware",
    content: {
      summary: "Centralize the sliding-window refresh",
      reviewState: { "auth/middleware.ts": "reviewed" },
      files: [{
        path: "auth/middleware.ts", changeType: "modified", stats: { additions: 2, deletions: 1 },
        hunks: [{
          header: "@@ -24,4 +24,5 @@",
          lines: [
            { kind: "ctx", content: "const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
            { kind: "add", content: "const s = await store.getAndTouch(sid);", newLine: 26 },
            { kind: "add", content: "if (!s) return res.status(401).end();", newLine: 27 },
          ],
        }],
      }],
    },
  });
  // A PENDING suggestion (drives the amber badge + one gate count).
  await post("comments", {
    id: "sug_pending", artifactId: "cs_1", author: "human", intent: "suggestion",
    content: "prefer an explicit sliding flag",
    target: { artifactId: "cs_1", filePath: "auth/middleware.ts", lineStart: 27, lineEnd: 27 },
    suggestion: {
      originalText: "if (!s) return res.status(401).end();",
      replacementText: "if (!s || s.expiresAt < Date.now()) return res.status(401).end();",
      lineStart: 27, lineEnd: 27, state: "pending",
    },
  });
  // A COUNTERED suggestion carrying the agent's own code (H2 — the counter
  // mini-diff) + the agent's prose reply.
  await post("comments", {
    id: "sug_countered", artifactId: "cs_1", author: "human", intent: "suggestion",
    content: "use getAndTouch with a sliding flag",
    target: { artifactId: "cs_1", filePath: "auth/middleware.ts", lineStart: 26, lineEnd: 26 },
    suggestion: {
      originalText: "const s = await store.getAndTouch(sid);",
      replacementText: "const s = await store.getAndTouch(sid, { sliding: true });",
      lineStart: 26, lineEnd: 26, state: "countered",
      counter: {
        reason: "keep the window name explicit so the option can't be mistaken for a boolean toggle",
        replacementText: "const s = await store.getAndTouch(sid, { slidingWindow: true });",
      },
    },
  });
  await post("comments", {
    id: "cnt_reply", artifactId: "cs_1", author: "agent", parentCommentId: "sug_countered",
    content: "slidingWindow reads clearer at the call sites — countering with that name.",
    target: { artifactId: "cs_1", filePath: "auth/middleware.ts", lineStart: 26, lineEnd: 26 },
  });
});

test.afterAll(async () => {
  if (proc) await teardownDaemon(proc, portOf(baseURL));
  for (const dir of [projectRoot, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function load(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(`${baseURL}/?session=s`);
  await page.evaluate((t) => localStorage.setItem("dp-theme", t), theme);
  await page.reload();
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.getByText("Move TTL refresh into middleware", { exact: false }).first().click();
  await page.waitForTimeout(500);
}

test("open-suggestion badge + counter mini-diff + approve gate, both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await load(page, theme);

    // (a) The amber open-suggestion rail badge (M1).
    const badge = page.getByTestId("open-suggestion-badge").first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/!2/);

    // (a) The counter's mini-diff (H2) on the COUNTERED card.
    const counterDiff = page.getByTestId("counter-diff").first();
    await expect(counterDiff).toBeVisible();
    await expect(page.getByText(/Claude's counter:/).first()).toBeVisible();
    await expect(page.getByText(/slidingWindow: true/).first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, `negotiation-cards-${theme}.png`), fullPage: false });

    // (b) The approve gate: clicking Approve changeset surfaces the confirm.
    await page.getByTestId("approve-changeset").click();
    const confirm = page.getByTestId("approve-open-suggestions-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveText(/2 of your suggestions are still open/);
    await expect(confirm).toHaveText(/1 pending, 1 countered/);
    await expect(page.getByTestId("approve-confirm-files")).toHaveText(/auth\/middleware\.ts/);
    await page.screenshot({ path: path.join(SHOTS, `approve-gate-${theme}.png`), fullPage: false });
  }
});
