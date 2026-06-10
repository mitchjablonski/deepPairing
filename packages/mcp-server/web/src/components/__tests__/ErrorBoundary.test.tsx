import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";

/**
 * ErrorBoundary is what makes a single crashing artifact renderer isolate to
 * its own pane instead of taking down the whole ArtifactPanel. ArtifactPanel
 * wraps the detail pane in `<ErrorBoundary key={selectedArtifact.id}>`, so this
 * pins two contracts it relies on:
 *  1. a throwing child renders the fallback (not a white screen), and a sibling
 *     OUTSIDE the boundary (the sidebar) keeps rendering;
 *  2. changing the key remounts a fresh boundary, so selecting a different
 *     artifact recovers automatically (no manual "Try again" loop on the same
 *     crashing content).
 */
function Boom({ label = "boom" }: { label?: string }): never {
  throw new Error(label);
}
function Safe({ text }: { text: string }) {
  return <div>{text}</div>;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React logs caught render errors to console.error; silence the expected noise.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("ErrorBoundary", () => {
  it("renders the provided fallback when a child throws", () => {
    render(
      <ErrorBoundary fallback={<div>detail crashed</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("detail crashed")).toBeInTheDocument();
  });

  it("renders the default fallback (with the error message) when none is provided", () => {
    render(
      <ErrorBoundary>
        <Boom label="kaboom" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText("kaboom")).toBeInTheDocument();
  });

  it("isolates the crash: a sibling outside the boundary still renders", () => {
    render(
      <div>
        <div>sidebar stays</div>
        <ErrorBoundary fallback={<div>detail crashed</div>}>
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    // The sidebar (sibling, outside the boundary) is unaffected by the crash.
    expect(screen.getByText("sidebar stays")).toBeInTheDocument();
    expect(screen.getByText("detail crashed")).toBeInTheDocument();
  });

  it("recovers when the key changes (remount) — the per-artifact switch contract", () => {
    const { rerender } = render(
      <ErrorBoundary key="art-a" fallback={<div>crashed</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("crashed")).toBeInTheDocument();

    // Selecting a different artifact (new key) remounts a fresh boundary; the
    // healthy artifact renders and the stale fallback is gone.
    rerender(
      <ErrorBoundary key="art-b" fallback={<div>crashed</div>}>
        <Safe text="healthy artifact" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy artifact")).toBeInTheDocument();
    expect(screen.queryByText("crashed")).not.toBeInTheDocument();
  });
});
