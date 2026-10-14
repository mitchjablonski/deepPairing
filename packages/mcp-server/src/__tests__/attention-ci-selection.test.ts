import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSmokeSelection } from "../../scripts/check-attention-smoke-selection.mjs";
import { SMOKE_USE, SMOKE_TIMEOUT_MS } from "../../e2e/attention-ci-smoke.js";

const riskTags = ["@attention-smoke", "@queue-arrows", "@why-immediate-escape", "@removed-focus", "@dark-light-axe"];
const report = () => ({ suites: [{ file: "attention-ci-smoke.e2e.ts", specs: [
  ...["dark", "light"].map((theme) => ({ title: `Next-up CI smoke ${theme}`, tags: [...riskTags], tests: [{ expectedStatus: "passed", annotations: [] as Array<{ type: string }> }] })),
  { title: "Next-up CI smoke failure control", tags: ["@attention-smoke", "@failure-control"], tests: [{ expectedStatus: "passed", annotations: [] as Array<{ type: string }> }] },
], suites: [] as Array<{ file: string }> }] });

describe("#531 — ordinary CI smoke selection and artifact policy", () => {
  it("requires exactly both themed journeys and the real failure control", () => {
    expect(validateSmokeSelection(report())).toEqual({ selectedCount: 3, cases: ["Next-up CI smoke dark", "Next-up CI smoke light", "Next-up CI smoke failure control"] });
  });
  it("rejects an empty normal selection", () => expect(() => validateSmokeSelection({ suites: [] })).toThrow(/exactly the three/));
  it.each(["skip", "fixme"])("rejects a %s smoke", (type) => {
    const fixture = report();
    fixture.suites[0]!.specs[0]!.tests[0]!.annotations.push({ type });
    expect(() => validateSmokeSelection(fixture)).toThrow(/without skip/);
  });
  it("rejects a smoke that is an expected failure", () => {
    const fixture = report(); fixture.suites[0]!.specs[0]!.tests[0]!.expectedStatus = "failed";
    expect(() => validateSmokeSelection(fixture)).toThrow(/expected failure/);
  });
  it("rejects a missing risk regression", () => {
    const fixture = report(); fixture.suites[0]!.specs[0]!.tags = riskTags.filter((tag) => tag !== "@why-immediate-escape");
    expect(() => validateSmokeSelection(fixture)).toThrow(/required risk/);
  });
  it("rejects duplicate cases or an accidental second browser project", () => {
    const duplicate = report(); duplicate.suites[0]!.specs.push(duplicate.suites[0]!.specs[0]!);
    expect(() => validateSmokeSelection(duplicate)).toThrow(/exactly the three/);
    const projects = report(); projects.suites[0]!.specs[0]!.tests.push({ expectedStatus: "passed", annotations: [] });
    expect(() => validateSmokeSelection(projects)).toThrow(/once per case/);
  });
  it("rejects a decoy source or opt-in walkthrough in ordinary selection", () => {
    const decoy = report(); decoy.suites[0]!.file = "decoy.e2e.ts";
    expect(() => validateSmokeSelection(decoy)).toThrow(/unexpected source/);
    const walkthrough = report(); walkthrough.suites[0]!.suites.push({ file: "attention-keyboard.walkthrough.ts" });
    expect(() => validateSmokeSelection(walkthrough)).toThrow(/Opt-in walkthrough/);
  });
  it("pins failure-only screenshots, disabled raw trace/video and a bounded test timeout", () => {
    expect(SMOKE_USE.trace).toBe("off"); expect(SMOKE_USE.video).toBe("off");
    expect(SMOKE_USE.screenshot).toBe("only-on-failure"); expect(SMOKE_TIMEOUT_MS).toBe(60_000);
  });
  it("keeps normal and opt-in output directories as distinct siblings", () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const output = (file: string) => fs.readFileSync(path.join(packageRoot, file), "utf8").match(/outputDir:\s*"([^"]+)"/)?.[1];
    const ordinary = output("playwright.config.ts"), walkthrough = output("playwright.attention.config.ts");
    expect(ordinary).toBe("test-results/e2e");
    expect(walkthrough).toBe("test-results/attention-walkthroughs");
    expect(path.dirname(ordinary!)).toBe(path.dirname(walkthrough!));
    expect(ordinary).not.toBe(walkthrough);
  });
  it("wires the guard before actual E2E, keeps the job bound and uploads only approved failure evidence", () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const workflow = fs.readFileSync(path.resolve(packageRoot, "../../.github/workflows/ci.yml"), "utf8");
    const job = workflow.slice(workflow.indexOf("  e2e:"), workflow.indexOf("  hook-smoke:"));
    expect(job).toContain("timeout-minutes: 25");
    expect(job.indexOf("test:e2e:attention-selection")).toBeGreaterThanOrEqual(0);
    expect(job.indexOf("test:e2e:attention-selection")).toBeLessThan(job.indexOf("test:e2e\n"));
    const upload = job.match(/path: \|\n([\s\S]*?)\s+if-no-files-found:/)?.[1];
    expect(upload?.split("\n").map((line) => line.trim()).filter(Boolean)).toEqual([
      "packages/mcp-server/test-results/**/test-failed-*.png",
      "packages/mcp-server/test-results/**/*diagnostics*.txt",
    ]);
    expect(job).not.toContain("pass-with-no-tests");
  });
});
