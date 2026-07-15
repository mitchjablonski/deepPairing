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

test("README capture flow — selectors resolve (+ writes PNGs when CAPTURE_README=1)", async ({ browser }) => {
  // K4 — this ALWAYS runs in CI now, as a selector-integrity check: it drives
  // the real rendered app through every navigation the README shots depend on
  // and ASSERTS each target renders, so selector rot (e.g. the F2 "your taste"
  // → "Ledger" rename, or a wrongly-scoped locator) fails the build instead of
  // rotting silently behind a CAPTURE_README-opt-in skip. Only the PNG WRITES
  // are gated on the flag, so a normal CI run never dirties docs/assets/. To
  // refresh the screenshots: `pnpm build && CAPTURE_README=1 npx playwright test capture-readme.e2e.ts`.
  const CAPTURE = !!process.env.CAPTURE_README;
  // Own context (not the fixture page) so the README shots capture at 2x DPR —
  // crisp in a high-density README — with a fixed dark theme + viewport, the
  // look the existing docs/assets/*.png already use. deviceScaleFactor can only
  // be set at context creation, hence the explicit newContext here.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();
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

    // Render + capture. (Viewport + DPR are fixed on the context above.)
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

    // ------------------------------------------------------------------
    // #140 / #138 / #139 — the v0.1.7+ additions the README prose promises
    // but the old shots never showed: region-anchored diagram comments (the
    // HERO), the project-wide decisions view, and the detail-density dial.
    // Seeded AFTER the shots above so those keep their single-session framing.
    // ------------------------------------------------------------------
    const planSid = "auth-plan";
    const planArt = "plan_auth";
    const visId = "vis_auth";
    await post(`/api/internal/sessions/${planSid}/register`, { title: "Auth token refresh — plan", project: "acme-api" });

    // A plan carrying a Mermaid diagram with recognizable node labels
    // (Login → AuthGate → TokenStore) so a region anchored to "AuthGate" is
    // self-explanatory.
    await post(`/api/internal/sessions/${planSid}/artifacts`, {
      id: planArt,
      type: "plan",
      title: "Single-flight the token refresh",
      content: {
        estimatedChanges: 3,
        steps: [
          { description: "Add an in-flight refresh promise in session.ts", reasoning: "Coalesce concurrent 401s behind one refresh." },
          { description: "Route the response interceptor through it", reasoning: "Every 401 awaits the same refresh instead of starting its own." },
          { description: "Add a concurrency test that fires N parallel 401s", reasoning: "Lock in the single-flight behavior." },
        ],
        visuals: [
          {
            id: visId,
            kind: "diagram",
            title: "Request path through the refresh gate",
            caption:
              "The auth flow: a request hits the AuthGate, which single-flights the token refresh before reaching the TokenStore.",
            source:
              "flowchart LR\n  Login[Login] --> AuthGate[AuthGate]\n  AuthGate --> TokenStore[TokenStore]\n  AuthGate --> Refresh[Refresh]\n  Refresh --> TokenStore",
          },
        ],
      },
    });

    // A few resolved decisions across separate sessions, so the project-wide
    // decisions view (#138) has real, distinct rows. Each decision session
    // gets a leading investigation artifact so its sessionTitle reads as the
    // topic (the view derives sessionTitle from the first artifact), not an
    // echo of the decision question — the real gather→decide session shape.
    const leadArtifacts: Record<string, { id: string; title: string; summary: string }> = {
      "rate-limit": { id: "res_rate", title: "Rate limiter design", summary: "The public API needs per-tenant rate limiting; the question is where the counter lives across our 4 instances." },
      "schema-mig": { id: "res_mig", title: "Orders schema migration", summary: "orders.status is nullable and half the rows are null; we want a non-null constraint without downtime on a 40M-row table." },
    };
    const decisionSeeds = [
      {
        sid: planSid, title: "Auth token refresh — plan", decId: "dec_coalesce",
        context: "How should we coalesce the concurrent token refresh?", stakes: "high",
        options: [
          { id: "opt_single", title: "Single-flight promise", description: "One in-flight refresh; concurrent callers await it.", pros: ["Keeps unrelated requests parallel"], cons: ["Module-level state"], effort: "low", risk: "low", recommendation: true, concept: { name: "single-flight / request coalescing" } },
          { id: "opt_mutex", title: "Mutex on all authed requests", description: "Serialize every authed request behind a lock.", pros: ["Simple mental model"], cons: ["Kills throughput under load"], effort: "medium", risk: "high", recommendation: false },
        ],
        chosen: "opt_single", reasoning: "Only coalesces the refresh; the rest stay parallel.", confidence: "high",
      },
      {
        sid: "rate-limit", title: "Rate limiter design", decId: "dec_ratestore",
        context: "Where should the rate-limit counter live?", stakes: "medium",
        options: [
          { id: "opt_redis", title: "Redis with a sliding window", description: "Shared counter across instances.", pros: ["Accurate across the fleet"], cons: ["New infra dependency"], effort: "medium", risk: "medium", recommendation: true },
          { id: "opt_mem", title: "In-process token bucket", description: "Per-instance memory counter.", pros: ["Zero new infra"], cons: ["Inaccurate behind a load balancer"], effort: "low", risk: "medium", recommendation: false },
        ],
        chosen: "opt_redis", reasoning: "We run 4 instances behind the LB; per-process counters would let 4x through.",
      },
      {
        sid: "schema-mig", title: "Orders schema migration", decId: "dec_migrate",
        context: "How do we roll out the non-null constraint on orders.status?", stakes: "high",
        options: [
          { id: "opt_expand", title: "Expand / contract in two deploys", description: "Backfill, then add the constraint.", pros: ["Zero downtime"], cons: ["Two deploys"], effort: "medium", risk: "low", recommendation: true },
          { id: "opt_direct", title: "Single ALTER with a default", description: "One migration, table lock.", pros: ["One step"], cons: ["Locks the table on a large row count"], effort: "low", risk: "high", recommendation: false },
        ],
        chosen: "opt_expand", reasoning: "orders is 40M rows; a direct ALTER would lock writes for minutes.",
      },
    ];
    const seenSid = new Set<string>();
    for (const d of decisionSeeds) {
      if (!seenSid.has(d.sid)) {
        if (d.sid !== planSid) await post(`/api/internal/sessions/${d.sid}/register`, { title: d.title, project: "acme-api" });
        const lead = leadArtifacts[d.sid];
        if (lead) await post(`/api/internal/sessions/${d.sid}/artifacts`, { id: lead.id, type: "research", title: lead.title, content: { summary: lead.summary, findings: [] } });
        seenSid.add(d.sid);
      }
      const artId = `art_${d.decId}`;
      await post(`/api/internal/sessions/${d.sid}/artifacts`, { id: artId, type: "decision", title: d.context, content: { context: d.context, options: d.options, decisionId: d.decId, stakes: d.stakes } });
      await post(`/api/internal/sessions/${d.sid}/decisions`, { decisionId: d.decId, artifactId: artId, context: d.context, options: d.options, stakes: d.stakes });
      await post(`/api/internal/sessions/${d.sid}/decisions/${d.decId}/resolve`, { optionId: d.chosen, reasoning: d.reasoning, ...(("confidence" in d && d.confidence) ? { confidence: d.confidence } : {}) });
    }

    // Select the plan and wait for the Mermaid diagram to render its nodes.
    const selectPlan = async () => {
      await page.getByText("Single-flight the token refresh").first().click();
      await page.waitForSelector(".dp-mermaid svg g.node", { timeout: 20_000 });
    };
    await page.goto(`${base}/?session=${planSid}`);
    await page.waitForSelector("[data-artifact-id]", { timeout: 15_000 });
    await selectPlan();
    await page.waitForTimeout(1000); // let mermaid settle before measuring nodes

    // HERO — post a region comment anchored to the "AuthGate" node. The region
    // rect is computed from the ACTUAL rendered SVG (normalized to the SVG box,
    // exactly as the DiagramRegionLayer does) so the highlight lands precisely
    // on the node — no guessed coordinates.
    const region = await page.evaluate(() => {
      const svg = document.querySelector(".dp-mermaid svg");
      if (!svg) return null;
      const host = svg.getBoundingClientRect();
      let hit: Element | null = null;
      svg.querySelectorAll("g.node").forEach((g) => {
        if ((g.textContent || "").trim().includes("AuthGate")) hit = g;
      });
      if (!hit) return null;
      const r = (hit as Element).getBoundingClientRect();
      return {
        id: (hit as Element).id || "",
        x: (r.left - host.left) / host.width,
        y: (r.top - host.top) / host.height,
        w: r.width / host.width,
        h: r.height / host.height,
      };
    });
    if (!region) throw new Error("AuthGate node not found in the rendered diagram");
    await post(`/api/internal/sessions/${planSid}/comments`, {
      id: "c_region",
      artifactId: planArt,
      author: "human",
      content: "Does AuthGate short-circuit on an already-expired refresh token, or fall through to TokenStore and 401?",
      target: {
        artifactId: planArt,
        visualId: visId,
        region: { x: region.x, y: region.y, w: region.w, h: region.h, elementIds: region.id ? [region.id] : [], labels: ["AuthGate"] },
      },
    });

    // Reload so the posted comment loads with the artifact, then assert the
    // region highlight + its text mirror render (the #140 selector-integrity
    // check), open the thread so the comment body shows, and capture a tight
    // crop of the visual card — the required hero frame.
    await page.reload();
    await page.waitForSelector("[data-artifact-id]", { timeout: 15_000 });
    await selectPlan();
    await page.waitForSelector('[data-testid="dp-region-highlight"]', { timeout: 10_000 });
    await page.getByRole("button", { name: /on region \[AuthGate\]/ }).first().click();
    await page.waitForTimeout(600);
    const heroCard = page.locator(`[data-comment-anchor="visual:${visId}"]`);
    await heroCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    if (CAPTURE) await heroCard.screenshot({ path: path.join(ASSETS, "region-comment.png") });

    // Second (optional) hero frame — the interaction in progress: a mid-drag
    // marquee over the well. CAPTURE-gated (like enforcement): it holds a mouse
    // button down between moves, so it's a capture concern, not a selector one.
    // The overlay selector itself is asserted here every CI pass.
    await page.waitForSelector('[data-testid="dp-region-overlay"]', { timeout: 10_000 });
    if (CAPTURE) {
      const overlay = page.locator('[data-testid="dp-region-overlay"]');
      const ob = await overlay.boundingBox();
      if (ob) {
        const sx = ob.x + ob.width * 0.30, sy = ob.y + ob.height * 0.28;
        const ex = ob.x + ob.width * 0.62, ey = ob.y + ob.height * 0.80;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 4 });
        await page.mouse.move(ex, ey, { steps: 6 });
        await page.waitForTimeout(150);
        await heroCard.screenshot({ path: path.join(ASSETS, "region-drag.png") });
        await page.mouse.up();
      }
    }

    // #138 — the project-wide decisions view (read-only, all sessions).
    await page.goto(`${base}/?session=${planSid}`);
    await page.waitForSelector("[data-artifact-id]", { timeout: 15_000 });
    await page.getByRole("button", { name: "Open project decisions" }).click();
    await page.getByTestId("decisions-view").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByText("Chose:").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(500);
    await shot("decisions-view.png");

    // #139 — the detail-density dial: the Autonomy popover open, showing the
    // Rich/Terse toggle alongside the autonomy levels. Captured as a top-right
    // clip (trigger button + popover) rather than the whole dimmed page.
    await page.goto(`${base}/?session=${planSid}`);
    await page.waitForSelector("[data-artifact-id]", { timeout: 15_000 });
    await page.getByRole("button", { name: /Autonomy:/ }).click();
    await page.getByRole("radiogroup", { name: "Detail density" }).waitFor({ state: "visible", timeout: 8_000 });
    await page.waitForTimeout(400);
    if (CAPTURE) {
      const panel = page.locator("div.shadow-xl").filter({ hasText: "How much structured review" });
      const pb = await panel.boundingBox();
      if (pb) {
        const x = Math.max(0, pb.x - 16);
        await page.screenshot({
          path: path.join(ASSETS, "detail-density.png"),
          clip: { x, y: 4, width: Math.min(1440 - x, pb.width + 40), height: pb.y + pb.height + 12 },
        });
      }
    }
  } finally {
    // I1 — teardown BARRIER: block until the daemon is fully down (process
    // exited AND port released) before removing its dirs, so this opt-in spec
    // can't leave a LISTENING daemon behind. See daemon-harness.ts.
    await teardownDaemon(proc, info?.port);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    await context.close();
  }
});
