import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expected = ["Next-up CI smoke dark", "Next-up CI smoke light", "Next-up CI smoke failure control"];
const risks = ["queue-arrows", "why-immediate-escape", "removed-focus", "dark-light-axe"];

export function validateSmokeSelection(report) {
  if (report.errors?.length) throw new Error("Normal E2E listing reported errors");
  const selected = [];
  const visit = (suite) => {
    if (String(suite.file ?? "").endsWith(".walkthrough.ts")) throw new Error("Opt-in walkthrough entered ordinary E2E selection");
    for (const original of suite.specs ?? []) {
      // Playwright's JSON reporter removes the leading @ from tag metadata.
      const spec = { ...original, tags: (original.tags ?? []).map((tag) => String(tag).replace(/^@/, "")) };
      if (!spec.tags.includes("attention-smoke")) continue;
      const file = String(spec.file ?? suite.file ?? "").replaceAll("\\", "/");
      if (file !== "attention-ci-smoke.e2e.ts" && !file.endsWith("/attention-ci-smoke.e2e.ts")) throw new Error("Attention smoke was selected from an unexpected source file");
      selected.push(spec);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  if (selected.length !== expected.length || expected.some((title) => selected.filter((spec) => spec.title === title).length !== 1)) throw new Error("Ordinary E2E must select exactly the three intended attention smoke cases");
  for (const spec of selected) {
    if (spec.tests?.length !== 1 || spec.tests[0].expectedStatus !== "passed" || (spec.tests[0].annotations ?? []).some((annotation) => ["skip", "fixme"].includes(annotation.type))) throw new Error("Attention smoke must run once per case, without skip/fixme/expected failure");
    if (spec.title !== expected[2] && risks.some((tag) => !spec.tags.includes(tag))) throw new Error("Themed attention smoke is missing a required risk regression");
    if (spec.title === expected[2] && !spec.tags.includes("failure-control")) throw new Error("Attention smoke is missing its real failure control");
  }
  return { selectedCount: selected.length, cases: expected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (!pkg.scripts?.["test:e2e"] || pkg.scripts["test:e2e"].includes("--pass-with-no-tests")) throw new Error("Normal test:e2e must exist and must not permit an empty pass");
    const launcher = process.env.npm_execpath;
    if (!launcher) throw new Error("Run this selection guard through the pnpm package script");
    const started = performance.now();
    // List the ACTUAL normal package script, including any future selectors.
    // A separate config-only list could pass while CI excluded the smoke file.
    const child = spawnSync(process.execPath, [launcher, "--silent", "run", "test:e2e", "--list", "--reporter=json"], {
      cwd: packageRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (child.error || child.status !== 0) throw new Error(`Normal E2E listing failed (exit ${child.status ?? "unavailable"}); child output withheld`);
    let report;
    try { report = JSON.parse(child.stdout); }
    catch { throw new Error("Normal E2E listing did not emit valid JSON; child output withheld"); }
    const result = validateSmokeSelection(report);
    console.log(JSON.stringify({ ...result, listingMs: Math.round(performance.now() - started) }));
  } catch (error) {
    // Error messages are bounded static guard failures; no raw child payload.
    console.error(`[attention-smoke-selection] ${String(error).slice(0, 500)}`);
    process.exitCode = 1;
  }
}
