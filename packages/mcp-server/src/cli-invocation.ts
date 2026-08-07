/**
 * L1 (#218) — render deepPairing CLI invocations that are TRUE for the layout
 * the code is actually running in.
 *
 * The old code hardcoded the repo-relative `node packages/mcp-server/dist/cli/init.js`
 * everywhere. That path only means anything inside a source checkout run from
 * the repo root — for someone who `npm install`ed / `npx`ed the published
 * package it's noise. Worse, `getMcpServerConfig`'s "am I local dev?" probe was
 * `fs.existsSync(../standalone.js)`, which is ALWAYS true in a published package
 * (dist/standalone.js sits beside dist/cli/init.js), so init baked an absolute
 * path into the transient npx cache and silently broke once npm GC'd it.
 *
 * The honest signal is whether THIS module resolves through a `node_modules`
 * path segment: installed package → yes; genuine source checkout → no.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __thisFile = fileURLToPath(import.meta.url);
const __thisDir = path.dirname(__thisFile);

/** The published npm package name — the identity `npx` / `npm install` use. */
export const PACKAGE_NAME = "@deeppairing/mcp-server";

/**
 * True when running from an INSTALLED npm package (some ancestor directory is
 * `node_modules`) rather than a source checkout. Split on both separators so a
 * Windows path (`...\node_modules\...`) is detected too. `modulePath` defaults
 * to this module's own resolved location and is injectable for testing.
 */
export function isInstalledPackage(modulePath: string = __thisFile): boolean {
  return modulePath.split(/[\\/]/).includes("node_modules");
}

/**
 * Locate the compiled CLI entry (`dist/cli/init.js`) by absolute path so a
 * source-checkout remediation string works from any cwd (not just the repo
 * root). Returns null when the compiled file can't be found — e.g. running the
 * TypeScript source directly via tsx, where only `init.ts` exists.
 */
function resolveCompiledCliPath(): string | null {
  const candidates = [
    path.join(__thisDir, "cli", "init.js"), // dist/ → dist/cli/init.js
    path.join(__thisDir, "..", "cli", "init.js"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Render the correct way to invoke the deepPairing CLI for the current layout.
 *
 *  - INSTALLED package → `npx -y -p @deeppairing/mcp-server deeppairing <sub>`.
 *    The `-p` is load-bearing: the package ships several bins and the one that
 *    matches the package name (`mcp-server` → the stdio server) would otherwise
 *    win, launching the MCP server instead of the `deeppairing` CLI. `-p` names
 *    the package and lets `deeppairing` select the CLI bin.
 *  - SOURCE checkout → `node "<abs>/dist/cli/init.js" <sub>` (resolved absolute
 *    path, works from any cwd), falling back to the repo-relative canonical
 *    path when the compiled CLI can't be located (TS-source dev via tsx).
 */
export function cliInvocation(subcommand = ""): string {
  return formatCliInvocation({
    installed: isInstalledPackage(),
    cliPath: resolveCompiledCliPath(),
    subcommand,
  });
}

/**
 * Pure renderer for {@link cliInvocation} — exported so both layouts are
 * unit-testable without a real install tree. `installed` picks the npx form;
 * otherwise `cliPath` (when resolvable) yields the absolute node-path form,
 * falling back to the repo-relative canonical path.
 */
export function formatCliInvocation(args: {
  installed: boolean;
  cliPath: string | null;
  subcommand?: string;
}): string {
  const suffix = args.subcommand ? ` ${args.subcommand}` : "";
  if (args.installed) {
    return `npx -y -p ${PACKAGE_NAME} deeppairing${suffix}`;
  }
  if (args.cliPath) return `node "${args.cliPath}"${suffix}`;
  return `node packages/mcp-server/dist/cli/init.js${suffix}`;
}

/**
 * The `.mcp.json` server config `init` writes — pure over the module directory
 * so both layouts are unit-testable.
 *
 *  - INSTALLED → `{ command: "npx", args: ["-y", "@deeppairing/mcp-server"] }`.
 *    `npx @deeppairing/mcp-server` resolves the package-name bin (`mcp-server`),
 *    which IS the stdio server — exactly what Claude Code should spawn. `-y`
 *    skips the install confirmation so a fresh machine doesn't hang.
 *  - SOURCE → `node <abs>/dist/standalone.js` so a dev checkout runs its own
 *    build, not a cache-GC-able npx download.
 *
 * @param moduleDir directory of the running CLI module (init.js's dir).
 */
export function mcpServerConfigFor(moduleDir: string): { command: string; args: string[] } {
  if (isInstalledPackage(moduleDir)) {
    return { command: "npx", args: ["-y", PACKAGE_NAME] };
  }
  const absolutePath = path.resolve(moduleDir, "..", "standalone.js");
  return { command: "node", args: [absolutePath] };
}
