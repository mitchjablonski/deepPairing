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

  it("#503 review — every 'you get a prompt' claim carries the permission-mode caveat, and SECURITY states the route residual precisely", () => {
    // #503 round 2 (Luna) — the docs say what Claude Code's own docs say, no
    // more: dontAsk DENIES, auto still prompts, -p depends on the host.
    const flat = (rel: string) => read(rel).replace(/\s+/g, " ");
    for (const rel of ["README.md", "SECURITY.md", "claude-plugin/skills/pairing-protocol/SKILL.md"]) {
      const doc = flat(rel);
      expect(doc, rel).not.toMatch(/treated as `allow`|that prompt is skipped|auto mode it becomes `deny`/);
    }
    expect(flat("README.md")).toContain("`bypassPermissions` skips prompts, so the command can run without one; `dontAsk` denies it instead of asking; and a `-p` run with no one to answer denies it");
    const security = flat("SECURITY.md");
    for (const quote of [
      "\"Auto-denies every call that would otherwise prompt\"",
      "the classifier can still deny the tool call, but it can't approve the call silently",
      "Pass `none` when nobody can answer, and Claude Code denies them instead",
      "read conservatively, `dontAsk` never shows you this prompt",
      "Claude Code v2.1.293, unsandboxed, a hostless `-p` run (no Agent SDK host, no `--permission-prompt-tool`), with that allow rule in place",
      "https://code.claude.com/docs/en/hooks#pretooluse-decision-control",
      "https://code.claude.com/docs/en/permissions#permission-modes",
      "https://code.claude.com/docs/en/cli-reference",
    ]) expect(security).toContain(quote);
    expect(flat("claude-plugin/skills/pairing-protocol/SKILL.md")).toContain("In `dontAsk` or a `-p` run with no one to answer, the command is refused; in `bypassPermissions` there may be no prompt at all.");
    const sec = read("SECURITY.md");
    expect(sec).toContain("read the bearer token from `.deeppairing/daemon.json` (or its runtime sidecar) and call `POST /api/preflight-blocks/<id>/exception` itself");
    expect(sec).toContain("a matching command asks even if the rest of the payload is malformed");
  });
});
