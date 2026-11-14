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

import { vi } from "vitest";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

describe("#656 item 7b — the session tab badge counts what's waiting", () => {
  const draft = (id: string, sessionId: string, status = "draft") =>
    ({ id, sessionId, type: "plan", title: id, status, version: 1, createdAt: "2026-06-01T00:00:00.000Z", content: { summary: "s", steps: [] } }) as any;
  const tabs = () => Array.from(document.querySelectorAll<HTMLElement>("nav button[title*='Artifacts:']"));
  const tab = (sid: string) => tabs().find((b) => (b.getAttribute("title") ?? "").startsWith(sid))!;

  it("loaded pending → the waiting count; loaded fully reviewed → hidden, tooltip says 0; unsynced → total fallback", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    try {
      useConnectionStore.setState({ sessionId: "s-busy", activeSessions: [
        { sessionId: "s-busy", title: "Busy", live: true, artifactCount: 3 },
        { sessionId: "s-done", title: "Done", live: true, artifactCount: 2 },
        { sessionId: "s-unsynced", title: "Elsewhere", live: false, artifactCount: 5 },
      ] } as any);
      useArtifactStore.setState({ artifacts: [
        draft("b1", "s-busy"), draft("b2", "s-busy"), draft("b3", "s-busy", "approved"),
        draft("d1", "s-done", "approved"), draft("d2", "s-done", "approved"),
      ] } as any);
      render(<App />);
      expect(tab("s-busy").querySelector("[data-testid='session-badge']")?.textContent).toBe("2");
      expect(tab("s-done").querySelector("[data-testid='session-badge']")).toBeNull();
      expect(tab("s-done").getAttribute("title")).toContain("Waiting for you: 0");
      expect(tab("s-unsynced").querySelector("[data-testid='session-badge']")?.textContent).toBe("5");
      expect(tab("s-unsynced").getAttribute("title")).not.toContain("Waiting for you");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
