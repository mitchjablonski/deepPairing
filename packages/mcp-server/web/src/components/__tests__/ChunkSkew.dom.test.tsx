/**
 * E5 — deploy/chunk-skew recovery (field-confirmed: crawler handoff,
 * art_JIbNxePywY). A stale tab's failed dynamic import must present as
 * "new version deployed — reload", never as "content may be malformed".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";
import {
  isChunkLoadError, handlePreloadError, reloadIfChunkFailedOffline,
  isReloadDeferredForOutage, resetDeferredReloadForTests, daemonReachable,
} from "../../lib/chunk-error";

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

describe("#339 — preload failure while the daemon is unreachable (outage, not skew)", () => {
  beforeEach(() => { sessionStorage.clear(); resetDeferredReloadForTests(); });

  it("does NOT reload toward an unreachable origin: propagates, keeps the view, arms one deferred reload", () => {
    const reload = vi.fn();
    const e = { preventDefault: vi.fn() };
    handlePreloadError(e, reload, () => false);
    expect(reload).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled(); // the boundary / caller catch handles it
    expect(isReloadDeferredForOutage()).toBe(true);
  });

  it("the deferred reload fires ONCE on the next successful connect, then disarms", () => {
    const reload = vi.fn();
    handlePreloadError({ preventDefault: vi.fn() }, reload, () => false);
    expect(reloadIfChunkFailedOffline(reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(isReloadDeferredForOutage()).toBe(false);
    expect(reloadIfChunkFailedOffline(reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a reconnect with nothing deferred is a no-op", () => {
    const reload = vi.fn();
    expect(reloadIfChunkFailedOffline(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("the deferred reload honours the same 30s loop guard as the immediate one", () => {
    const reload = vi.fn();
    handlePreloadError({ preventDefault: vi.fn() }, reload, () => true); // online skew: reloads, stamps the guard
    expect(reload).toHaveBeenCalledTimes(1);
    handlePreloadError({ preventDefault: vi.fn() }, reload, () => false); // then an outage failure
    expect(reloadIfChunkFailedOffline(reload)).toBe(false); // inside the window: no second reload
    expect(reload).toHaveBeenCalledTimes(1);
    expect(isReloadDeferredForOutage()).toBe(false); // consumed, not re-armed: the boundary CTA is the door now
  });

  it("the online skew path is unchanged: first failure reloads immediately and prevents vite's default", () => {
    const reload = vi.fn();
    const e = { preventDefault: vi.fn() };
    handlePreloadError(e, reload, () => true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(isReloadDeferredForOutage()).toBe(false);
  });

  it("daemonReachable: only a tab that HAD a socket and lost it counts as unreachable", () => {
    const w = window as unknown as { __dpConnectionStore?: { getState: () => unknown } };
    const saved = w.__dpConnectionStore;
    try {
      delete w.__dpConnectionStore;
      expect(daemonReachable()).toBe(true); // unknown store → plain skew policy
      w.__dpConnectionStore = { getState: () => ({ connected: false, disconnectedSince: null }) };
      expect(daemonReachable()).toBe(true); // never connected (bootstrap) → plain skew policy
      w.__dpConnectionStore = { getState: () => ({ connected: false, disconnectedSince: Date.now() }) };
      expect(daemonReachable()).toBe(false); // outage
      w.__dpConnectionStore = { getState: () => ({ connected: true, disconnectedSince: null }) };
      expect(daemonReachable()).toBe(true);
    } finally {
      if (saved) w.__dpConnectionStore = saved; else delete w.__dpConnectionStore;
    }
  });

  it("the chunk-aware boundary names the outage and the deferred reload instead of blaming a deploy", () => {
    handlePreloadError({ preventDefault: vi.fn() }, vi.fn(), () => false);
    render(
      <ErrorBoundary>
        <Bomb message="Failed to fetch dynamically imported module: http://localhost:3847/assets/ResearchArtifact-abc123.js" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("This view couldn't load while the daemon was away")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByText("A new version of the UI was deployed")).toBeNull();
  });
});

describe("E5 review — single-listener contract (the legacy-hook regression class)", () => {
  beforeEach(() => sessionStorage.clear());

  it("a second-in-window vite:preloadError ends up NOT defaultPrevented — the rejection must reach the boundary", async () => {
    // The old usePreloadErrorReload hook preventDefault'ed EVERY event, which
    // makes vite's helper resolve the failed import as undefined — the lazy
    // factory then throws an undefined-module TypeError that dodges
    // isChunkLoadError and resurrects the "malformed content" field bug.
    // This pins the contract: after the auto-reload consumed the first event,
    // nothing in the app swallows the second.
    const { installPreloadErrorRecovery } = await import("../../lib/chunk-error");
    const reloadSpy = vi.fn();
    const origReload = window.location.reload;
    Object.defineProperty(window.location, "reload", { value: reloadSpy, configurable: true });
    try {
      installPreloadErrorRecovery();
      const first = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(first);
      expect(first.defaultPrevented).toBe(true); // consumed by the auto-reload

      const second = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(second);
      expect(second.defaultPrevented).toBe(false); // propagates to the boundary
    } finally {
      Object.defineProperty(window.location, "reload", { value: origReload, configurable: true });
    }
  });
});
