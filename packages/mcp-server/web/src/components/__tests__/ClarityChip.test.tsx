import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClarityChip } from "../ClarityChip";

/**
 * "Write to your pair" — the clarity chip. It runs the SHARED prose linter
 * client-side over content the store already holds, so these tests exercise the
 * real rules rather than a stub: no API, no fixtures beyond the artifact shape.
 */
const mkArtifact = (type: string, content: unknown) =>
  ({
    id: "art_clarity1",
    sessionId: "s1",
    type,
    title: "A research readout",
    status: "draft",
    version: 1,
    parentId: null,
    agentReasoning: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    content,
  }) as any;

const MESSY =
  "WHAT THE RESEARCH SETTLED: the build/test/deploy loop is slow (it respawns the " +
  "daemon, which costs a second or two); shop routing outranks healthy elites → fewer relics.";

describe("ClarityChip", () => {
  it("renders when the prose has violations, showing the score", () => {
    render(<ClarityChip artifact={mkArtifact("research", { summary: MESSY, findings: [] })} />);
    const chip = screen.getByTestId("clarity-chip");
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toMatch(/clarity \d{1,3}/);
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("renders nothing when the prose is clean", () => {
    const { container } = render(
      <ClarityChip
        artifact={mkArtifact("research", {
          summary: "Shop routing now outranks healthy elites. That is worth a small win.",
          findings: [],
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("clarity-chip")).toBeNull();
  });

  it("renders nothing for an artifact type with no prose fields mapped", () => {
    const { container } = render(<ClarityChip artifact={mkArtifact("nope", { summary: MESSY })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("expands on click into a panel grouped by field, then collapses", async () => {
    const user = userEvent.setup();
    render(
      <ClarityChip
        artifact={mkArtifact("research", {
          summary: MESSY,
          findings: [
            {
              category: "a",
              detail: "x",
              significance: "low",
              recommendation: "Improve error handling around the boundary.",
            },
          ],
        })}
      />,
    );
    expect(screen.queryByTestId("clarity-panel")).toBeNull();

    await user.click(screen.getByTestId("clarity-chip"));
    const panel = screen.getByTestId("clarity-panel");
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId("clarity-chip")).toHaveAttribute("aria-expanded", "true");
    // Field paths from the shared linter, so the reader knows WHERE.
    expect(panel.textContent).toContain("summary");
    expect(panel.textContent).toContain("findings[0].recommendation");
    // And the advisory framing, so it never reads as a blocker.
    expect(panel.textContent).toMatch(/advisory only/i);

    await user.click(screen.getByTestId("clarity-chip"));
    expect(screen.queryByTestId("clarity-panel")).toBeNull();
  });

  it("names the rule and quotes the excerpt for each violation", async () => {
    const user = userEvent.setup();
    render(
      <ClarityChip
        artifact={mkArtifact("debrief", {
          summary: "The gate fired; the artifact landed.",
        })}
      />,
    );
    await user.click(screen.getByTestId("clarity-chip"));
    const panel = screen.getByTestId("clarity-panel");
    expect(panel.textContent).toContain("semicolon");
    expect(panel.textContent).toContain("split it into two sentences");
  });

  it("does not activate a clickable ancestor when the chip is used", async () => {
    const user = userEvent.setup();
    let ancestorClicks = 0;
    render(
      <div onClick={() => (ancestorClicks += 1)}>
        <ClarityChip artifact={mkArtifact("research", { summary: MESSY, findings: [] })} />
      </div>,
    );
    await user.click(screen.getByTestId("clarity-chip"));
    expect(ancestorClicks).toBe(0);
    await user.click(screen.getByTestId("clarity-panel"));
    expect(ancestorClicks).toBe(0);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<ClarityChip artifact={mkArtifact("research", { summary: MESSY, findings: [] })} />);
    await user.click(screen.getByTestId("clarity-chip"));
    expect(screen.getByTestId("clarity-panel")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("clarity-panel")).toBeNull();
  });

  it("survives malformed content rather than taking the artifact down", () => {
    expect(() =>
      render(<ClarityChip artifact={mkArtifact("research", { summary: 42, findings: "nope" })} />),
    ).not.toThrow();
  });
});
