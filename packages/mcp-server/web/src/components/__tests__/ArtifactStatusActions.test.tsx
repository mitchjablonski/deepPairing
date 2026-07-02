import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactStatusActions } from "../artifacts/ArtifactStatusActions";
import { useArtifactStore } from "../../stores/artifact";

const artifact = {
  id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null,
  title: "t", status: "draft", content: {}, agentReasoning: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
} as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => vi.unstubAllGlobals());

/** Install a fake IntersectionObserver that immediately reports the sentinel
 *  as (not) intersecting — i.e. the user is (not) at the artifact's end.
 *  Returns a fire() handle so tests can simulate later scroll transitions. */
function stubIO(isIntersecting: boolean) {
  const handle: { fire: (v: boolean) => void } = { fire: () => {} };
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: any;
      constructor(cb: any) {
        this.cb = cb;
        handle.fire = (v: boolean) => this.cb([{ isIntersecting: v }]);
      }
      observe() { this.cb([{ isIntersecting }]); }
      disconnect() {}
      unobserve() {}
    } as any,
  );
  return handle;
}

describe("B6 — compact-while-floating review footer", () => {
  it("floats as a slim bar mid-scroll: Approve stays one click, no textarea", async () => {
    stubIO(false); // sentinel off-screen → user hasn't reached the end
    const user = userEvent.setup();
    render(<ArtifactStatusActions artifact={artifact} />);

    expect(screen.queryByPlaceholderText(/respond to the agent/i)).not.toBeInTheDocument();
    // The bound approve still works directly from the compact bar.
    await user.click(screen.getByRole("button", { name: /^approve$/i }));
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.filter(([u]: any[]) =>
        String(u).includes("/api/artifacts/a1/status"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it("'Respond / revise / reject…' expands the full panel and focuses the textarea", async () => {
    stubIO(false);
    const user = userEvent.setup();
    render(<ArtifactStatusActions artifact={artifact} />);
    await user.click(screen.getByRole("button", { name: /respond \/ revise \/ reject/i }));
    const textarea = await screen.findByPlaceholderText(/respond to the agent/i);
    expect(textarea).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    // The full action row is present now.
    expect(screen.getByRole("button", { name: /request revision/i })).toBeInTheDocument();
  });

  it("shows the FULL panel when the user is at the artifact's end", () => {
    stubIO(true);
    render(<ArtifactStatusActions artifact={artifact} />);
    expect(screen.getByPlaceholderText(/respond to the agent/i)).toBeInTheDocument();
  });

  it("the `r` shortcut EXPANDS the compact bar and focuses the textarea (was a silent no-op)", async () => {
    stubIO(false);
    render(<ArtifactStatusActions artifact={artifact} />);
    expect(screen.queryByPlaceholderText(/respond to the agent/i)).not.toBeInTheDocument();
    // App dispatches this for the global `r` shortcut. Pre-fix, commentRef was
    // null while compact and the optional chain silently dropped the action.
    window.dispatchEvent(
      new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: "a1", action: "revise" } }),
    );
    const textarea = await screen.findByPlaceholderText(/respond to the agent/i);
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("the `a` shortcut arms the countdown while compact — and the countdown forces expansion", async () => {
    stubIO(false);
    render(<ArtifactStatusActions artifact={artifact} />);
    window.dispatchEvent(
      new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: "a1", action: "approve" } }),
    );
    // countdown !== null → expanded: the armed timer can never hide compact.
    expect(await screen.findByText(/will auto-approve in/i)).toBeInTheDocument();
  });

  it("defaults to the full panel when IntersectionObserver never fires (test envs, short artifacts)", () => {
    // no stubIO — whatever the env provides won't call back synchronously
    render(<ArtifactStatusActions artifact={artifact} />);
    expect(screen.getByPlaceholderText(/respond to the agent/i)).toBeInTheDocument();
  });
});

describe("B7 — the expanded footer can be minimized (and mandatory states override)", () => {
  it("Minimize collapses to the slim bar even at the artifact's end", async () => {
    stubIO(true); // at end → expanded
    const user = userEvent.setup();
    render(<ArtifactStatusActions artifact={artifact} />);
    expect(screen.getByPlaceholderText(/respond to the agent/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /minimize/i }));
    expect(screen.queryByPlaceholderText(/respond to the agent/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /respond \/ revise \/ reject/i })).toBeInTheDocument();
  });

  it("the slim bar's expander re-opens after a Minimize", async () => {
    stubIO(true);
    const user = userEvent.setup();
    render(<ArtifactStatusActions artifact={artifact} />);
    await user.click(screen.getByRole("button", { name: /minimize/i }));
    await user.click(screen.getByRole("button", { name: /respond \/ revise \/ reject/i }));
    const textarea = await screen.findByPlaceholderText(/respond to the agent/i);
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("an armed countdown overrides Minimize (the timer can never be hidden) — and no dead Minimize shows", async () => {
    stubIO(true);
    const user = userEvent.setup();
    render(<ArtifactStatusActions artifact={artifact} />);
    await user.click(screen.getByRole("button", { name: /minimize/i }));
    window.dispatchEvent(
      new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: "a1", action: "approve" } }),
    );
    expect(await screen.findByText(/will auto-approve in/i)).toBeInTheDocument();
    // While the countdown mandates expansion, Minimize would be a lying control.
    expect(screen.queryByRole("button", { name: /minimize/i })).not.toBeInTheDocument();
  });
});

describe("B7' — reaching the end re-opens a minimized panel", () => {
  it("minimize sticks in place, but scrolling away and back to the end auto-expands", async () => {
    const io = stubIO(true); // mounted at the end → expanded
    const user = userEvent.setup();
    render(<ArtifactStatusActions artifact={artifact} />);
    await user.click(screen.getByRole("button", { name: /minimize/i }));
    expect(screen.queryByPlaceholderText(/respond to the agent/i)).not.toBeInTheDocument();

    // Scroll away (sentinel leaves view) — still compact.
    act(() => io.fire(false));
    expect(screen.queryByPlaceholderText(/respond to the agent/i)).not.toBeInTheDocument();

    // Scroll back to the end — the rising edge clears the collapse.
    act(() => io.fire(true));
    expect(screen.getByPlaceholderText(/respond to the agent/i)).toBeInTheDocument();
  });
});
