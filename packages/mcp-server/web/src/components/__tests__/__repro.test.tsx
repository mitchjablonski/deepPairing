// TEMP repro: render the real stored spec artifact that crashed in the UI.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { useArtifactStore } from "../../stores/artifact";
import artifactJson from "./__wb-artifact.json";

const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMock } }));

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("repro: art_JIbNxePywY", () => {
  it("renders the stored spec without throwing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const artifact = artifactJson as any;
    render(<SpecArtifact artifact={artifact} />);
  });
});
