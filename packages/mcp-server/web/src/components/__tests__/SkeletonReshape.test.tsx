import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { PlanArtifact } from "../artifacts/PlanArtifact";

/**
 * Skeleton plans, parity PR 4 — reshape: a newer version of a skeleton plan is
 * a skeleton change. While it awaits approval the card says so, with the why,
 * and that fills are paused.
 */
const mk = (content: any, over: any = {}) =>
  ({ id: "plan_v2", type: "plan", title: "Smoothing skeleton", status: "draft", version: 2, parentId: "plan_v1", createdAt: "2026-10-01T00:00:00.000Z", content, ...over }) as any;
const skeleton = { estimatedChanges: 2, steps: [{ description: "dedupe", reasoning: "r", skelId: "1" }] };

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("reshaped skeleton plan", () => {
  it("after an APPROVED v1: 'reshaped the skeleton you approved', the reason, and the enforced pause", () => {
    useArtifactStore.setState({
      artifacts: [{ ...mk(skeleton), id: "plan_v1", version: 1, parentId: null, status: "superseded", statusHistory: [{ status: "approved", at: "2026-10-01T00:00:00.000Z" }] }],
    } as any);
    render(<PlanArtifact artifact={mk(skeleton, { agentReasoning: "Skeleton change: smooth() needs a tension parameter" })} />);
    const note = document.querySelector('[data-skel-reshape="true"]')!;
    expect(note.textContent).toContain("Skeleton change (v2): Claude reshaped the skeleton you approved.");
    expect(note.textContent).toContain("Fills are paused: until you approve this version, any edit to this plan's files asks you first.");
    expect(note.textContent).toContain("Why: Skeleton change: smooth() needs a tension parameter");
  });

  it("#610 L1: a v1 that was never approved doesn't claim 'you approved'", () => {
    useArtifactStore.setState({ artifacts: [{ ...mk(skeleton), id: "plan_v1", version: 1, parentId: null, status: "superseded" }] } as any);
    render(<PlanArtifact artifact={mk(skeleton)} />);
    const note = document.querySelector('[data-skel-reshape="true"]')!;
    expect(note.textContent).toContain("Skeleton change (v2): Claude revised this skeleton before you approved it.");
    expect(note.textContent).not.toContain("you approved.");
  });

  it("no label once approved, on a v1, or on an ordinary plan's revision", () => {
    const { unmount } = render(<PlanArtifact artifact={mk(skeleton, { status: "approved" })} />);
    expect(document.querySelector('[data-skel-reshape="true"]')).toBeNull();
    unmount();
    const v1 = render(<PlanArtifact artifact={mk(skeleton, { parentId: null, version: 1 })} />);
    expect(document.querySelector('[data-skel-reshape="true"]')).toBeNull();
    v1.unmount();
    render(<PlanArtifact artifact={mk({ estimatedChanges: 1, steps: [{ description: "plain", reasoning: "r" }] })} />);
    expect(document.querySelector('[data-skel-reshape="true"]')).toBeNull();
    expect(screen.getByText("plain")).toBeInTheDocument();
  });
});
