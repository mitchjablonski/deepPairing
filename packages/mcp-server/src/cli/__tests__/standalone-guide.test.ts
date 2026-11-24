/**
 * #681 — `deeppairing guide` is the single source of the standalone protocol.
 * These checks hold it to the CLI it ships with: every command and flag it
 * teaches must exist in the real dispatch/parsers, its example must pass the
 * real present_options validator, and the skill stub must defer to it rather
 * than restate it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUIDE_COMMANDS,
  GUIDE_WAIT_STATUSES,
  renderStandaloneGuide,
  standaloneGuideJson,
} from "../standalone-guide.js";
import { validatePresentOptionsInput } from "../../mcp/validate-tool-input.js";
import { DECISION_NON_ANSWERABLE_STATUSES } from "@deeppairing/shared";
import { spawnSync } from "node:child_process";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(here, "..");
const repoRoot = path.resolve(here, "..", "..", "..", "..", "..");
const initSource = fs.readFileSync(path.join(cliDir, "init.ts"), "utf8");
const standaloneSource = fs.readFileSync(path.join(cliDir, "standalone-session.ts"), "utf8");
const INVOCATION = "node /fake/dist/cli/init.js";
const guide = renderStandaloneGuide(INVOCATION);

const cliEntry = path.join(cliDir, "init.ts");
const tsxBin = path.resolve(cliDir, "..", "..", "node_modules", ".bin", "tsx");

/** Run the real CLI (real argv parsing and dispatch) in an empty temp dir. */
function runCli(args: string[]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dp-guide-cli-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, DEEPPAIRING_NO_OPEN: "1", BROWSER: "none" };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.DEEPPAIRING_PROJECT_ROOT;
    return spawnSync(tsxBin, [cliEntry, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("deeppairing guide (#681)", () => {
  it("names every standalone command, the request-ID rules and the refusal rule", () => {
    for (const command of GUIDE_COMMANDS.filter((c) => c !== "guide")) {
      expect(guide).toContain(`deeppairing ${command}`);
    }
    for (const status of GUIDE_WAIT_STATUSES) expect(guide).toContain(`- "${status}":`);
    expect(guide).toContain(DECISION_NON_ANSWERABLE_STATUSES.join(", "));
    expect(guide).not.toMatch(/withdrawn|every command prints/i);
  });

  it("teaches read-page-feedback: passive, anchored, ruleOut, successor, bounds", () => {
    expect(guide).toContain("deeppairing read-page-feedback --session-id <sessionId> --artifact-id <artifactId>");
    expect(guide).toMatch(/never\s+acknowledges anything/);
    expect(guide).toMatch(/while\s+they\s+remain\s+unacknowledged/);
    expect(guide).not.toMatch(/until\s+you\s+address\s+them/);
    for (const field of ["intent", "parentCommentId", "htmlAnchor", "ruleOut", "successor.id", "omittedComments"]) {
      expect(guide).toContain(field);
    }
    expect(guide).toMatch(/Take it out of the page/);
    expect(guide).toContain("at most 50 comments and 64 KiB");
    expect(guide).toMatch(/Page notes without an anchor\s+and file-watch notices are not/);
    expect(guide).not.toContain("#679");
    expect(guide).toContain("--wait-ms");
    expect(guide).toContain("rejected_approach_blocked");
    expect(guide).toMatch(/Do NOT retry the same approach/);
    expect(guide).toMatch(/reuse\s+the SAME UUID/);
    expect(guide).toMatch(/use a NEW UUID/);
    expect(guide).toContain("companionUrl");
    expect(guide).toContain(INVOCATION);
  });

  it("keeps Claude Code-only features inside the one marked note", () => {
    const marker = "NOTE, CLAUDE CODE ONLY";
    expect(guide).toContain(marker);
    const before = guide.slice(0, guide.indexOf(marker));
    expect(before).not.toMatch(/PreToolUse|MCP tool|Claude Code/);
  });

  it("every command it teaches is dispatched by init.ts", () => {
    for (const command of GUIDE_COMMANDS) {
      const [top, sub] = command.split(" ");
      expect(initSource, `init.ts dispatches ${top}`).toContain(`cmd === "${top}"`);
      if (sub) expect(standaloneSource, `present dispatches ${sub}`).toMatch(new RegExp(`args\\[0\\] [!=]== "${sub}"`));
    }
  });

  it("teaches guarded inline page revision and preserves pending feedback", () => {
    expect(guide).toContain("deeppairing revise-page --session-id <sessionId> --artifact-id <artifactId> --request-id <uuid> --file page.html --reason");
    expect(guide).toContain("keeps human feedback pending");
    expect(guide).toContain("--ack-comment-id <commentId> ...");
    expect(guide).toContain("this page or a direct ancestor");
    expect(guide).toContain("acknowledgedCommentIds");
    expect(guide).toContain("a comment that is already acknowledged is safe");
    expect(guide).toContain("You can answer a question in the revised page.");
    expect(guide).toContain("Use the separate suggestion review flow for suggestions.");
    expect(guide).toContain("leaves the rule-out status unchanged");
    expect(guide).toContain("For a watched page, edit the source file.");
    expect(guide).toContain("includes currentArtifactId.");
  });

  it("mentions no command outside the known list", () => {
    const mentioned = new Set<string>();
    for (const match of guide.matchAll(/deeppairing ([a-z-]+)(?: (options|page))?/g)) {
      mentioned.add(match[2] ? `${match[1]} ${match[2]}` : match[1]!);
    }
    // "deeppairing standalone protocol" is the heading, not a command.
    mentioned.delete("standalone");
    expect([...mentioned].filter((c) => !(GUIDE_COMMANDS as readonly string[]).includes(c))).toEqual([]);
  });

  it("every flag it teaches is parsed by the standalone commands", () => {
    const flags = new Set(guide.match(/--[a-z][a-z-]+/g));
    for (const flag of flags) {
      const name = flag.slice(2);
      const parsed = standaloneSource.includes(`"${name}": {`) || standaloneSource.includes(` ${name}: {`);
      expect(parsed, `${flag} is parsed in standalone-session.ts`).toBe(true);
    }
  });

  it("its options example passes the real present_options validator", () => {
    const { optionsExample } = standaloneGuideJson(INVOCATION);
    const result = validatePresentOptionsInput(structuredClone(optionsExample));
    expect(result.ok).toBe(true);
  });

  it("--json carries the same guide text and command list", () => {
    const json = JSON.parse(JSON.stringify(standaloneGuideJson(INVOCATION)));
    expect(json.guide).toBe(guide);
    expect(json.commands).toEqual([...GUIDE_COMMANDS]);
    expect(json.refusalCode).toBe("rejected_approach_blocked");
  });

  it("the skill stub defers to the guide instead of restating the protocol", () => {
    const stub = fs.readFileSync(path.join(repoRoot, "skills", "deeppairing", "SKILL.md"), "utf8");
    expect(stub).toMatch(/^---\nname: deeppairing\ndescription: .+\n---\n/);
    expect(stub).toContain("deeppairing guide");
    expect(stub.split("\n").length).toBeLessThan(25);
    for (const protocolDetail of ["rejected_approach_blocked", "--request-id", "deeppairing read-decision", "deeppairing present"]) {
      expect(stub).not.toContain(protocolDetail);
    }
  });

  it("the real CLI dispatches guide and parses a documented flag", () => {
    const json = runCli(["guide", "--json"]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.commands).toEqual([...GUIDE_COMMANDS]);
    expect(parsed.guide).toContain("deeppairing read-decision");

    // --wait-ms is validated by the real parser before any session or daemon
    // work, so an out-of-range value proves the flag is wired end to end.
    const bad = runCli(["read-decision", "--session-id", "s", "--decision-id", "d", "--wait-ms", "0"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("--wait-ms must be a whole number from 1 to 30000");

    const pageUsage = runCli(["read-page-feedback", "--session-id", "s"]);
    expect(pageUsage.status).toBe(1);
    expect(pageUsage.stdout).toBe("");
    expect(pageUsage.stderr).toContain("deeppairing read-page-feedback --session-id ID --artifact-id ID");
  }, 60_000);
});
