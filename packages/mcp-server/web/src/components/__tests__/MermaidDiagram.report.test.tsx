import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { MermaidDiagram } from "../MermaidDiagram";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #176 (Option A) — when a Mermaid diagram GENUINELY fails to render (the #163
 * repair pass also failed), MermaidDiagram POSTs a lightweight failure report so
 * the agent learns via check_feedback. This pins: report only on genuine
 * failure (never on a clean render), the payload carries ids + title + error and
 * NEVER the source, dedupe (one report per mount/source), and the subtle
 * "reported" indicator. Mermaid is mocked (needs real SVG layout); the report
 * path is exercised end-to-end through the REAL artifact store action.
 */
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

const REPORT = { artifactId: "plan_1", visualId: "vis_a", title: "Auth flow" };

function renderFailureCalls(): Array<{ url: string; body: Record<string, unknown> }> {
  const mock = global.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } };
  return mock.mock.calls
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> }))
    .filter((c) => c.url.includes("/api/render-failures"));
}

beforeEach(() => {
  renderMock.mockReset();
  // Real store, seeded so owningSession(plan_1) resolves (F6 routing).
  useArtifactStore.getState().reset();
  useArtifactStore.setState({
    artifacts: [
      {
        id: "plan_1", sessionId: "sess_1", type: "plan", title: "Plan",
        version: 1, status: "draft", content: {}, createdAt: "", updatedAt: "",
      } as Artifact,
    ],
  });
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MermaidDiagram render-failure reporting (#176)", () => {
  it("reports a genuine failure with ids + title + error, and NEVER the source", async () => {
    // Raw fails; the source has no repairable punctuation so the repair is a
    // no-op → terminal error branch → report fires.
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    render(<MermaidDiagram source="graph TD; A-->B" report={REPORT} />);

    await waitFor(() => expect(renderFailureCalls()).toHaveLength(1));
    const { url, body } = renderFailureCalls()[0]!;
    expect(url).toContain("/api/render-failures");
    expect(body).toMatchObject({
      artifactId: "plan_1",
      visualId: "vis_a",
      title: "Auth flow",
      error: "Parse error on line 2",
    });
    // The source must never ride along.
    expect(JSON.stringify(body)).not.toContain("graph TD");
    expect("source" in body).toBe(false);

    // Subtle indicator tells the human the agent will hear about it.
    expect(await screen.findByText(/Reported to the agent/i)).toBeInTheDocument();
  });

  it("does NOT report when the diagram renders fine", async () => {
    renderMock.mockResolvedValue({ svg: "<svg aria-label='ok'><text>A</text></svg>" });
    render(<MermaidDiagram source="graph TD; A-->B" report={REPORT} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(renderFailureCalls()).toHaveLength(0);
    expect(screen.queryByText(/Reported to the agent/i)).not.toBeInTheDocument();
  });

  it("dedupes: a re-render of the same broken source reports only once", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    const view = render(<MermaidDiagram source="graph TD; A-->B" report={REPORT} />);
    await waitFor(() => expect(renderFailureCalls()).toHaveLength(1));
    // A parent re-render (new `report` object identity, same source) must not
    // re-POST — the report is keyed by (artifactId, visualId, source).
    view.rerender(<MermaidDiagram source="graph TD; A-->B" report={{ ...REPORT }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(renderFailureCalls()).toHaveLength(1);
  });

  it("does not report when no `report` prop is supplied (e.g. a preview with no ids)", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(screen.getByText(/Couldn.t render this diagram/i)).toBeInTheDocument());
    expect(renderFailureCalls()).toHaveLength(0);
  });
});
