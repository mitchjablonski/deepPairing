import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutonomySlider } from "../AutonomySlider";
import { useToastStore } from "../../stores/toast";
import { useCrossProjectStore } from "../../stores/crossProject";

function mockStateAutonomy(level: string) {
  return vi.fn((url: string, init?: any) => {
    if (String(url).endsWith("/api/state") && (!init || init.method === "GET" || !init.method)) {
      return Promise.resolve({ ok: true, json: async () => ({ autonomyLevel: level }) });
    }
    // Fallback for POST /api/preferences
    return Promise.resolve({ ok: true, json: async () => ({ status: "updated" }) });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AutonomySlider — III9 Autonomy rename (was Q6 Ceremony)", () => {
  // III9 — was labeled "Ceremony" per the Q6 rename. Council product
  // review flagged "ceremony" as off-brand for the senior-IC audience
  // (reads as overhead being sold). Renamed back to "Autonomy" which
  // also matches the underlying wire values (supervised / balanced /
  // autonomous). The level labels (Full / Light / Minimal) stay as-is.
  it("renders the current autonomy label with 'Autonomy: Full' for wire value 'supervised'", async () => {
    vi.stubGlobal("fetch", mockStateAutonomy("supervised"));
    render(<AutonomySlider />);
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toHaveTextContent(/Autonomy: Full/i));
  });

  it("maps 'balanced' wire value to 'Light'", async () => {
    vi.stubGlobal("fetch", mockStateAutonomy("balanced"));
    render(<AutonomySlider />);
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toHaveTextContent(/Autonomy: Light/i));
  });

  it("maps 'autonomous' wire value to 'Minimal'", async () => {
    vi.stubGlobal("fetch", mockStateAutonomy("autonomous"));
    render(<AutonomySlider />);
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toHaveTextContent(/Autonomy: Minimal/i));
  });

  it("opens the tooltip with 'Autonomy level' heading and the 3 options", async () => {
    vi.stubGlobal("fetch", mockStateAutonomy("supervised"));
    render(<AutonomySlider />);
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /autonomy:/i }));

    expect(screen.getByText(/^Autonomy level$/)).toBeInTheDocument();
    expect(screen.getByText(/how much structured review/i)).toBeInTheDocument();
    expect(screen.getAllByText("Full").length).toBeGreaterThan(0);
    expect(screen.getByText("Light")).toBeInTheDocument();
    expect(screen.getByText("Minimal")).toBeInTheDocument();
  });

  it("POSTs the underlying wire value (supervised/balanced/autonomous) when the user picks a label", async () => {
    const fetchMock = mockStateAutonomy("supervised");
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /autonomy:/i }));
    await userEvent.click(screen.getByText("Light"));

    const postCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("/api/preferences"));
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall![1].body);
    expect(body).toEqual({ autonomyLevel: "balanced" });
  });
});

describe("C1 — failed save rolls back and warns (this control governs auto-approve)", () => {
  it("reverts to the previous level and pushes an error toast when the POST fails", async () => {
    useToastStore.setState({ toasts: [] });
    const fetchMock = vi.fn((url: string, init?: any) => {
      if (String(url).endsWith("/api/state") && (!init?.method || init.method === "GET")) {
        return Promise.resolve({ ok: true, json: async () => ({ autonomyLevel: "supervised" }) });
      }
      // POST /api/preferences fails
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /autonomy:/i }));
    await userEvent.click(screen.getByText("Light"));

    // Rolled back to the server-confirmed level…
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /autonomy:/i })).toHaveTextContent(/full/i),
    );
    // …and the failure is loud, because this setting controls auto-approve.
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.kind === "error" && /rolled back/i.test(t.body ?? ""))).toBe(true);
  });
});

describe("#139 — detail density (verbosity) toggle", () => {
  function mockState(state: Record<string, unknown>) {
    return vi.fn((url: string, init?: any) => {
      if (String(url).endsWith("/api/state") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({ ok: true, json: async () => state });
      }
      return Promise.resolve({ ok: true, json: async () => ({ status: "updated" }) });
    });
  }

  async function openPopover() {
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /autonomy:/i }));
  }

  it("renders a radiogroup with an accessible name, both options, and roving tabindex", async () => {
    vi.stubGlobal("fetch", mockState({ autonomyLevel: "supervised" }));
    render(<AutonomySlider />);
    await openPopover();

    const group = screen.getByRole("radiogroup", { name: /detail density/i });
    expect(group).toBeInTheDocument();
    // Both options are real radios with accessible names + checked state.
    // X1: Plain (terse) is the default posture; Rich is the opt-in.
    const rich = screen.getByRole("radio", { name: /rich/i });
    const plain = screen.getByRole("radio", { name: /plain/i });
    expect(plain).toHaveAttribute("aria-checked", "true"); // default (plain-by-default)
    expect(rich).toHaveAttribute("aria-checked", "false");
    // Roving tabindex: exactly the checked radio is in the tab order.
    expect(plain).toHaveAttribute("tabindex", "0");
    expect(rich).toHaveAttribute("tabindex", "-1");
  });

  it("is arrow-key navigable — ArrowRight/ArrowLeft move selection (WAI-ARIA radiogroup)", async () => {
    const fetchMock = mockState({ autonomyLevel: "supervised" });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await openPopover();

    const rich = screen.getByRole("radio", { name: /rich/i });
    const plain = screen.getByRole("radio", { name: /plain/i });
    // Focus the current (plain, the default) radio, then arrow to the next.
    plain.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(rich).toHaveAttribute("aria-checked", "true"));
    expect(plain).toHaveAttribute("aria-checked", "false");
    // Roving tabindex follows selection.
    expect(rich).toHaveAttribute("tabindex", "0");
    expect(plain).toHaveAttribute("tabindex", "-1");
    // Selection moving via keyboard persisted the choice (rich is the opt-in).
    const post = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes("/api/preferences") && c[1]?.method === "POST",
    );
    expect(JSON.parse(post![1].body)).toEqual({ detailDensity: "rich" });

    // ArrowLeft moves back to plain.
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(plain).toHaveAttribute("aria-checked", "true"));
    expect(rich).toHaveAttribute("aria-checked", "false");
  });

  it("reflects a 'rich' preference loaded from /api/state", async () => {
    vi.stubGlobal("fetch", mockState({ autonomyLevel: "supervised", detailDensity: "rich" }));
    render(<AutonomySlider />);
    await openPopover();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /rich/i })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByRole("radio", { name: /plain/i })).toHaveAttribute("aria-checked", "false");
  });

  it("POSTs { detailDensity: 'rich' } and updates the checked state when Rich is picked", async () => {
    const fetchMock = mockState({ autonomyLevel: "supervised" });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await openPopover();
    await userEvent.click(screen.getByRole("radio", { name: /rich/i }));

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes("/api/preferences") && c[1]?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse(postCall![1].body)).toEqual({ detailDensity: "rich" });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /rich/i })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("does NOT couple to autonomy — picking Rich never POSTs an autonomyLevel", async () => {
    const fetchMock = mockState({ autonomyLevel: "supervised" });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await openPopover();
    await userEvent.click(screen.getByRole("radio", { name: /rich/i }));

    const prefCalls = fetchMock.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/api/preferences") && c[1]?.method === "POST",
    );
    for (const call of prefCalls) {
      expect(JSON.parse(call[1].body)).not.toHaveProperty("autonomyLevel");
    }
  });
});

describe("F5 — unknown autonomy level from unvalidated /api/state (the crash class)", () => {
  it("renders the supervised default instead of throwing on an unrecognized level", async () => {
    vi.stubGlobal("fetch", mockStateAutonomy("yolo"));
    render(<AutonomySlider />);
    // Pre-F5: findIndex -1 → levels[-1].label → TypeError on every render.
    // Supervised maps to the 'Full' review label (the safe default).
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toHaveTextContent(/Autonomy: Full/i));
  });
});

/**
 * Q2 — the persistent home for cross-project publishing.
 *
 * Round 12: no web control existed at all (grep = 0); the only writer was the
 * interactive `init` prompt, which the recommended marketplace install never
 * runs. This is the affordance that survives someone answering "Not now" to
 * the first-reject card, so it has to be findable, honest about state, and
 * able to turn the setting back OFF.
 */
describe("Q2 — cross-project memory toggle", () => {
  function mockPublishState(state: Record<string, unknown>) {
    return vi.fn((url: string, init?: any) => {
      if (String(url).endsWith("/api/state") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({ ok: true, json: async () => state });
      }
      return Promise.resolve({ ok: true, json: async () => ({ status: "updated" }) });
    });
  }
  async function open() {
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /autonomy:/i }));
  }

  beforeEach(() => {
    useCrossProjectStore.getState().reset();
  });

  it("shows the state honestly as OFF, with a one-line explanation of what turning it on does", async () => {
    vi.stubGlobal("fetch", mockPublishState({ autonomyLevel: "supervised", globalLedgerPublish: false }));
    render(<AutonomySlider />);
    await open();
    const toggle = await screen.findByRole("switch", { name: /cross-project memory/i });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/stances stay in this project/i)).toBeInTheDocument();
    expect(screen.getByText(/~\/\.deeppairing/)).toBeInTheDocument();
  });

  it("clicking it POSTs globalLedgerPublish:true and flips to On", async () => {
    const fetchMock = mockPublishState({ autonomyLevel: "supervised", globalLedgerPublish: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await open();
    await userEvent.click(await screen.findByRole("switch", { name: /cross-project memory/i }));

    const call = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes("/api/preferences") && c[1]?.method === "POST",
    );
    expect(JSON.parse(call![1].body)).toEqual({ globalLedgerPublish: true });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /cross-project memory/i })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("turns back OFF — a control that can only be switched on is a lie", async () => {
    const fetchMock = mockPublishState({ autonomyLevel: "supervised", globalLedgerPublish: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await open();
    const toggle = await screen.findByRole("switch", { name: /cross-project memory/i });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    const call = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes("/api/preferences") && c[1]?.method === "POST",
    );
    expect(JSON.parse(call![1].body)).toEqual({ globalLedgerPublish: false });
  });

  it("stays hidden while the value is unknown — drawing 'Off' for a project that IS publishing would be worse than nothing", async () => {
    vi.stubGlobal("fetch", mockPublishState({ autonomyLevel: "supervised" })); // no field
    render(<AutonomySlider />);
    await open();
    expect(screen.queryByRole("switch", { name: /cross-project memory/i })).not.toBeInTheDocument();
  });

  it("does NOT couple to autonomy — flipping publish never POSTs an autonomyLevel or detailDensity", async () => {
    const fetchMock = mockPublishState({ autonomyLevel: "supervised", globalLedgerPublish: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await open();
    await userEvent.click(await screen.findByRole("switch", { name: /cross-project memory/i }));
    const prefCalls = fetchMock.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/api/preferences") && c[1]?.method === "POST",
    );
    for (const call of prefCalls) {
      const body = JSON.parse(call[1].body);
      expect(body).not.toHaveProperty("autonomyLevel");
      expect(body).not.toHaveProperty("detailDensity");
    }
  });

  it("reflects a flip made from the first-reject card without a reload (one preference, two surfaces)", async () => {
    vi.stubGlobal("fetch", mockPublishState({ autonomyLevel: "supervised", globalLedgerPublish: false }));
    render(<AutonomySlider />);
    await open();
    await screen.findByRole("switch", { name: /cross-project memory/i });
    act(() => useCrossProjectStore.getState().hydratePublish(true));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /cross-project memory/i })).toHaveAttribute("aria-checked", "true"),
    );
  });
});

/**
 * Q2 — Minimal's blurb must agree with the README's "even Minimal stops at the
 * architectural decisions". The old copy ("proceeds with its recommendations;
 * you review after") described an autonomous agent with a post-hoc review,
 * which is the one thing the product says it isn't.
 */
describe("Q2 — Minimal names the floor", () => {
  it("says Minimal still stops at architectural forks", async () => {
    vi.stubGlobal("fetch", mockStateAutonomy("supervised"));
    render(<AutonomySlider />);
    await waitFor(() => expect(screen.getByRole("button", { name: /autonomy:/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /autonomy:/i }));
    expect(screen.getByText(/still stops at architectural forks/i)).toBeInTheDocument();
    expect(screen.queryByText(/proceeds with its recommendations/i)).not.toBeInTheDocument();
  });
});
