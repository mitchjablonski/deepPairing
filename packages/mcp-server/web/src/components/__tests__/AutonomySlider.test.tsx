import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutonomySlider } from "../AutonomySlider";
import { useToastStore } from "../../stores/toast";

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

  it("renders a keyboard-operable radiogroup with an accessible name and both options", async () => {
    vi.stubGlobal("fetch", mockState({ autonomyLevel: "supervised" }));
    render(<AutonomySlider />);
    await openPopover();

    const group = screen.getByRole("radiogroup", { name: /detail density/i });
    expect(group).toBeInTheDocument();
    // Both options are real radios with accessible names + checked state.
    const rich = screen.getByRole("radio", { name: /rich/i });
    const terse = screen.getByRole("radio", { name: /terse/i });
    expect(rich).toHaveAttribute("aria-checked", "true"); // default
    expect(terse).toHaveAttribute("aria-checked", "false");
  });

  it("reflects a 'terse' preference loaded from /api/state", async () => {
    vi.stubGlobal("fetch", mockState({ autonomyLevel: "supervised", detailDensity: "terse" }));
    render(<AutonomySlider />);
    await openPopover();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /terse/i })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByRole("radio", { name: /rich/i })).toHaveAttribute("aria-checked", "false");
  });

  it("POSTs { detailDensity: 'terse' } and updates the checked state when Terse is picked", async () => {
    const fetchMock = mockState({ autonomyLevel: "supervised" });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await openPopover();
    await userEvent.click(screen.getByRole("radio", { name: /terse/i }));

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes("/api/preferences") && c[1]?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse(postCall![1].body)).toEqual({ detailDensity: "terse" });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /terse/i })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("does NOT couple to autonomy — picking Terse never POSTs an autonomyLevel", async () => {
    const fetchMock = mockState({ autonomyLevel: "supervised" });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutonomySlider />);
    await openPopover();
    await userEvent.click(screen.getByRole("radio", { name: /terse/i }));

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
