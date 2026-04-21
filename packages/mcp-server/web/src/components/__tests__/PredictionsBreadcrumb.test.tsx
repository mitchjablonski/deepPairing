import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PredictionsBreadcrumb } from "../PredictionsBreadcrumb";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockPredictionsFetch(predictions: any[]) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ predictions }) });
}

describe("PredictionsBreadcrumb", () => {
  it("renders nothing while the fetch is pending", async () => {
    // Pending fetch: never resolves during the test.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(<PredictionsBreadcrumb concept="password hashing" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there are no matching predictions (silent assist)", async () => {
    vi.stubGlobal("fetch", mockPredictionsFetch([]));
    const { container } = render(<PredictionsBreadcrumb concept="password hashing" />);
    // Wait a tick for the effect to resolve and state to update.
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("renders a prediction card with humanized age + confidence", async () => {
    vi.stubGlobal("fetch", mockPredictionsFetch([
      {
        sessionId: "s1",
        artifactId: "art_1",
        artifactTitle: "Pick hashing algorithm",
        context: "choose password hashing",
        chosenOptionTitle: "argon2id",
        predictedOutcome: "zero-downtime migration",
        confidence: "medium",
        resolvedAt: "2026-01-15T10:00:00Z",
        daysAgo: 94,
      },
    ]));
    render(<PredictionsBreadcrumb concept="password hashing" />);

    // O3: renders as a compact pill by default — the full card is
    // accessible on click. Verify the pill first, then expand.
    await waitFor(() => expect(screen.getByRole("button", { name: /show 1 prior prediction/i })).toBeInTheDocument());
    expect(screen.queryByText(/zero-downtime migration/i)).not.toBeInTheDocument();

    const userEvent = (await import("@testing-library/user-event")).default;
    await userEvent.click(screen.getByRole("button", { name: /show 1 prior prediction/i }));

    expect(screen.getByText(/zero-downtime migration/i)).toBeInTheDocument();
    expect(screen.getByText(/you've predicted this before/i)).toBeInTheDocument();
    expect(screen.getByText(/3 months ago/i)).toBeInTheDocument();
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
    expect(screen.getByText(/Pick hashing algorithm/i)).toBeInTheDocument();
    expect(screen.getByText(/chose argon2id/i)).toBeInTheDocument();

    // Collapse path also works.
    await userEvent.click(screen.getByRole("button", { name: /collapse predictions/i }));
    expect(screen.queryByText(/zero-downtime migration/i)).not.toBeInTheDocument();
  });

  it("threads excludeArtifactId into the fetch URL so the current artifact isn't echoed back", async () => {
    const fetchMock = mockPredictionsFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    render(<PredictionsBreadcrumb concept="password hashing" excludeArtifactId="art_current" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("concept=password+hashing");
    expect(url).toContain("excludeArtifactId=art_current");
  });

  it("skips the fetch entirely when concept is blank", async () => {
    const fetchMock = mockPredictionsFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<PredictionsBreadcrumb concept="   " />);
    // Give React a tick to attempt the effect — fetch should NOT fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("silently renders nothing when the API fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const { container } = render(<PredictionsBreadcrumb concept="password hashing" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.firstChild).toBeNull();
  });
});
