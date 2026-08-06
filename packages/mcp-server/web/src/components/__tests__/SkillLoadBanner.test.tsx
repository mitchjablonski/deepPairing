import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillLoadBanner } from "../SkillLoadBanner";
import { useArtifactStore } from "../../stores/artifact";

function mockSkillStatus(partial: any) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      claudeMdHasMarker: false,
      recentArtifactActivity: false,
      pairingProtocolSkillLikelyLoaded: false,
      evidence: "no CLAUDE.md marker AND no artifact created in the last 10 min",
      ...partial,
    }),
  });
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  try { sessionStorage.clear(); } catch {}
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SkillLoadBanner", () => {
  // graceMs={0} opens the K2 grace window immediately so these cases exercise
  // the not-loaded / dismiss / evidence logic directly; the grace window itself
  // has its own dedicated test below.
  it("renders when the skill is NOT likely loaded", async () => {
    vi.stubGlobal("fetch", mockSkillStatus({ pairingProtocolSkillLikelyLoaded: false }));
    render(<SkillLoadBanner graceMs={0} />);
    await waitFor(() => expect(screen.getByText(/claude may not be using deepPairing tools/i)).toBeInTheDocument());
    expect(screen.getByText(/\/deeppairing:start/)).toBeInTheDocument();
    expect(screen.getByText(/init\.js init/)).toBeInTheDocument();
  });

  it("does NOT render when the skill IS likely loaded", async () => {
    vi.stubGlobal("fetch", mockSkillStatus({ pairingProtocolSkillLikelyLoaded: true }));
    const { container } = render(<SkillLoadBanner graceMs={0} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.firstChild).toBeNull();
  });

  it("hides once the artifact store has any artifact (runtime proof)", async () => {
    vi.stubGlobal("fetch", mockSkillStatus({ pairingProtocolSkillLikelyLoaded: false }));
    // Seed an artifact BEFORE rendering; banner's hasArtifacts guard kicks in.
    useArtifactStore.setState({
      artifacts: [{
        id: "a1", sessionId: "s", type: "research", version: 1, parentId: null,
        title: "x", status: "draft",
        content: { summary: "s", findings: [] }, agentReasoning: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }] as any,
    });
    const { container } = render(<SkillLoadBanner graceMs={0} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.firstChild).toBeNull();
  });

  it("dismisses on click and stays dismissed (session-scoped)", async () => {
    vi.stubGlobal("fetch", mockSkillStatus({ pairingProtocolSkillLikelyLoaded: false }));
    render(<SkillLoadBanner graceMs={0} />);
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /dismiss banner/i }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // Remount — sessionStorage should prevent re-showing.
    const { container } = render(<SkillLoadBanner graceMs={0} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.firstChild).toBeNull();
  });

  it("surfaces the evidence string for diagnostics", async () => {
    vi.stubGlobal("fetch", mockSkillStatus({
      pairingProtocolSkillLikelyLoaded: false,
      evidence: "custom diagnostic text from the daemon",
    }));
    render(<SkillLoadBanner graceMs={0} />);
    await waitFor(() => expect(screen.getByText(/custom diagnostic text/i)).toBeInTheDocument());
  });

  it("silently renders nothing on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const { container } = render(<SkillLoadBanner graceMs={0} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.firstChild).toBeNull();
  });

  it("K2 — holds the not-loaded alarm during the grace window, then surfaces it once the window passes", async () => {
    vi.stubGlobal("fetch", mockSkillStatus({ pairingProtocolSkillLikelyLoaded: false }));
    // A short but non-zero grace: the status resolves as not-loaded almost
    // immediately, but the alarm must stay suppressed while we're inside it.
    render(<SkillLoadBanner graceMs={80} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // Once the grace window elapses, the genuine warning surfaces — the
    // genuinely-stuck case is preserved, just not fired during expected waiting.
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
  });
});
