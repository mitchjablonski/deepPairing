import { afterEach, describe, expect, it, vi } from "vitest";
import { playwrightPortEnv } from "../../e2e/playwright-port-window.js";

const originalBase = process.env.DEEPPAIRING_PORT_BASE;
const originalSpan = process.env.DEEPPAIRING_PORT_SPAN;

afterEach(() => {
  if (originalBase === undefined) delete process.env.DEEPPAIRING_PORT_BASE;
  else process.env.DEEPPAIRING_PORT_BASE = originalBase;
  if (originalSpan === undefined) delete process.env.DEEPPAIRING_PORT_SPAN;
  else process.env.DEEPPAIRING_PORT_SPAN = originalSpan;
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
    delete process.env.DEEPPAIRING_PORT_BASE;
    delete process.env.DEEPPAIRING_PORT_SPAN;
    await import("../../playwright.config.js");

    const base = Number(process.env.DEEPPAIRING_PORT_BASE);
    expect(base).toBeGreaterThan(32_000);
    expect(base + Number(process.env.DEEPPAIRING_PORT_SPAN) - 1).toBeLessThanOrEqual(65_535);
  });
});
