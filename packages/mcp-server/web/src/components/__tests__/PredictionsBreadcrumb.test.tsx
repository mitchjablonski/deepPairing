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
        decisionId: "dec_1",
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

  describe("retrospective affordance (P2)", () => {
    const predictionFixture = {
      sessionId: "s1",
      artifactId: "art_1",
      artifactTitle: "Pick hashing algorithm",
      context: "choose password hashing",
      decisionId: "dec_1",
      chosenOptionTitle: "argon2id",
      predictedOutcome: "zero-downtime migration",
      confidence: "medium",
      resolvedAt: "2026-01-15T10:00:00Z",
      daysAgo: 94,
    };

    it("renders ✓ / ◐ / ✗ buttons when no retrospective exists yet", async () => {
      vi.stubGlobal("fetch", mockPredictionsFetch([predictionFixture]));
      render(<PredictionsBreadcrumb concept="password hashing" />);
      const userEvent = (await import("@testing-library/user-event")).default;
      await userEvent.click(await screen.findByRole("button", { name: /show 1 prior prediction/i }));

      expect(screen.getByText(/looking back, was this prediction right/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /mark prediction as right/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /mark prediction as mixed/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /mark prediction as wrong/i })).toBeInTheDocument();
    });

    it("POSTs to /api/retrospectives with verdict and optimistically shows the result", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("/api/retrospectives")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ retrospective: { id: "r1", decisionId: "dec_1", verdict: "right", createdAt: "2026-04-20" } }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ predictions: [predictionFixture] }) });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<PredictionsBreadcrumb concept="password hashing" />);
      const userEvent = (await import("@testing-library/user-event")).default;
      await userEvent.click(await screen.findByRole("button", { name: /show 1 prior prediction/i }));
      await userEvent.click(screen.getByRole("button", { name: /mark prediction as right/i }));

      // POST was made with the expected payload
      const postCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("/api/retrospectives"));
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall as any)[1].body);
      expect(body).toEqual({ decisionId: "dec_1", verdict: "right" });

      // Optimistic verdict label appears immediately
      await waitFor(() => expect(screen.getByText(/prediction held up/i)).toBeInTheDocument());
    });

    it("renders the verdict + note inline when a retrospective already exists", async () => {
      vi.stubGlobal("fetch", mockPredictionsFetch([{
        ...predictionFixture,
        retrospective: {
          id: "retro_1",
          decisionId: "dec_1",
          verdict: "wrong",
          note: "locked us into an incompatible salt format",
          createdAt: "2026-04-01T10:00:00Z",
        },
      }]));
      render(<PredictionsBreadcrumb concept="password hashing" />);
      const userEvent = (await import("@testing-library/user-event")).default;
      await userEvent.click(await screen.findByRole("button", { name: /show 1 prior prediction/i }));

      expect(screen.getByText(/prediction was wrong/i)).toBeInTheDocument();
      expect(screen.getByText(/incompatible salt format/i)).toBeInTheDocument();
      // No action buttons — the verdict is already captured.
      expect(screen.queryByRole("button", { name: /mark prediction as/i })).not.toBeInTheDocument();
    });
  });
});
