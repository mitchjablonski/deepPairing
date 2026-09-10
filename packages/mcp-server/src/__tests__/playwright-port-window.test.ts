import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { playwrightPortEnv } from "../../e2e/playwright-port-window.js";
import { resolvePortWindow } from "../project-root.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Playwright daemon port isolation", () => {
  it("derives a stable bounded window outside canonical and Vitest ranges", () => {
    const env = { GITHUB_RUN_ID: "33937732902", GITHUB_RUN_ATTEMPT: "1" };
    const first = playwrightPortEnv(env, 1234);
    const second = playwrightPortEnv(env, 1234);
    const base = Number(first.DEEPPAIRING_PORT_BASE);
    const span = Number(first.DEEPPAIRING_PORT_SPAN);

    expect(second).toEqual(first);
    expect(span).toBe(128);
    expect(base).toBeGreaterThan(32_000);
    expect(base + span - 1).toBeLessThanOrEqual(65_535);
  });

  it("preserves explicit caller overrides", () => {
    expect(playwrightPortEnv({
      DEEPPAIRING_PORT_BASE: "44000",
      DEEPPAIRING_PORT_SPAN: "64",
    }, 1234)).toEqual({
      DEEPPAIRING_PORT_BASE: "44000",
      DEEPPAIRING_PORT_SPAN: "64",
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["non-numeric", "abc"],
    ["non-integral", "44000.5"],
    ["numeric junk", "44000px"],
    ["below minimum", "1023"],
    ["above maximum", "65001"],
  ])("normalizes an invalid explicit base (%s) to an isolated window", (_label, value) => {
    const result = playwrightPortEnv({
      GITHUB_RUN_ID: "34146108535",
      GITHUB_RUN_ATTEMPT: "1",
      DEEPPAIRING_PORT_BASE: value,
    }, 4242);
    const base = Number(result.DEEPPAIRING_PORT_BASE);
    const resolved = resolvePortWindow(result);

    expect(base).toBeGreaterThanOrEqual(33_000);
    expect(base + Number(result.DEEPPAIRING_PORT_SPAN) - 1).toBeLessThanOrEqual(65_535);
    expect(resolved).toEqual({ base, span: 128 });
  });

  it.each([
    ["minimum", "1024", "128", 1024],
    ["intentional canonical override", "3847", "128", 3847],
    ["trimmed", " 44000 ", "64", 44000],
    ["production-compatible exponent", "4.4e4", "64", 44000],
    ["largest full-span base", "61440", "4096", 61440],
    ["maximum base", "65000", "128", 65000],
  ])("preserves a valid explicit window (%s)", (_label, base, span, expectedBase) => {
    const result = playwrightPortEnv({
      DEEPPAIRING_PORT_BASE: base,
      DEEPPAIRING_PORT_SPAN: span,
    }, 1234);

    expect(result).toEqual({
      DEEPPAIRING_PORT_BASE: String(expectedBase),
      DEEPPAIRING_PORT_SPAN: span,
    });
    expect(resolvePortWindow(result)).toEqual({ base: expectedBase, span: Number(span) });
  });

  it("derives a safe base when an otherwise-valid base and span overflow", () => {
    const result = playwrightPortEnv({
      DEEPPAIRING_PORT_BASE: "65000",
      DEEPPAIRING_PORT_SPAN: "4096",
    }, 1234);
    const base = Number(result.DEEPPAIRING_PORT_BASE);

    expect(result.DEEPPAIRING_PORT_SPAN).toBe("4096");
    expect(base).toBeGreaterThanOrEqual(33_000);
    expect(base).not.toBe(65000);
    expect(base + 4096 - 1).toBeLessThanOrEqual(65_535);
    expect(resolvePortWindow(result)).toEqual({ base, span: 4096 });
  });

  it.each([
    ["trimmed", " 64 ", 64],
    ["exponent", "6.4e1", 64],
    ["hexadecimal", "0x40", 64],
  ])("normalizes a production-compatible span (%s)", (_label, span, expectedSpan) => {
    const result = playwrightPortEnv({
      DEEPPAIRING_PORT_BASE: "44000",
      DEEPPAIRING_PORT_SPAN: span,
    }, 1234);

    expect(result).toEqual({
      DEEPPAIRING_PORT_BASE: "44000",
      DEEPPAIRING_PORT_SPAN: String(expectedSpan),
    });
    expect(resolvePortWindow(result)).toEqual({ base: 44000, span: expectedSpan });
  });

  it.each(["", "   ", "0", "abc", "12.5", "4097"])(
    "returns the validated default span for invalid input %j",
    (span) => {
      const result = playwrightPortEnv({ DEEPPAIRING_PORT_BASE: "65000", DEEPPAIRING_PORT_SPAN: span }, 1234);
      expect(result).toEqual({ DEEPPAIRING_PORT_BASE: "65000", DEEPPAIRING_PORT_SPAN: "128" });
      expect(resolvePortWindow(result)).toEqual({ base: 65000, span: 128 });
    },
  );

  it("keeps derived bases within the daemon validator for many run identities", () => {
    for (const span of [1, 64, 128, 4096]) {
      for (let pid = 1; pid <= 512; pid++) {
        const result = playwrightPortEnv({ DEEPPAIRING_PORT_SPAN: String(span) }, pid);
        const base = Number(result.DEEPPAIRING_PORT_BASE);
        expect(base).toBeGreaterThanOrEqual(33_000);
        expect(base).toBeLessThanOrEqual(65_000);
        expect(base + span - 1).toBeLessThanOrEqual(65_535);
      }
    }
  });

  it("keeps the parent's chosen window when a worker imports the config", () => {
    const parent = playwrightPortEnv({}, 100);
    expect(playwrightPortEnv(parent, 200)).toEqual(parent);
  });

  it("wires the derived values into the actual Playwright config process", async () => {
    vi.stubEnv("DEEPPAIRING_PORT_BASE", "");
    vi.stubEnv("DEEPPAIRING_PORT_SPAN", "4097");
    await import("../../playwright.config.js");

    const base = Number(process.env.DEEPPAIRING_PORT_BASE);
    const span = Number(process.env.DEEPPAIRING_PORT_SPAN);
    expect(base).toBeGreaterThan(32_000);
    expect(span).toBe(128);
    expect(base + span - 1).toBeLessThanOrEqual(65_535);
    expect(resolvePortWindow(process.env)).toEqual({ base, span });

    const child = spawnSync(
      process.execPath,
      [
        "--import", "tsx",
        "--input-type=module",
        "--eval",
        "await import('./playwright.config.ts'); const { resolvePortWindow } = await import('./src/project-root.ts'); process.stdout.write(JSON.stringify(resolvePortWindow(process.env)));",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual({ base, span });
  });
});
