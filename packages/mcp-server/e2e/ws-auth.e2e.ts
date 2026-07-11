import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * #159 — the GG2/II2/D5 WebSocket upgrade auth, proven against a REAL spawned
 * daemon over a real TCP socket. The factory-level tests (#178,
 * create-daemon.ws-upgrade.test.ts) drive the same handler in-process; this
 * spec is the belt for the FIELD path: dist/daemon/index.js's bind loop +
 * attachUpgradeHandler on the real accept socket, raw HTTP upgrade frames.
 *
 *   - hostile Origin (another local page / a random site) → destroyed, no 101
 *   - missing or wrong projectHash → fail-closed 403 (II2), no 101
 *   - well-formed connect → 101 + the `connected` frame carrying the
 *     daemon's projectHash
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");

let proc: ChildProcess | undefined;
let projectRoot: string;
// K2 — isolated HOME; never the real ~/.deeppairing.
let home: string;
let baseURL: string;
let projectHash: string;

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-wsauth-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-wsauth-"));
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
  let port = 0;
  for (let i = 0; i < 120 && !port; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`).catch(() => null);
        if (res?.ok) {
          const di = (await res.json()) as { projectHash?: string };
          port = info.port;
          projectHash = di.projectHash ?? "";
        }
      }
    } catch {}
    if (!port) await new Promise((r) => setTimeout(r, 250));
  }
  if (!port) throw new Error("daemon did not become reachable within 30s");
  if (!projectHash) throw new Error("daemon did not advertise a projectHash");
  baseURL = `http://localhost:${port}`;
});

test.afterAll(async () => {
  // I1 — teardown barrier (see daemon-harness.ts).
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

interface WsOutcome {
  outcome: "connected" | "rejected";
  /** HTTP status when the server answered the upgrade with a full response. */
  status?: number;
  /** Parsed first frame on the connected path. */
  firstFrame?: { type?: string; projectHash?: string };
}

/** Attempt a WS upgrade and report what ACTUALLY happened on the wire. On a
 *  successful upgrade, waits for the first server frame. Bounded — never
 *  hangs a spec on a silent socket. */
function wsAttempt(url: string, headers?: Record<string, string>): Promise<WsOutcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve({ outcome: "rejected" });
    }, 10_000);
    const done = (r: WsOutcome) => {
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      resolve(r);
    };
    // The daemon answers a refused upgrade with `HTTP/1.1 403` then destroys
    // the socket; ws surfaces that as 'unexpected-response' (full response
    // read) or 'error' (reset raced the read). Both are rejections.
    ws.on("unexpected-response", (_req, res) => done({ outcome: "rejected", status: res.statusCode }));
    ws.on("error", () => done({ outcome: "rejected" }));
    ws.on("open", () => {
      ws.once("message", (data) => {
        try {
          done({ outcome: "connected", firstFrame: JSON.parse(String(data)) });
        } catch {
          done({ outcome: "connected", firstFrame: {} });
        }
      });
    });
  });
}

test("WS upgrade: hostile Origin and missing/wrong project hash are rejected; a good connect gets the `connected` frame", async () => {
  const wsBase = baseURL.replace(/^http/, "ws");

  // 1. Correct hash but a foreign Origin — the D5 threat: a hostile page the
  //    user visits tries to open a live artifact stream. Must never upgrade.
  const foreignOrigin = await wsAttempt(`${wsBase}/ws?projectHash=${projectHash}`, {
    Origin: "https://evil.example",
  });
  expect(foreignOrigin.outcome).toBe("rejected");
  if (foreignOrigin.status !== undefined) expect(foreignOrigin.status).toBe(403);

  // 1b. The sharper variant: another LOOPBACK port's page (same machine,
  //     different origin) — the exact hole the old any-loopback policy left.
  const otherLoopback = await wsAttempt(`${wsBase}/ws?projectHash=${projectHash}`, {
    Origin: "http://localhost:5500",
  });
  expect(otherLoopback.outcome).toBe("rejected");
  if (otherLoopback.status !== undefined) expect(otherLoopback.status).toBe(403);

  // 2. No projectHash at all — II2 fail-closed (absence is a stale or hostile
  //    caller, not a back-compat case).
  const missingHash = await wsAttempt(`${wsBase}/ws`);
  expect(missingHash.outcome).toBe("rejected");
  if (missingHash.status !== undefined) expect(missingHash.status).toBe(403);

  // 3. Wrong projectHash — the stale-tab-after-port-recycling write hole.
  const wrongHash = await wsAttempt(`${wsBase}/ws?projectHash=deadbeef`);
  expect(wrongHash.outcome).toBe("rejected");
  if (wrongHash.status !== undefined) expect(wrongHash.status).toBe(403);

  // 4. Good connect, tool path (no Origin — curl/wrapper clients send none).
  const noOrigin = await wsAttempt(`${wsBase}/ws?projectHash=${projectHash}`);
  expect(noOrigin.outcome).toBe("connected");
  expect(noOrigin.firstFrame?.type).toBe("connected");
  expect(noOrigin.firstFrame?.projectHash).toBe(projectHash);

  // 5. Good connect, browser path (same-origin Origin header).
  const sameOrigin = await wsAttempt(`${wsBase}/ws?projectHash=${projectHash}`, {
    Origin: baseURL,
  });
  expect(sameOrigin.outcome).toBe("connected");
  expect(sameOrigin.firstFrame?.type).toBe("connected");
  expect(sameOrigin.firstFrame?.projectHash).toBe(projectHash);
});
