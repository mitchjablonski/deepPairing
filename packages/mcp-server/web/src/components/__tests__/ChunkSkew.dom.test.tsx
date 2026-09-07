/**
 * E5 — deploy/chunk-skew recovery (field-confirmed: crawler handoff,
 * art_JIbNxePywY). A stale tab's failed dynamic import must present as
 * "new version deployed — reload", never as "content may be malformed".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";
import {
  isChunkLoadError, handlePreloadError, reloadIfChunkFailedOffline,
  getChunkRecoveryStatus, resetDeferredReloadForTests, probeAssetOrigin,
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

/** Settle the handler's probe chain (Promise.resolve().then(probe).catch().then()). */
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
const reachable = () => Promise.resolve(true);
const unreachable = () => Promise.resolve(false);

describe("E5 — handlePreloadError (auto-reload, loop-guarded, origin-probed)", () => {
  beforeEach(() => { sessionStorage.clear(); resetDeferredReloadForTests(); });

  it("first failure on a LIVE origin reloads once (after the probe answers); a second inside the window is blocked", async () => {
    const reload = vi.fn();
    const e1 = { preventDefault: vi.fn() };
    handlePreloadError(e1, { reload, probe: reachable });
    expect(getChunkRecoveryStatus()).toBe("probing");
    expect(reload).not.toHaveBeenCalled(); // never on the event itself
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    // Never preventDefault: vite would resolve the import as undefined and
    // the lazy factory would throw a TypeError that dodges isChunkLoadError.
    expect(e1.preventDefault).not.toHaveBeenCalled();

    const e2 = { preventDefault: vi.fn() };
    handlePreloadError(e2, { reload, probe: reachable });
    await settle();
    // Loop guard: no second reload; the boundary's manual Reload is the door.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e2.preventDefault).not.toHaveBeenCalled();
    expect(getChunkRecoveryStatus()).toBe("blocked");
  });
});

describe("#339 — preload failure while the asset origin cannot answer (outage, not skew)", () => {
  beforeEach(() => { sessionStorage.clear(); resetDeferredReloadForTests(); });

  it("disconnect delivered BEFORE the failed chunk: no reload toward a dead origin, propagate, arm one deferred reload", async () => {
    const reload = vi.fn();
    const e = { preventDefault: vi.fn() };
    handlePreloadError(e, { reload, probe: unreachable });
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(getChunkRecoveryStatus()).toBe("deferred");
  });

  it("failed chunk BEFORE the close callback is delivered (store still says connected): same outcome — the store is never consulted", async () => {
    const w = window as unknown as { __dpConnectionStore?: { getState: () => unknown } };
    const saved = w.__dpConnectionStore;
    w.__dpConnectionStore = { getState: () => ({ connected: true, disconnectedSince: null }) };
    try {
      const reload = vi.fn();
      handlePreloadError({ preventDefault: vi.fn() }, { reload, probe: unreachable });
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(getChunkRecoveryStatus()).toBe("deferred");
    } finally {
      if (saved) w.__dpConnectionStore = saved; else delete w.__dpConnectionStore;
    }
  });

  it("a probe that REJECTS is an outage too", async () => {
    const reload = vi.fn();
    handlePreloadError({ preventDefault: vi.fn() }, { reload, probe: () => Promise.reject(new Error("boom")) });
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(getChunkRecoveryStatus()).toBe("deferred");
  });

  it("a probe that HANGS is bounded by the default probe's timeout: no navigation, deferred", async () => {
    vi.useFakeTimers();
    try {
      // The real probe: fetch never settles; the AbortController fires at the bound.
      // Even an injected fetch that ignores abort cannot leave recovery hung.
      const fetchSpy = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
      vi.stubGlobal("fetch", fetchSpy);
      const reload = vi.fn();
      handlePreloadError({ preventDefault: vi.fn() }, { reload, probe: () => probeAssetOrigin(500) });
      await vi.advanceTimersByTimeAsync(499);
      expect(getChunkRecoveryStatus()).toBe("probing");
      await vi.advanceTimersByTimeAsync(2);
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(getChunkRecoveryStatus()).toBe("deferred");
      expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/api\/daemon-info$/);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("the deferred reload fires ONCE on the next successful connect, then disarms", async () => {
    const reload = vi.fn();
    handlePreloadError({ preventDefault: vi.fn() }, { reload, probe: unreachable });
    await settle();
    reloadIfChunkFailedOffline({ reload, probe: reachable });
    expect(reload).not.toHaveBeenCalled();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getChunkRecoveryStatus()).toBe("idle");
    reloadIfChunkFailedOffline({ reload, probe: reachable });
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a connect racing the probe only queues a fresh asset check, never authorizes reload", async () => {
    let resolveProbe!: (v: boolean) => void;
    const probe = vi.fn().mockImplementationOnce(() => new Promise<boolean>((r) => { resolveProbe = r; })).mockResolvedValue(false);
    const reload = vi.fn();
    handlePreloadError({ preventDefault: vi.fn() }, { reload, probe });
    expect(getChunkRecoveryStatus()).toBe("probing");
    await settle();
    reloadIfChunkFailedOffline({ reload, probe });
    expect(reload).not.toHaveBeenCalled();
    resolveProbe(false);
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(getChunkRecoveryStatus()).toBe("deferred");
  });

  it("a reconnect with nothing pending is a no-op", () => {
    const reload = vi.fn();
    reloadIfChunkFailedOffline({ reload, probe: reachable });
    expect(reload).not.toHaveBeenCalled();
  });

  it("the deferred reload honours the same 30s loop guard as the immediate one", async () => {
    const reload = vi.fn();
    handlePreloadError({ preventDefault: vi.fn() }, { reload, probe: reachable }); // online skew: reloads, stamps the guard
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    handlePreloadError({ preventDefault: vi.fn() }, { reload, probe: unreachable }); // then an outage failure
    await settle();
    reloadIfChunkFailedOffline({ reload, probe: reachable });
    await settle(); // inside the window: no second reload
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getChunkRecoveryStatus()).toBe("blocked"); // the boundary CTA is the door now
  });

  it("failures that arrive while a probe/deferral is pending join it instead of starting another", async () => {
    const probe = vi.fn(unreachable);
    const reload = vi.fn();
    handlePreloadError({ preventDefault: vi.fn() }, { reload, probe });
    handlePreloadError({ preventDefault: vi.fn() }, { reload, probe });
    await settle();
    handlePreloadError({ preventDefault: vi.fn() }, { reload, probe });
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(getChunkRecoveryStatus()).toBe("deferred");
  });

  it("the chunk-aware boundary follows the handler: probing copy, then the outage copy with Reload, never a deploy blame", async () => {
    let resolveProbe!: (v: boolean) => void;
    handlePreloadError({ preventDefault: vi.fn() }, { reload: vi.fn(), probe: () => new Promise<boolean>((r) => { resolveProbe = r; }) });
    render(
      <ErrorBoundary>
        <Bomb message="Failed to fetch dynamically imported module: http://localhost:3847/assets/ResearchArtifact-abc123.js" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("This view's code couldn't be fetched")).toBeInTheDocument();
    await settle();
    await act(async () => { resolveProbe(false); await settle(); });
    expect(await screen.findByText("This view couldn't load while the daemon was away")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByText("A new version of the UI was deployed")).toBeNull();
  });

  it("probes the document asset origin, never the selected API daemon or a redirect", async () => {
    const { setCurrentHost, getCurrentHost } = await import("../../lib/api");
    const previousHost = getCurrentHost();
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      setCurrentHost("localhost:19099");
      expect(await probeAssetOrigin()).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(`${window.location.origin}/api/daemon-info`, expect.objectContaining({
        cache: "no-store", redirect: "error", credentials: "omit", signal: expect.any(AbortSignal),
      }));
    } finally {
      setCurrentHost(previousHost);
      vi.unstubAllGlobals();
    }
  });
});

describe("E5 review — single-listener contract (the legacy-hook regression class)", () => {
  beforeEach(() => { sessionStorage.clear(); resetDeferredReloadForTests(); });

  it("no vite:preloadError is ever defaultPrevented — the rejection must reach the boundary", async () => {
    // The old usePreloadErrorReload hook preventDefault'ed EVERY event, which
    // makes vite's helper resolve the failed import as undefined — the lazy
    // factory then throws an undefined-module TypeError that dodges
    // isChunkLoadError and resurrects the "malformed content" field bug.
    // #339 removed the last preventDefault (the reload decision is now
    // asynchronous, after an origin probe), so this pins the contract for
    // every event, first or later.
    const { installPreloadErrorRecovery } = await import("../../lib/chunk-error");
    const reloadSpy = vi.fn();
    const origReload = window.location.reload;
    Object.defineProperty(window.location, "reload", { value: reloadSpy, configurable: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    try {
      installPreloadErrorRecovery();
      const first = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(first);
      expect(first.defaultPrevented).toBe(false);
      await settle();
      const second = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(second);
      expect(second.defaultPrevented).toBe(false); // propagates to the boundary
      await settle();
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(window.location, "reload", { value: origReload, configurable: true });
    }
  });
});
