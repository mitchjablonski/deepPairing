#!/usr/bin/env node
// Validate remote Playwright --list JSON before running the fixed S3 subset.
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = new Set(["S3 OFF 1280x800", "S3 OFF 1920x1080", "S3 ON 1280x800", "S3 ON 1920x1080"]);
const actual = [];
function visit(suite, parents = []) {
  const names = [...parents, suite.title];
  for (const spec of suite.specs ?? []) {
    const scenario = names.find((name) => expected.has(name));
    if (!scenario || spec.title !== "Find the high-stakes item and clear thirteen reviews" || spec.tests?.length !== 1) throw new Error("Unexpected S3 listing: " + names.join(" / ") + " / " + spec.title);
    actual.push(scenario);
  }
  for (const child of suite.suites ?? []) visit(child, names);
}
for (const suite of report.suites ?? []) visit(suite);
if (actual.length !== 4 || new Set(actual).size !== 4 || actual.some((name) => !expected.has(name))) throw new Error("Expected exactly four distinct S3 cases, received " + JSON.stringify(actual));
console.log("Verified fixed S3 cases: " + actual.sort().join(", "));
