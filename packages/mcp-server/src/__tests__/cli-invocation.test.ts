/**
 * L1 (#218) — the publish-path invocation helper. Pins the two layouts the old
 * code got wrong: an INSTALLED npm package (path contains a `node_modules`
 * segment) must emit the npx form; a genuine SOURCE checkout keeps the
 * absolute node-path form. The `getMcpServerConfig` bug this replaces always
 * chose the source form because `fs.existsSync(dist/standalone.js)` is true in
 * BOTH layouts.
 */
import { describe, it, expect } from "vitest";
import {
  isInstalledPackage,
  formatCliInvocation,
  mcpServerConfigFor,
  cliInvocation,
  PACKAGE_NAME,
} from "../cli-invocation.js";

const INSTALLED_DIR = "/home/u/proj/node_modules/@deeppairing/mcp-server/dist/cli";
const SOURCE_DIR = "/home/u/deepPairing/packages/mcp-server/dist/cli";
const WIN_INSTALLED = "C:\\Users\\u\\proj\\node_modules\\@deeppairing\\mcp-server\\dist\\cli";

describe("isInstalledPackage — node_modules segment is the signal", () => {
  it("true when a node_modules segment is in the path (posix + windows)", () => {
    expect(isInstalledPackage(INSTALLED_DIR)).toBe(true);
    expect(isInstalledPackage(WIN_INSTALLED)).toBe(true);
  });
  it("false for a source checkout", () => {
    expect(isInstalledPackage(SOURCE_DIR)).toBe(false);
    // A path merely CONTAINING the substring but not as a segment is not a match.
    expect(isInstalledPackage("/home/u/my-node_modules-tool/dist")).toBe(false);
  });
});

describe("mcpServerConfigFor — the .mcp.json server command per layout", () => {
  it("installed → npx -y @deeppairing/mcp-server (resolves the server bin)", () => {
    expect(mcpServerConfigFor(INSTALLED_DIR)).toEqual({
      command: "npx",
      args: ["-y", "@deeppairing/mcp-server"],
    });
  });
  it("source → node + absolute path to the compiled standalone.js", () => {
    expect(mcpServerConfigFor(SOURCE_DIR)).toEqual({
      command: "node",
      args: ["/home/u/deepPairing/packages/mcp-server/dist/standalone.js"],
    });
  });
});

describe("formatCliInvocation — remediation-command form per layout", () => {
  it("installed → npx -y -p <pkg> deeppairing <sub> (the -p selects the CLI bin)", () => {
    expect(formatCliInvocation({ installed: true, cliPath: null, subcommand: "doctor --fix" })).toBe(
      `npx -y -p ${PACKAGE_NAME} deeppairing doctor --fix`,
    );
  });
  it("source with a resolvable CLI path → node + absolute path", () => {
    expect(
      formatCliInvocation({ installed: false, cliPath: "/abs/dist/cli/init.js", subcommand: "doctor" }),
    ).toBe('node "/abs/dist/cli/init.js" doctor');
  });
  it("source without a resolvable path → repo-relative canonical form", () => {
    expect(formatCliInvocation({ installed: false, cliPath: null, subcommand: "doctor" })).toBe(
      "node packages/mcp-server/dist/cli/init.js doctor",
    );
  });
  it("no subcommand → bare invocation, no trailing space", () => {
    expect(formatCliInvocation({ installed: true, cliPath: null })).toBe(
      `npx -y -p ${PACKAGE_NAME} deeppairing`,
    );
  });
  it("the installed form never trips the unpublished-npx dead-end guard", () => {
    // no-npx-deeppairing.test.ts bans the literal `npx<space>deeppairing`.
    const s = formatCliInvocation({ installed: true, cliPath: null, subcommand: "doctor" });
    expect(s).not.toContain(["npx", "deeppairing"].join(" "));
  });
});

describe("cliInvocation — the live helper, running from source (this test env)", () => {
  it("renders a doctor form that contains 'doctor' and is not the dead-end npx form", () => {
    const s = cliInvocation("doctor");
    expect(s).toContain("doctor");
    expect(s).not.toContain(["npx", "deeppairing"].join(" "));
  });
});
