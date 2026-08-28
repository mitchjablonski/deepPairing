import { describe, it, expect } from "vitest";
import { selectDefaultSession, type SelectableSession } from "../selectDefaultSession";

/**
 * Per-Claude-session split — the companion's default-view rule. With >1 live
 * bucket for a project the tab must land on the MOST-RECENTLY-ACTIVE session;
 * single-session projects must behave exactly as before.
 */

const s = (over: Partial<SelectableSession> & { sessionId: string }): SelectableSession => over;

describe("selectDefaultSession", () => {
  it("empty list → undefined", () => {
    expect(selectDefaultSession([])).toBeUndefined();
  });

  it("exactly one session → that session (unchanged single-session behavior)", () => {
    const only = s({ sessionId: "a", live: true, lastActivity: "2026-08-01T00:00:00Z" });
    expect(selectDefaultSession([only])).toBe(only);
  });

  it("one live session among dead ones → the live one, regardless of order", () => {
    const dead = s({ sessionId: "dead", live: false, lastActivity: "2026-08-10T00:00:00Z" });
    const live = s({ sessionId: "live", live: true, lastActivity: "2026-08-01T00:00:00Z" });
    expect(selectDefaultSession([dead, live])).toBe(live);
  });

  it(">1 live → the most-recently-active is chosen, not insertion order", () => {
    const older = s({ sessionId: "older", live: true, lastActivity: "2026-08-01T00:00:00Z" });
    const newer = s({ sessionId: "newer", live: true, lastActivity: "2026-08-27T09:00:00Z" });
    // Insertion order deliberately puts the OLDER one first.
    expect(selectDefaultSession([older, newer])).toBe(newer);
    // Order-independent.
    expect(selectDefaultSession([newer, older])).toBe(newer);
  });

  it("ties resolve to the earlier session in the list (stable)", () => {
    const a = s({ sessionId: "a", live: true, lastActivity: "2026-08-27T09:00:00Z" });
    const b = s({ sessionId: "b", live: true, lastActivity: "2026-08-27T09:00:00Z" });
    expect(selectDefaultSession([a, b])).toBe(a);
  });

  it("a live session with NO lastActivity ranks below one that has activity", () => {
    const noActivity = s({ sessionId: "none", live: true });
    const active = s({ sessionId: "active", live: true, lastActivity: "2026-08-27T09:00:00Z" });
    expect(selectDefaultSession([noActivity, active])).toBe(active);
  });

  it("live omitted (undefined) is treated as live (matches old .find semantics)", () => {
    const legacy = s({ sessionId: "legacy" }); // no live field, no lastActivity
    const newer = s({ sessionId: "newer", lastActivity: "2026-08-27T09:00:00Z" });
    expect(selectDefaultSession([legacy, newer])).toBe(newer);
  });

  it("all dead → falls back to the first session (cold history still shows something)", () => {
    const d1 = s({ sessionId: "d1", live: false });
    const d2 = s({ sessionId: "d2", live: false });
    expect(selectDefaultSession([d1, d2])).toBe(d1);
  });
});
