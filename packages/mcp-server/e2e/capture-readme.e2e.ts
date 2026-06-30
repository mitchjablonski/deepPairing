import { test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Not a regression test — a SCREENSHOT CAPTURE for the README. Boots a real
 * daemon (HOME isolated so the global ledger doesn't touch ~/.deeppairing),
 * seeds a realistic pairing session, and writes real-UI PNGs to docs/assets/.
 * Run: pnpm build && npx playwright test capture-readme.e2e.ts
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon.js");
const ASSETS = path.resolve(__dir, "../../../docs/assets");

test("capture README screenshots", async ({ page }) => {
  // Opt-in only — this writes PNGs into docs/assets/, so it must not run (and
  // dirty the tree) in the normal `pnpm test:e2e`. Run:
  //   pnpm build && CAPTURE_README=1 npx playwright test capture-readme.e2e.ts
  test.skip(!process.env.CAPTURE_README, "capture-only (set CAPTURE_README=1)");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cap-home-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cap-proj-"));
  let proc: ChildProcess | undefined;
  try {
    proc = spawn(process.execPath, [daemonJs], {
      env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_OPEN_BROWSER: "0" },
      stdio: "ignore",
    });

    // wait for daemon
    const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
    let info: any;
    for (let i = 0; i < 120 && !info?.port; i++) {
      if (fs.existsSync(infoPath)) { try { info = JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch {} }
      if (!info?.port) await new Promise((r) => setTimeout(r, 100));
    }
    const base = `http://localhost:${info.port}`;
    const di: any = await (await fetch(`${base}/api/daemon-info`)).json();
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${info.authToken}`, "X-Project-Hash": di.projectHash };
    const post = (p: string, b: unknown) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
    const sid = "demo";

    await post(`/api/internal/sessions/${sid}/register`, { title: "Auth token refresh review", project: "acme-api" });

    // A research artifact with rich, real-looking evidence — the review surface.
    await post(`/api/internal/sessions/${sid}/artifacts`, {
      id: "res1",
      type: "research",
      title: "Token refresh races under concurrent requests",
      content: {
        summary:
          "Two requests that arrive after the access token expires each kick off their own refresh. The second refresh invalidates the first's new token, so one of the two in-flight requests 401s intermittently — hard to reproduce, easy to ship.",
        findings: [
          {
            category: "Concurrency",
            title: "Refresh isn't coalesced — N expired requests trigger N refreshes",
            detail:
              "`refreshAccessToken()` is called from the response interceptor without a guard. Under load, every 401 in the same tick starts a fresh POST /oauth/token; the provider rotates the refresh token on each, so all but the last become invalid.",
            significance: "high",
            severity: "bug",
            impact: "Intermittent 401s for logged-in users during traffic spikes; looks like a flaky backend.",
            recommendation: "Coalesce concurrent refreshes behind a single in-flight promise (single-flight).",
            evidence: [
              {
                filePath: "src/auth/session.ts",
                lineStart: 84,
                lineEnd: 92,
                language: "typescript",
                snippet:
                  "api.interceptors.response.use(undefined, async (err) => {\n  if (err.response?.status === 401) {\n    // every concurrent 401 starts its own refresh\n    const token = await refreshAccessToken();\n    err.config.headers.Authorization = `Bearer ${token}`;\n    return api(err.config);\n  }\n  throw err;\n});",
                explanation:
                  "No guard around refreshAccessToken — concurrent 401s each rotate the refresh token, invalidating each other.",
              },
            ],
          },
        ],
      },
    });

    // A human comment anchored to the finding — the collaboration, inline.
    await post(`/api/internal/sessions/${sid}/comments`, {
      id: "c1",
      artifactId: "res1",
      author: "human",
      content: "Does the mobile client share this interceptor? If so the fix has to cover both.",
      target: { artifactId: "res1", findingIndex: 0 },
    });

    // A reasoning artifact — concept named for learning (the teaching lever).
    await post(`/api/internal/sessions/${sid}/artifacts`, {
      id: "rea1",
      type: "reasoning",
      title: "Single-flight the refresh instead of locking",
      content: {
        action: "Wrap the refresh in a module-level in-flight promise so concurrent callers await the same one.",
        reasoning:
          "A mutex/lock would serialize every request; single-flight only coalesces the refresh itself and lets the rest stay parallel. It's also the pattern the rest of this codebase already uses for cache fills.",
        confidence: "high",
        concept: {
          name: "single-flight / request coalescing",
          oneLineExplanation:
            "When many callers need the same expensive result, run it once and hand everyone the same in-flight promise.",
        },
        alternativeDetails: [
          { title: "A mutex around all authed requests", reason: "Serializes unrelated requests — kills throughput under load." },
          { title: "Retry-with-backoff on the 401", reason: "Hides the race instead of fixing it; still rotates the token N times." },
        ],
      },
    });

    // Seed the cross-project ledger so the Your Taste drawer has real stances.
    for (const s of [
      { concept: "global mutable state for config", reason: "broke testability in three places last project" },
      { concept: "deploy to Railway for pay-per-request hosting", reason: "cold starts hurt p99 on the auth path" },
      { concept: "ORM for the reporting queries", reason: "the generated SQL was untunable; raw queries won" },
    ]) {
      await post(`/api/philosophy/seed`, { concept: s.concept, verdict: "rejected", reason: s.reason });
    }

    // Render + capture.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/?session=${sid}`);
    await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
    await page.waitForTimeout(1500); // syntax highlight + motion settle
    await page.screenshot({ path: path.join(ASSETS, "review-surface.png") });

    // The reasoning card (concept) — an alternative hero candidate.
    await page.getByText("Single-flight the refresh instead of locking").click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(ASSETS, "reasoning-card.png") });

    // The Your Taste drawer.
    await page.getByRole("button", { name: /your taste/i }).click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(ASSETS, "ledger.png") });
  } finally {
    proc?.kill();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
