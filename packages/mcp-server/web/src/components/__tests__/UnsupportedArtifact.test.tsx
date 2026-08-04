import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ArtifactDetail } from "../ArtifactPanel";
import { useArtifactStore } from "../../stores/artifact";

/**
 * L1 (#194) — a stale cached tab can receive a FUTURE artifact type a newer
 * daemon pushes. The renderer chain is a series of `type === "X"` branches; an
 * unrecognized type used to fall through to a BLANK body. It now renders a
 * quiet "reload to update" notice plus any coercible raw text.
 */
const mkFutureArtifact = (over: Record<string, unknown> = {}) =>
  ({
    id: "art_future1",
    sessionId: "s1",
    // A type this page version has never heard of.
    type: "hologram" as any,
    title: "The future is now",
    status: "draft",
    version: 1,
    parentId: null,
    agentReasoning: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    content: { summary: "A brand-new artifact kind from a newer daemon." },
    ...over,
  }) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
});

describe("L1 — unknown artifact-type fallback", () => {
  it("renders a reload notice + the raw summary instead of a blank body", () => {
    render(<ArtifactDetail artifact={mkFutureArtifact()} />);
    // The fallback renders OUTSIDE the lazy Suspense boundary, so it's present
    // synchronously (no lazy-chunk wait).
    const notice = screen.getByTestId("unsupported-artifact");
    expect(notice).toHaveTextContent(/isn't supported by this page version — reload to update/i);
    // Names the unknown type and surfaces the coercible text.
    expect(notice).toHaveTextContent(/hologram/);
    expect(notice).toHaveTextContent(/The future is now/);
    expect(notice).toHaveTextContent(/A brand-new artifact kind/);
  });

  it("still renders the notice when content has no coercible text", () => {
    render(<ArtifactDetail artifact={mkFutureArtifact({ content: { blob: 42 }, title: "" })} />);
    const notice = screen.getByTestId("unsupported-artifact");
    expect(notice).toHaveTextContent(/reload to update/i);
    expect(notice).toHaveTextContent(/hologram/);
  });

  it("does NOT show the fallback for a known type (decision)", () => {
    render(
      <ArtifactDetail
        artifact={mkFutureArtifact({
          type: "decision",
          content: { decisionId: "d1", context: "which store?", options: [
            { id: "o1", title: "Redis", description: "x", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
            { id: "o2", title: "Postgres", description: "y", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
          ] },
        })}
      />,
    );
    // Known type → the fallback branch is false synchronously, regardless of
    // whether the lazy decision renderer has committed yet.
    expect(screen.queryByTestId("unsupported-artifact")).toBeNull();
  });
});
