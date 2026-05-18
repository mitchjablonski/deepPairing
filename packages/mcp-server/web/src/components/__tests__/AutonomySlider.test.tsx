import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutonomySlider } from "../AutonomySlider";

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
