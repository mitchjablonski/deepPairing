import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useReplayStore } from "../replay";
import type { Artifact, Comment } from "@deeppairing/shared";

function artifact(id: string, createdAt: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: `Artifact ${id}`,
    status: "draft",
    content: {},
    agentReasoning: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function comment(id: string, artifactId: string, createdAt: string): Comment {
  return {
    id,
    sessionId: "s1",
    target: { artifactId },
    parentCommentId: null,
    author: "human",
    content: `comment ${id}`,
    acknowledged: false,
    createdAt,
  };
}

const sessionState = {
  artifacts: [
    artifact("a1", "2026-04-16T10:00:00.000Z"),
    artifact("a2", "2026-04-16T10:05:00.000Z"),
    artifact("a3", "2026-04-16T10:10:00.000Z"),
  ],
  comments: [
    comment("c1", "a1", "2026-04-16T10:02:30.000Z"),
  ],
};

beforeEach(() => {
  // The replay store's initial state is re-seeded per test.
  useReplayStore.getState().exitReplay();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ annotations: [] }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("replay store — enterReplay", () => {
  it("builds a timeline and puts the cursor at the first event", async () => {
    await useReplayStore.getState().enterReplay("past_session", sessionState);
    const s = useReplayStore.getState();
    expect(s.active).toBe(true);
    expect(s.sessionId).toBe("past_session");
    expect(s.events.length).toBeGreaterThan(0);
    expect(s.cursor).toBe(s.events[0].at);
  });

  it("fetches annotations for the session (best-effort)", async () => {
    await useReplayStore.getState().enterReplay("past_session", sessionState);
    // Now routed through apiGet, so the read carries session+project headers
    // (X-Project-Hash) instead of going out bare.
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/past_session/annotations"),
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it("survives a failed annotation fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(
      useReplayStore.getState().enterReplay("past_session", sessionState),
    ).resolves.not.toThrow();
    expect(useReplayStore.getState().active).toBe(true);
    expect(useReplayStore.getState().annotations).toEqual([]);
  });
});

describe("replay store — cursor navigation", () => {
  beforeEach(async () => {
    await useReplayStore.getState().enterReplay("past_session", sessionState);
  });

  it("stepForward advances to the next event timestamp", () => {
    const { events, cursor, stepForward } = useReplayStore.getState();
    const firstAt = cursor;
    stepForward();
    const nextAt = useReplayStore.getState().cursor;
    expect(nextAt).not.toBe(firstAt);
    expect(events.find((e) => e.at === nextAt)).toBeDefined();
  });

  it("stepBackward moves earlier", () => {
    const s = useReplayStore.getState();
    // Advance twice then step back once
    s.stepForward();
    s.stepForward();
    const beforeBack = useReplayStore.getState().cursor;
    s.stepBackward();
    const afterBack = useReplayStore.getState().cursor;
    expect(afterBack < beforeBack).toBe(true);
  });

  it("stepForward is a no-op at the end of the timeline", () => {
    const s = useReplayStore.getState();
    // Skip to the last event
    const events = s.events;
    s.setCursor(events[events.length - 1].at);
    const before = useReplayStore.getState().cursor;
    s.stepForward();
    expect(useReplayStore.getState().cursor).toBe(before);
  });

  it("setCursor jumps directly", () => {
    const s = useReplayStore.getState();
    const target = s.events[s.events.length - 1].at;
    s.setCursor(target);
    expect(useReplayStore.getState().cursor).toBe(target);
  });
});

describe("replay store — speed", () => {
  it("setSpeed updates the playback multiplier", async () => {
    await useReplayStore.getState().enterReplay("past_session", sessionState);
    useReplayStore.getState().setSpeed(16);
    expect(useReplayStore.getState().speed).toBe(16);
  });
});

describe("replay store — exitReplay", () => {
  it("clears all replay state", async () => {
    await useReplayStore.getState().enterReplay("past_session", sessionState);
    useReplayStore.getState().exitReplay();
    const s = useReplayStore.getState();
    expect(s.active).toBe(false);
    expect(s.sessionId).toBeNull();
    expect(s.events).toEqual([]);
    expect(s.cursor).toBe("");
    expect(s.playing).toBe(false);
    expect(s.annotations).toEqual([]);
  });
});
