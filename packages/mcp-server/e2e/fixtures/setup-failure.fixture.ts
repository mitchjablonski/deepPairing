import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { daemonBeforeAll, test } from "../test.js";
import { spawnDiagnosticProcess } from "../daemon-harness.js";

let proc: ChildProcess | undefined;

daemonBeforeAll(() => [proc], async () => {
  const secret = ["playwright", "fixture", "secret"].join("-");
  proc = spawnDiagnosticProcess(process.execPath, [
    "-e",
    "console.error('Set-Cookie: sid=' + process.env.DP_FIXTURE_CHILD_SECRET + '; HttpOnly'); console.error('deliberate child crash'); process.exit(19)",
  ], { env: { ...process.env, DP_FIXTURE_CHILD_SECRET: secret } });
  await once(proc, "close");
  throw new Error("deliberate beforeAll seed failure");
});

test("never reaches the browser fixture", async () => {});
