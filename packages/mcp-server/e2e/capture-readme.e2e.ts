import { test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon } from "./daemon-harness.js";

/**
 * Not a regression test — a SCREENSHOT CAPTURE for the README. Boots a real
 * daemon (HOME isolated so the global ledger doesn't touch ~/.deeppairing),
 * seeds a realistic pairing session, and writes real-UI PNGs to docs/assets/.
 * Run: pnpm build && npx playwright test capture-readme.e2e.ts
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const ASSETS = path.resolve(__dir, "../../../docs/assets");

test("README capture flow — selectors resolve (+ writes PNGs when CAPTURE_README=1)", async ({ page }) => {
  // K4 — this ALWAYS runs in CI now, as a selector-integrity check: it drives
  // the real rendered app through every navigation the README shots depend on
  // and ASSERTS each target renders, so selector rot (e.g. the F2 "your taste"
  // → "Ledger" rename, or a wrongly-scoped locator) fails the build instead of
  // rotting silently behind a CAPTURE_README-opt-in skip. Only the PNG WRITES
  // are gated on the flag, so a normal CI run never dirties docs/assets/. To
  // refresh the screenshots: `pnpm build && CAPTURE_README=1 npx playwright test capture-readme.e2e.ts`.
  const CAPTURE = !!process.env.CAPTURE_README;
  const shot = async (name: string) => {
    if (CAPTURE) await page.screenshot({ path: path.join(ASSETS, name) });
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cap-home-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cap-proj-"));
  let proc: ChildProcess | undefined;
  // Review BLOCKER — declared OUTSIDE the try: the finally reads info?.port,
  // and the in-try declaration crashed teardown with ReferenceError, leaking
  // the daemon this PR exists to clean up. Invisible to every gate (e2e/ is
  // outside both tsconfigs; the spec is CAPTURE_README-opt-in).
  let info: any;
  try {
    proc = spawn(process.execPath, [daemonJs], {
      env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_OPEN_BROWSER: "0" },
      stdio: "ignore",
    });

    // wait for daemon
    const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
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
    await shot("review-surface.png");

    // The reasoning card (concept). No silent .catch — a broken selector must
    // FAIL, not screenshot the wrong surface (the ledger break's exact class).
    await page.getByText("Single-flight the refresh instead of locking").click();
    await page.getByText("single-flight / request coalescing").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(1000);
    await shot("reasoning-card.png");

    // The Ledger drawer. The header control was renamed from "your taste" to
    // "Ledger" (F2 rename) — the old /your taste/i selector matched nothing and
    // silently fell through to screenshotting the un-opened review surface. Two
    // header buttons now carry "Ledger" in their accessible name (the
    // CompoundingBadge stat and this dedicated button), so match the dedicated
    // one EXACTLY, then WAIT for the drawer to actually render before capturing
    // — no silent .catch() fallthrough.
    // The header button is the first "Open the Ledger" in DOM order. A
    // daemon-mismatch toast can carry the same action label, so .first()
    // (not an unscoped exact match, which would strict-throw) targets the
    // real header control — and there's no <header> landmark to scope to.
    await page.getByRole("button", { name: "Open the Ledger", exact: true }).first().click();
    await page.getByText("Cross-project Philosophy Ledger").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(1000); // let the drawer's slide-in + digest settle
    await shot("ledger.png");

    // The enforcement moment — the money shot. The unauthenticated /api/demo/run
    // route mints a demo session and runs the scripted flow, which fires a REAL
    // preflight_blocked broadcast ~5s in (12s toast TTL). CAPTURE-gated on
    // purpose: the fixed ~5s timing is mildly racy (the WS must connect inside
    // that window), so it stays OUT of the always-on CI selector check (K4) —
    // the demo route itself is covered by demo-script.test.ts. Only runs when
    // actually regenerating screenshots.
    if (CAPTURE) {
      const demo = (await (await fetch(`${base}/api/demo/run`, { method: "POST" })).json()) as { sessionId: string };
      await page.goto(`${base}/?session=${demo.sessionId}`);
      await page.getByText("Blocked by your taste").waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForTimeout(600); // let the hero card settle
      await page.screenshot({ path: path.join(ASSETS, "enforcement.png") });
    }
  } finally {
    // I1 — teardown BARRIER: block until the daemon is fully down (process
    // exited AND port released) before removing its dirs, so this opt-in spec
    // can't leave a LISTENING daemon behind. See daemon-harness.ts.
    await teardownDaemon(proc, info?.port);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
