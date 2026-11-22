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
  GUIDE_DECISION_STATES,
  renderStandaloneGuide,
  standaloneGuideJson,
} from "../standalone-guide.js";
import { validatePresentOptionsInput } from "../../mcp/validate-tool-input.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(here, "..");
const repoRoot = path.resolve(here, "..", "..", "..", "..", "..");
const initSource = fs.readFileSync(path.join(cliDir, "init.ts"), "utf8");
const standaloneSource = fs.readFileSync(path.join(cliDir, "standalone-session.ts"), "utf8");
const INVOCATION = "node /fake/dist/cli/init.js";
const guide = renderStandaloneGuide(INVOCATION);

// `--wait-ms` lands with #703 (read-decision bounded wait). The guide
// documents it as available; drop this entry once #703 is on main.
const FLAGS_PENDING_MERGE = new Set(["--wait-ms"]);

describe("deeppairing guide (#681)", () => {
  it("names every standalone command, the request-ID rules and the refusal rule", () => {
    for (const command of GUIDE_COMMANDS.filter((c) => c !== "guide")) {
      expect(guide).toContain(`deeppairing ${command}`);
    }
    for (const state of GUIDE_DECISION_STATES) expect(guide).toContain(`- ${state}:`);
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
      if (FLAGS_PENDING_MERGE.has(flag)) continue;
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
});
