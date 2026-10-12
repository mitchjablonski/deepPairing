// #521 — the confidence auto-approve countdown must be REVOKED when any
// eligibility input is lost mid-countdown, re-checked at the committing tick,
// and carry an explicit auto reason so the daemon can refuse a stale one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { ArtifactStatusActions } from "../ArtifactStatusActions";
import { useArtifactStore } from "../../../stores/artifact";
import { useConnectionStore } from "../../../stores/connection";

type Level = "supervised" | "balanced" | "autonomous";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_x",
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: "Test artifact",
    status: "draft",
    content: { confidence: "high" },
    agentReasoning: null,
    createdAt: "2026-04-17T10:00:00.000Z",
    updatedAt: "2026-04-17T10:00:00.000Z",
    ...overrides,
  };
}

const statusCalls = () =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes("/status"));
const setLevel = (autonomyLevel: Level) => act(() => { useConnectionStore.setState({ autonomyLevel }); });
const tick = (n: number) => { for (let i = 0; i < n; i++) act(() => { vi.advanceTimersByTime(1000); }); };

beforeEach(() => {
  vi.useFakeTimers();
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useConnectionStore.setState({ autonomyLevel: "supervised" });
});

describe("#521 — auto-approve countdown revocation", () => {
  it("control: a countdown that stays eligible still auto-approves, tagged auto_confidence", () => {
    useConnectionStore.setState({ autonomyLevel: "balanced" });
    render(<ArtifactStatusActions artifact={artifact()} />);
    expect(screen.getByText(/auto-approve in/i)).toBeInTheDocument();
    tick(11);
    expect(statusCalls()).toHaveLength(1);
    const body = JSON.parse(statusCalls()[0]![1].body);
    expect(body).toMatchObject({ status: "approved", reason: "auto_confidence" });
  });

  it.each<[Level, Level]>([
    ["balanced", "supervised"],
    ["autonomous", "supervised"],
  ])("%s -> %s mid-countdown: countdown cleared, nothing approved", (from, to) => {
    useConnectionStore.setState({ autonomyLevel: from });
    render(<ArtifactStatusActions artifact={artifact()} />);
    expect(screen.getByText(/auto-approve in/i)).toBeInTheDocument();
    tick(3);
    setLevel(to);
    expect(screen.queryByText(/auto-approve in/i)).toBeNull();
    tick(15);
    expect(statusCalls()).toHaveLength(0);
  });

  it("autonomous -> balanced stays eligible and still auto-approves (no behaviour change)", () => {
    useConnectionStore.setState({ autonomyLevel: "autonomous" });
    render(<ArtifactStatusActions artifact={artifact()} />);
    tick(3);
    setLevel("balanced");
    tick(8);
    expect(statusCalls()).toHaveLength(1);
  });

  it("confidence downgrade mid-countdown cancels it", () => {
    useConnectionStore.setState({ autonomyLevel: "balanced" });
    const { rerender } = render(<ArtifactStatusActions artifact={artifact()} />);
    tick(3);
    rerender(<ArtifactStatusActions artifact={artifact({ content: { confidence: "low" } })} />);
    expect(screen.queryByText(/auto-approve in/i)).toBeNull();
    tick(15);
    expect(statusCalls()).toHaveLength(0);
  });

  it("status leaving draft mid-countdown cancels it", () => {
    useConnectionStore.setState({ autonomyLevel: "balanced" });
    const { rerender } = render(<ArtifactStatusActions artifact={artifact()} />);
    tick(3);
    rerender(<ArtifactStatusActions artifact={artifact({ status: "revised" })} />);
    tick(15);
    expect(statusCalls()).toHaveLength(0);
  });

  it("hideApprove mid-countdown cancels it", () => {
    useConnectionStore.setState({ autonomyLevel: "balanced" });
    const { rerender } = render(<ArtifactStatusActions artifact={artifact()} />);
    tick(3);
    rerender(<ArtifactStatusActions artifact={artifact()} hideApprove />);
    tick(15);
    expect(statusCalls()).toHaveLength(0);
  });

  it.each<Level>(["supervised", "balanced", "autonomous"])(
    "a human Approve click still approves at %s, with no auto reason",
    async (level) => {
      useConnectionStore.setState({ autonomyLevel: level });
      render(<ArtifactStatusActions artifact={artifact()} />);
      await act(async () => { screen.getByRole("button", { name: /^Approve/i }).click(); });
      expect(statusCalls()).toHaveLength(1);
      const body = JSON.parse(statusCalls()[0]![1].body);
      expect(body.status).toBe("approved");
      expect(body.reason).toBeUndefined();
    },
  );
});
