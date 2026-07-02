/**
 * E5 — deploy/chunk-skew recovery (field-confirmed: crawler handoff,
 * art_JIbNxePywY). A stale tab's failed dynamic import must present as
 * "new version deployed — reload", never as "content may be malformed".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";
import { isChunkLoadError, handlePreloadError } from "../../lib/chunk-error";

function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

describe("E5 — chunk-aware ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("a failed dynamic import shows the reload CTA — even when the caller passed a fallback (the field bug)", () => {
    render(
      <ErrorBoundary fallback={<p>Its content may be malformed.</p>}>
        <Bomb message="Failed to fetch dynamically imported module: http://localhost:3847/assets/SpecArtifact-abc123.js" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/new version of the UI was deployed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // The mislabeling copy must NOT appear for chunk errors.
    expect(screen.queryByText(/malformed/)).toBeNull();
  });

  it("a genuine render crash still uses the caller's fallback", () => {
    render(
      <ErrorBoundary fallback={<p>artifact fallback</p>}>
        <Bomb message="Cannot read properties of undefined (reading 'steps')" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("artifact fallback")).toBeInTheDocument();
    expect(screen.queryByText(/new version/i)).toBeNull();
  });
});

describe("E5 — isChunkLoadError", () => {
  it("matches every browser's dynamic-import failure message + vite preload", () => {
    for (const msg of [
      "Failed to fetch dynamically imported module: x", // Chrome
      "error loading dynamically imported module",       // Firefox
      "Importing a module script failed.",               // Safari
      "Unable to preload CSS for /assets/x.css",         // vite
      "Failed to load module script: mime type",         // module script
    ]) {
      expect(isChunkLoadError(new Error(msg)), msg).toBe(true);
    }
  });

  it("does not match ordinary render errors", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of null"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("E5 — handlePreloadError (auto-reload, loop-guarded)", () => {
  beforeEach(() => sessionStorage.clear());

  it("first failure reloads and prevents vite's default; a second inside the window propagates instead", () => {
    const reload = vi.fn();
    const e1 = { preventDefault: vi.fn() };
    handlePreloadError(e1, reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e1.preventDefault).toHaveBeenCalled();

    const e2 = { preventDefault: vi.fn() };
    handlePreloadError(e2, reload);
    // Loop guard: no second reload, no preventDefault — the error reaches the
    // chunk-aware boundary, which shows the manual reload CTA.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });
});
