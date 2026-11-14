import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { classifyProvenance } from "../../lib/provenance";
import { ProvenanceChip } from "../ProvenanceMarker";
import { statusLabelFor } from "../ArtifactPanel";

describe("#656 item 7 — status cues agree", () => {
  it("7a: real work whose agent exited reads 'Your project', not 'Live'", () => {
    const live = classifyProvenance({ sessionId: "s1", projectName: "proj" })!;
    const ended = classifyProvenance({ sessionId: "s1", projectName: "proj", ended: true })!;
    expect(live).toEqual({ kind: "live", projectName: "proj", history: false }); // unchanged shape
    const { rerender } = render(<ProvenanceChip provenance={live} />);
    expect(screen.getByTestId("provenance-live")).toHaveTextContent("Live");
    rerender(<ProvenanceChip provenance={ended} />);
    expect(screen.getByTestId("provenance-live")).toHaveTextContent("Your project");
    expect(screen.getByTestId("provenance-live").getAttribute("title")).toContain("agent has exited");
  });

  it("7a: replay history keeps its own wording and is never marked ended", () => {
    const p = classifyProvenance({ sessionId: "s1", history: true, ended: true })!;
    expect(p.ended).toBeUndefined();
  });

  it("7c: a draft decision's header chip says 'Awaiting your pick'; other drafts unchanged", () => {
    const base = { id: "x", version: 1, createdAt: "", content: {} } as any;
    expect(statusLabelFor({ ...base, type: "decision", status: "draft" })).toBe("Awaiting your pick");
    expect(statusLabelFor({ ...base, type: "plan", status: "draft" })).toBe("Draft, awaiting review");
  });
});
