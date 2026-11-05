import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARIA_KEYS, EVIDENCE_TOP_LEVEL_KEYS, LAYOUT_KEYS, PROVENANCE_KEYS, sanitizeEvidence, stageEvidence, validateEvidence } from "../../scripts/stage-attention-evidence.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative: string) => fs.readFileSync(path.resolve(packageRoot, relative), "utf8");
const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const provenance = () => ({
  gitSha: SHA, trackedWorktreeDirty: false, trackedDiffSha256: DIGEST, daemonEntrySha256: DIGEST,
  distManifestSha256: DIGEST, distFiles: 1, webManifestSha256: DIGEST, webFiles: 1,
  sharedManifestSha256: DIGEST, harnessSourceSha256: DIGEST, lockfileSha256: DIGEST,
});
const evidence = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  runtime: { gitSha: SHA, node: "v22.0.0", platform: "linux", playwright: "1.60.0", browser: "140", startups: [provenance()], atSave: provenance(), builtRuntimeStable: true, provenanceLimit: "limit" },
  syntheticOnly: true, status: "passed", cleanup: "removed", mode: "OFF", theme: "dark", viewport: { width: 1280, height: 800 },
  scenario: { id: "E1", task: "task", boundSession: "ask" }, matrix: { caseCount: 1, cases: ["E1"] },
  seedDigest: DIGEST, seedOperations: [{ session: "ask", route: "register", body: { title: "t", file: "synthetic/step-1.ts" } }], recipeDigest: DIGEST,
  keyboard: { presses: 0, truncated: false, events: [] }, clocks: { keyboardAndCaptures: "ms", liveRegions: "ms" }, assertions: [],
  captures: [{ step: "landing", atMs: 1, screenshot: "landing.png", aria: { main: "text" }, visibleText: "text" }],
  liveRegions: { entries: [], truncated: false }, limitations: ["limit"],
  ...overrides,
});

const roots: string[] = [];
function tree(files: Record<string, string | Buffer>): { from: string; to: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-evidence-stage-"));
  roots.push(root);
  const from = path.join(root, "from");
  for (const [relative, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(from, relative)), { recursive: true });
    fs.writeFileSync(path.join(from, relative), body);
  }
  fs.mkdirSync(from, { recursive: true });
  return { from, to: path.join(root, "to") };
}
const listed = (directory: string): string[] => (fs.readdirSync(directory, { recursive: true }) as string[])
  .filter((entry) => fs.statSync(path.join(directory, entry)).isFile()).map((entry) => entry.split(path.sep).join("/")).sort();
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("#430 slice 2 — evidence staging", () => {
  it("stages only validated evidence and the PNGs it names", () => {
    const { from, to } = tree({
      "row/evidence.v1.json": JSON.stringify(evidence()), "row/landing.png": PNG,
      "row/unreferenced.png": PNG, "row/trace.zip": "trace", "row/daemon-diagnostics.txt": "log",
      "row/attachments/attention-evidence-v1-abc.json": JSON.stringify(evidence()), "stray.json": "{}",
    });
    const report = stageEvidence({ from, to, sha: SHA });
    expect(report.rejected).toEqual([]);
    expect(listed(to)).toEqual(["row/evidence.v1.json", "row/landing.png"]);
  });

  it.each([
    "/home/runner/work/deepPairing/x.ts", "/tmp/dp-attention-abc/project", "/Users/mitch/secret", "/mnt/c/Users/mitch/Documents",
    "/data/alice/private.txt", "/builds/private/work/file.ts", "/single-root-file.txt", "/api/../../home/alice",
    "~/.ssh/id_ed25519", "~alice/notes.txt", "$HOME/.aws/credentials", "${HOME}/.aws/credentials", "%USERPROFILE%\\notes.txt",
    "C:\\Users\\mitch\\x", "C:/Users/mitch/x", "file:///home/mitch/x", "\\\\server\\share\\x", "\\Users\\mitch\\x",
    "cwd=/srv/app/x", "path:/opt/app/x",
  ])("redacts %s whatever its root is called", (value) => {
    const { evidence: out, replaced } = sanitizeEvidence(evidence({ failure: `failed at ${value} today` }));
    expect(replaced).toBe(1);
    expect(out.failure).toMatch(/^failed at (?:cwd=|path:)?<absolute-path> today$/);
  });

  it("keeps URLs, app routes and relative text, and redacts keys too", () => {
    const benign = "synthetic/step-1.ts ./local ../up OFF/ON 1/2 ~5 minutes Escape / Home http://127.0.0.1:33000/tmp/x wss://host/home/y /api/preflight-blocks /?session=abc - /url: /deeppairing:delegate";
    expect(sanitizeEvidence(evidence({ failure: benign })).evidence.failure).toBe(benign);
    const nested = sanitizeEvidence(evidence({ seedOperations: [{ "/home/mitch/key": ["/tmp/x"] }] })).evidence;
    expect(JSON.stringify(nested.seedOperations)).not.toMatch(/home|tmp/);
  });

  it("stages sanitized bytes, never the original", () => {
    const { from, to } = tree({ "row/evidence.v1.json": JSON.stringify(evidence({ failure: "at /home/mitch/private.ts" })), "row/landing.png": PNG });
    expect(stageEvidence({ from, to, sha: SHA }).pathsReplaced).toBe(1);
    const staged = fs.readFileSync(path.join(to, "row/evidence.v1.json"), "utf8");
    expect(staged).not.toContain("mitch");
    expect(JSON.parse(staged).sanitization).toEqual({ absolutePathsReplaced: 1 });
  });

  it.each([
    ["an unknown top-level key", evidence({ environment: { HOME: "x" } }), /unexpected key/],
    ["a missing digest", evidence({ recipeDigest: "nope" }), /sha256/],
    ["a different commit", evidence({ runtime: { ...(evidence().runtime as object), gitSha: "c".repeat(40) } }), /dispatched SHA/],
    ["a non-synthetic row", evidence({ syntheticOnly: false }), /syntheticOnly/],
    ["a screenshot path", evidence({ captures: [{ step: "s", atMs: 1, screenshot: "../../x.png", aria: {}, visibleText: "" }] }), /bare .png/],
  ])("rejects %s", (_name, value, message) => {
    expect(() => validateEvidence(value, SHA)).toThrow(message);
    const { from, to } = tree({ "row/evidence.v1.json": JSON.stringify(value), "row/landing.png": PNG });
    const report = stageEvidence({ from, to, sha: SHA });
    expect(report.rejected).toHaveLength(1);
    expect(listed(to)).toEqual([]);
  });

  const capture = (overrides: Record<string, unknown>) => [{ step: "s", atMs: 1, screenshot: "landing.png", aria: {}, visibleText: "", ...overrides }];
  const seed = (body: unknown) => [{ session: "ask", route: "register", body }];
  const layoutRow = Object.fromEntries(Object.keys(LAYOUT_KEYS).map((key) => [key, null]));
  Object.assign(layoutRow, { step: "s", atMs: 1, settled: true, viewportHeight: 800, agentsFilterSurface: "none", sidebarRows: 0 });

  it("accepts every optional and dynamic field the harness can write", () => {
    expect(() => validateEvidence(evidence({
      failure: "synthetic", layout: [layoutRow], liveRegions: { entries: [{ atMs: 1, role: null, live: "polite", text: "t" }], truncated: false, unavailable: true },
      seedOperations: [...seed({ title: "t", content: { findings: [{ detail: "d" }] } }), { operation: "restart" }],
      keyboard: { presses: 1, truncated: false, events: [{ key: "Tab", atMs: 1, focused: { tag: "A", role: null, name: "n", testId: null, disabled: false } }] },
      captures: capture({ aria: { nextUp: "a", pending: "b", sessions: "c", main: "d" } }),
    }), SHA)).not.toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ["scenario.environment", { scenario: { id: "E", task: "t", boundSession: "b", environment: { PRIVATE_SETTING: "synthetic-value" } } }],
    ["liveRegions.trace", { liveRegions: { trace: "synthetic network dump", entries: [], truncated: false } }],
    ["viewport", { viewport: { width: 1, height: 1, headers: {} } }],
    ["matrix", { matrix: { caseCount: 1, cases: [], env: "x" } }],
    ["keyboard", { keyboard: { presses: 0, truncated: false, events: [], trace: "x" } }],
    ["a keyboard event", { keyboard: { presses: 1, truncated: false, events: [{ key: "Tab", atMs: 1, focused: { tag: "A", role: null, name: "n", testId: null, disabled: false, html: "x" } }] } }],
    ["clocks", { clocks: { keyboardAndCaptures: "ms", liveRegions: "ms", cookie: "x" } }],
    ["runtime", { runtime: { ...(evidence().runtime as object), env: { HOME: "x" } } }],
    ["a provenance entry", { runtime: { ...(evidence().runtime as object), atSave: { ...provenance(), env: "x" } } }],
    ["an assertion", { assertions: [{ label: "l", passed: true, log: "x" }] }],
    ["a capture", { captures: capture({ network: "x" }) }],
    ["capture aria", { captures: capture({ aria: { har: "x" } }) }],
    ["a live region entry", { liveRegions: { entries: [{ atMs: 1, role: null, live: null, text: "t", trace: "x" }], truncated: false } }],
    ["a layout row", { layout: [{ ...layoutRow, html: "x" }] }],
    ["a seed operation", { seedOperations: [{ ...seed({})[0], headers: {} }] }],
  ])("rejects an unexpected key nested in %s", (_name, overrides) => {
    expect(() => validateEvidence(evidence(overrides), SHA)).toThrow(/unexpected key/);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["a seed body with an environment", { seedOperations: seed({ content: { environment: { A: "b" } } }) }, /out-of-scope key "environment"/],
    ["a seed body with a nested trace", { seedOperations: seed({ list: [{ trace: "x" }] }) }, /out-of-scope key "trace"/],
    ["a seed body key that is a path", { seedOperations: seed({ "/home/alice/x": 1 }) }, /plain field name/],
    ["a very deep seed body", { seedOperations: seed(JSON.parse(`${'{"a":'.repeat(12)}1${"}".repeat(12)}`)) }, /deeper than/],
    ["a very long seed string", { seedOperations: seed({ title: "x".repeat(5000) }) }, /longer than/],
    ["an unbounded seed body", { seedOperations: seed({ list: Array.from({ length: 2500 }, () => 1) }) }, /more than/],
    ["a non-string aria value", { captures: capture({ aria: { main: { dump: "x" } } }) }, /must be a string/],
    ["oversized aria text", { captures: capture({ aria: { main: "x".repeat(40_000) } }) }, /longer than/],
    ["oversized visible text", { captures: capture({ visibleText: "x".repeat(30_000) }) }, /longer than/],
    ["a seed route that isn't one", { seedOperations: [{ session: "ask", route: "/home/alice", body: {} }] }, /daemon route/],
    ["a wrong field type", { viewport: { width: "1280", height: 800 } }, /must be a number/],
  ])("rejects %s", (_name, overrides, message) => {
    expect(() => validateEvidence(evidence(overrides), SHA)).toThrow(message);
  });

  it("rejects credentials, malformed JSON, fake PNGs and symlinks without leaking the path", () => {
    expect(() => sanitizeEvidence(evidence({ failure: `token ghp_${"x".repeat(30)}` }))).toThrow(/credential/);
    const { from, to } = tree({
      "json/evidence.v1.json": "{", "fake/evidence.v1.json": JSON.stringify(evidence()), "fake/landing.png": "not a png",
      "missing/evidence.v1.json": JSON.stringify(evidence()),
    });
    fs.mkdirSync(path.join(from, "link"));
    fs.symlinkSync(path.join(from, "json/evidence.v1.json"), path.join(from, "link/evidence.v1.json"));
    const report = stageEvidence({ from, to, sha: SHA });
    expect(report.staged).toEqual([]);
    expect(report.rejected.map((row) => row.file).sort()).toEqual(["fake/evidence.v1.json", "json/evidence.v1.json", "link/evidence.v1.json", "missing/evidence.v1.json"].map((file) => file.split("/").join(path.sep)));
    expect(JSON.stringify(report.rejected)).not.toContain(path.dirname(from));
    expect(listed(to)).toEqual([]);
  });

  it("refuses a staging directory that already holds files", () => {
    const { from, to } = tree({});
    fs.mkdirSync(to); fs.writeFileSync(path.join(to, "old.json"), "{}");
    expect(() => stageEvidence({ from, to, sha: SHA })).toThrow(/new or empty/);
  });

  describe("stays in step with what the harness writes", () => {
    const harness = read("e2e/attention-walkthrough-harness.ts");
    const interfaceKeys = (name: string) => {
      const start = harness.indexOf(`interface ${name} {`);
      return [...harness.slice(start, harness.indexOf("\n}", start)).matchAll(/(\w+)(?=:)/g)].map((match) => match[1]!).sort();
    };

    it("top-level keys", () => {
      // The first `const evidence = {` in the file is observe()'s browser script.
      const save = harness.indexOf("async save(");
      const body = harness.slice(harness.indexOf("const evidence = {", save), harness.indexOf('const file = this.info.outputPath("evidence.v1.json")', save));
      const keys = body.split("\n").filter((line) => /^ {6}\S/.test(line) && !line.trim().startsWith("..."))
        .flatMap((line) => {
          let flat = line.trim();
          for (let previous = ""; previous !== flat;) { previous = flat; flat = flat.replace(/\([^()]*\)|\{[^{}]*\}|\[[^[\]]*\]/g, ""); }
          return flat.split(",").map((piece) => piece.split(":")[0]!.trim()).filter((key) => /^\w+$/.test(key));
        });
      expect(keys.sort()).toEqual([...EVIDENCE_TOP_LEVEL_KEYS].sort());
      expect(body).toContain("{ layout: this.layouts }");
      expect(body).toContain("{ failure: redactDiagnostic");
    });

    it("provenance and layout keys", () => {
      expect(interfaceKeys("RuntimeProvenance")).toEqual(Object.keys(PROVENANCE_KEYS).sort());
      expect(interfaceKeys("LayoutMeasure")).toEqual(Object.keys(LAYOUT_KEYS).sort());
    });

    it("capture aria keys", () => {
      const method = harness.slice(harness.indexOf("async capture("), harness.indexOf("async save("));
      expect([...method.matchAll(/(\w+): this\.page\.(?:getByRole)/g)].map((match) => match[1]!).sort()).toEqual(Object.keys(ARIA_KEYS).sort());
    });
  });
});

describe("#430 slice 2 — the evidence workflow stays separate and bounded", () => {
  const workflow = read("../../.github/workflows/attention-evidence.yml");

  it("runs only on dispatch, read-only, with no secrets and no persisted token", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m);
    expect(workflow).not.toMatch(/pull_request|schedule:|\bpush:/);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(/secrets\.|GITHUB_TOKEN|DEEPPAIRING_PORT/);
    expect(workflow).toContain("persist-credentials: false");
  });

  it("pins the runtime as ordinary E2E does, with explicit time and concurrency bounds", () => {
    const ci = read("../../.github/workflows/ci.yml");
    const e2e = ci.slice(ci.indexOf("  e2e:"), ci.indexOf("  hook-smoke:"));
    for (const pin of ["runs-on: ubuntu-24.04", "actions/checkout@v6", "pnpm/action-setup@v6", "actions/setup-node@v6", "node-version: 22"]) {
      expect(e2e).toContain(pin);
      expect(workflow).toContain(pin);
    }
    expect(workflow).toMatch(/^ {4}timeout-minutes: \d+$/m);
    const concurrency = workflow.slice(workflow.indexOf("\nconcurrency:"), workflow.indexOf("\njobs:"));
    expect(concurrency).toContain("group: attention-evidence-${{ github.ref }}");
    expect(concurrency).toContain("cancel-in-progress: false");
    expect(workflow).toContain("run: pnpm build:clean");
    expect(workflow).toContain("playwright test --config playwright.attention.config.ts");
  });

  it("uploads only the staged PNGs and evidence, even on failure", () => {
    const staging = workflow.indexOf("stage-attention-evidence.mjs");
    const upload = workflow.slice(workflow.indexOf("uses: actions/upload-artifact"));
    expect(staging).toBeGreaterThan(workflow.indexOf("playwright test --config"));
    expect(staging).toBeLessThan(workflow.indexOf("uses: actions/upload-artifact"));
    expect(workflow.match(/uses: actions\/upload-artifact/g)).toHaveLength(1);
    expect(workflow.slice(workflow.lastIndexOf("- name:", workflow.indexOf("uses: actions/upload-artifact")))).toContain("if: always()");
    expect(upload.match(/path: \|\n([\s\S]*?)\n\s+if-no-files-found:/)?.[1]?.split("\n").map((line) => line.trim())).toEqual([
      "${{ runner.temp }}/attention-evidence/**/*.png",
      "${{ runner.temp }}/attention-evidence/**/evidence.v1.json",
    ]);
  });

  it("leaves ordinary CI out of it", () => {
    const ci = read("../../.github/workflows/ci.yml");
    expect(ci).not.toContain("playwright.attention.config");
    expect(ci).not.toContain("attention-evidence");
    expect(read("playwright.config.ts")).toContain('testMatch: "**/*.e2e.ts"');
    expect(read("playwright.attention.config.ts")).toContain('testMatch: "**/*.walkthrough.ts"');
  });
});
