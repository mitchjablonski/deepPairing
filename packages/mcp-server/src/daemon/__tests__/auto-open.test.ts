// #152 — the daemon auto-opened a browser even for headless/scripted starts
// (a WSL2 field test launched real Chrome and left crashpad orphans).
// shouldAutoOpenBrowser is the single guard in front of openBrowser
// (daemon/index.ts); it's a pure function over an injected env, so these
// tests exercise it with plain objects — fakes, not mocks, and no spawn.
import { describe, it, expect } from "vitest";
import { shouldAutoOpenBrowser } from "../auto-open.js";

describe("shouldAutoOpenBrowser (#152)", () => {
  it("opens by default — interactive product behavior is wanted", () => {
    expect(shouldAutoOpenBrowser({})).toBe(true);
  });

  it.each(["1", "true", "yes", "TRUE", " 1 "])(
    "suppresses the open when DEEPPAIRING_NO_OPEN=%j (scripted/CI/agent starts)",
    (value) => {
      expect(shouldAutoOpenBrowser({ DEEPPAIRING_NO_OPEN: value })).toBe(false);
    },
  );

  it("does not suppress on a falsy-looking DEEPPAIRING_NO_OPEN", () => {
    expect(shouldAutoOpenBrowser({ DEEPPAIRING_NO_OPEN: "" })).toBe(true);
    expect(shouldAutoOpenBrowser({ DEEPPAIRING_NO_OPEN: "0" })).toBe(true);
    expect(shouldAutoOpenBrowser({ DEEPPAIRING_NO_OPEN: "false" })).toBe(true);
  });

  it.each(["0", "false", "no"])(
    "keeps honoring the legacy DEEPPAIRING_OPEN_BROWSER=%j opt-out",
    (value) => {
      expect(shouldAutoOpenBrowser({ DEEPPAIRING_OPEN_BROWSER: value })).toBe(false);
    },
  );

  it("NO_OPEN wins even when OPEN_BROWSER says open", () => {
    expect(shouldAutoOpenBrowser({ DEEPPAIRING_NO_OPEN: "1", DEEPPAIRING_OPEN_BROWSER: "1" })).toBe(false);
  });
});
