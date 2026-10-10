/**
 * #470 slice 3 (design §9) — the guarantee wording changed with the feature;
 * these pins keep the docs consistent with what ships.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWANCE_CEILING_MS } from "../daemon/stance-exceptions.js";
import { STANCE_ALLOW_ASK_REASON } from "../hooks/stance-allow-ask.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8").replace(/\s+/g, " ");

describe("#470 docs match the behaviour", () => {
  it("README: Allow once keeps the stance; Retire deletes it; no 'one click' Retire left", () => {
    const readme = read("README.md");
    expect(readme).toContain("Choose **Allow this proposal once** to let that exact proposal through and keep the stance; **Retire this stance** deletes it.");
    expect(readme).not.toContain('One click on "Retire this stance"');
    expect(readme).not.toMatch(/one-click override/);
    expect(ALLOWANCE_CEILING_MS).toBe(72 * 3600_000);
    expect(readme).toContain("after 72 hours");
    expect(readme).toContain("never mirrored to the cross-project ledger");
    expect(readme).toContain("behind a confirm");
    expect(readme).toMatch(/one narrow `Bash` check asks/i);
    expect(readme).toContain("not tamper-evident");
  });

  it("FAQ: no 'one-click overridable'; Allow once isn't mirrored and records no approval", () => {
    const faq = read("docs/faq.md");
    expect(faq).not.toMatch(/one-click overridable|one click from an override/);
    expect(faq).toContain("**not** mirrored to the cross-project ledger and records no approval");
    expect(faq).toContain("behind a confirm");
  });

  it("SECURITY: human-only by design, not by enforcement; receipts not tamper-evident; the Bash hook's exact reason", () => {
    const sec = read("SECURITY.md");
    expect(sec).toContain("human-only by design, not by enforcement");
    expect(sec).toContain("**not tamper-evident**");
    expect(sec).toContain("self-reported header");
    expect(sec).toContain("installs three Claude Code hooks");
    expect(sec).toContain(STANCE_ALLOW_ASK_REASON.replace(/\s+/g, " "));
  });

  it("SKILL: retry the identical call only after your pair allowed it; never grant it yourself", () => {
    const skill = read("claude-plugin/skills/pairing-protocol/SKILL.md");
    expect(skill).toContain("retry the IDENTICAL call only after they say they did");
    expect(skill).toContain("Never try to grant it yourself");
  });
});
