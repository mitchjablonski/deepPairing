import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "@deeppairing/shared";
import { ExplainerArtifact } from "../artifacts/ExplainerArtifact";
import { explainerArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { useArtifactStore } from "../../stores/artifact";

// The verb triad (ArtifactStatusActions) only renders its full Approve / Request
// changes / Reject row when the user is at the artifact's end. Stub
// IntersectionObserver so the sentinel reports intersecting and the full panel
// mounts deterministically in jsdom/happy-dom.
function stubIO(isIntersecting: boolean) {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: any;
      constructor(cb: any) { this.cb = cb; }
      observe() { this.cb([{ isIntersecting }]); }
      disconnect() {}
      unobserve() {}
    } as any,
  );
}

/** Read the JSON body of the most recent POST to /api/comments. */
function lastCommentPost(): any {
  const calls = (globalThis.fetch as any).mock.calls.filter(([u]: any[]) =>
    String(u).includes("/api/comments"),
  );
  const [, init] = calls[calls.length - 1];
  return JSON.parse(init.body);
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.getState().addArtifact(explainerArtifact);
  stubIO(true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("ExplainerArtifact — renders the walk-through", () => {
  it("renders the overview, every ordered section, evidence, and the related link", () => {
    render(<ExplainerArtifact artifact={explainerArtifact} />);

    // Overview narrative.
    expect(screen.getByText(/walk the request path for an authenticated route/i)).toBeInTheDocument();
    // All three ordered sections render their headings.
    expect(screen.getByText(/The cookie is read at the middleware edge/i)).toBeInTheDocument();
    // "…looked up and its TTL refreshed…" also appears in the overview paragraph;
    // scope to the heading-unique tail so this pins the SECTION heading.
    expect(screen.getByText(/looked up and its TTL refreshed in one step/i)).toBeInTheDocument();
    expect(screen.getByText(/An expired session fails closed/i)).toBeInTheDocument();
    expect(screen.getAllByTestId("explainer-section")).toHaveLength(3);
    // Evidence (reused Research renderer) — the file:line header.
    expect(screen.getByText(/auth\/middleware\.ts:26-30/)).toBeInTheDocument();
    // Related artifact drill-in link.
    expect(screen.getByTestId("explainer-related")).toBeInTheDocument();
  });

  it("#193 E2 — the read-only acknowledge footer: Got it + Ask more, NO verdict verbs", () => {
    render(<ExplainerArtifact artifact={explainerArtifact} />);
    expect(screen.getByRole("button", { name: /got it/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask more/i })).toBeInTheDocument();
    // Nothing here proposes an approach → no reject / request-changes.
    expect(screen.queryByRole("button", { name: /request changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();
  });

  it("#193 E2 — Got it marks the explainer approved (reuses the status machinery)", async () => {
    const user = userEvent.setup();
    render(<ExplainerArtifact artifact={explainerArtifact} />);
    await user.click(screen.getByRole("button", { name: /got it/i }));
    await waitFor(() => {
      const statusCall = (globalThis.fetch as any).mock.calls.find(([u]: any[]) =>
        String(u).includes("/api/artifacts/art_explainer_001/status"),
      );
      expect(statusCall).toBeTruthy();
      expect(statusCall[1].body).toContain('"status":"approved"');
      // No cross-project stance is ever sent for a comprehension artifact.
      expect(statusCall[1].body).not.toContain('"concept"');
    });
  });

  it("#193 E2 — the composer does NOT steal focus on mount, but Ask more focuses it", async () => {
    const user = userEvent.setup();
    render(<ExplainerArtifact artifact={explainerArtifact} />);
    const composer = screen.getByLabelText("Comment on this explainer");
    // Fail-on-revert: an unguarded focusSignal=0 fired the focus effect ON MOUNT
    // (0 == null is false, 0 === undefined is false) and stole focus into the
    // bottom composer — contradicting read-top-to-bottom. It must stay unfocused.
    expect(document.activeElement).not.toBe(composer);
    // …until the human explicitly asks for it.
    await user.click(screen.getByRole("button", { name: /ask more/i }));
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });
});

describe("ExplainerArtifact — #207 (I2 review) write-axis lock", () => {
  const retracted = { ...explainerArtifact, status: "retracted" as const };
  const approved = { ...explainerArtifact, status: "approved" as const };

  it("RETRACTED: ask-anything + every per-block grain withheld; the walk stays readable", () => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(retracted);
    render(<ExplainerArtifact artifact={retracted} />);

    // Ask-anything composer gone.
    expect(screen.queryByLabelText("Comment on this explainer")).not.toBeInTheDocument();
    // No grain toggle anywhere (overview + walk sections).
    expect(screen.queryByRole("button", { name: "Comment on What you're about to read" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-grain-affordance]").length).toBe(0);
    // The suggested-question chips (a write shortcut) are pulled too.
    expect(screen.queryByTestId("explainer-suggested-questions")).not.toBeInTheDocument();
    // …but the narrative stays readable.
    expect(screen.getByText(/walk the request path for an authenticated route/i)).toBeInTheDocument();
    expect(screen.getByText(/this explainer is read-only/i)).toBeInTheDocument();
  });

  it("APPROVED (acknowledged / 'Read') STAYS late-commentable — composers STILL LIVE", () => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(approved);
    render(<ExplainerArtifact artifact={approved} />);
    // A Got-it explainer keeps its ask surface (you can still ask about code you read).
    expect(screen.getByLabelText("Comment on this explainer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comment on What you're about to read" })).toBeInTheDocument();
  });
});

describe("ExplainerArtifact — related drill-in", () => {
  it("clicking a related link SELECTS the referenced artifact", async () => {
    const user = userEvent.setup();
    render(<ExplainerArtifact artifact={explainerArtifact} />);
    const link = screen.getByTestId("explainer-artifact-ref");
    await user.click(link);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("art_changeset_001");
  });
});

describe("ExplainerArtifact — suggested-question chips", () => {
  it("clicking a chip prefills the ask-anything composer with that question", async () => {
    const user = userEvent.setup();
    render(<ExplainerArtifact artifact={explainerArtifact} />);

    const chips = screen.getAllByTestId("explainer-question-chip");
    expect(chips.length).toBe(2);
    await user.click(chips[0]!);

    // Pre-fix (no prefill wiring) the composer would stay empty.
    const composer = screen.getByLabelText("Comment on this explainer") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(composer.value).toBe("Where does the session get created in the first place?");
    });
  });
});

describe("ExplainerArtifact — ask-anything thread", () => {
  it("posts a question with intent 'question' (the question-priority lane)", async () => {
    const user = userEvent.setup();
    render(<ExplainerArtifact artifact={explainerArtifact} />);

    const composer = screen.getByLabelText("Comment on this explainer");
    await user.type(composer, "Any perf concern under load?");
    // The secondary "Ask" submit carries intent:"question".
    const askButtons = screen.getAllByRole("button", { name: "Ask" });
    const enabledAsk = askButtons.find((b) => !(b as HTMLButtonElement).disabled)!;
    await user.click(enabledAsk);

    await waitFor(() => {
      const body = lastCommentPost();
      expect(body.intent).toBe("question");
      expect(body.target.artifactId).toBe("art_explainer_001");
      expect(body.target.sectionId).toBeUndefined();
    });
  });
});

describe("ExplainerArtifact — grain comments", () => {
  it("a block comment carries the explainer:<key> sectionId grain", async () => {
    const user = userEvent.setup();
    render(<ExplainerArtifact artifact={explainerArtifact} />);

    // Open the overview block's grain composer.
    await user.click(screen.getByRole("button", { name: "Comment on What you're about to read" }));
    const composer = screen.getByLabelText("Comment on What you're about to read");
    await user.type(composer, "Great framing up top.");
    // Scope to the block's own composer — the ask-anything thread also has a
    // "Comment" submit, so the query would be ambiguous unscoped.
    const block = composer.closest("div.rounded-lg") as HTMLElement;
    await user.click(within(block).getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      const body = lastCommentPost();
      expect(body.target.sectionId).toBe("explainer:overview");
    });
  });

  it("a section comment carries the numeric explainer:<i> grain", async () => {
    const user = userEvent.setup();
    render(<ExplainerArtifact artifact={explainerArtifact} />);

    // The third section ("An expired session fails closed") has no evidence, so
    // its only affordance is the grain "Comment" button — target section 2 (0-based).
    const sections = screen.getAllByTestId("explainer-section");
    const third = sections[2]!;
    await user.click(within(third).getByRole("button", { name: /Comment on/i }));
    const composer = within(third).getByLabelText(/Comment on/i);
    await user.type(composer, "Good that it fails closed.");
    await user.click(within(third).getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      const body = lastCommentPost();
      expect(body.target.sectionId).toBe("explainer:2");
    });
  });
});

// --- R4 (#284) — visuals (P-B) + unknowns (P-C) on the explainer ------------

/** The fixture explainer plus R4 fields, for the P-B / P-C renderer pins. */
const explainerWithR4: Artifact = {
  ...explainerArtifact,
  id: "art_explainer_r4",
  content: {
    ...(explainerArtifact.content as Record<string, unknown>),
    visuals: [
      { id: "seq", kind: "diagram", title: "Request path", source: "sequenceDiagram; Client->>API: GET /me" },
    ],
    unknowns: [
      "I couldn't tell whether the CLI login path is covered — I didn't read cli/init.ts",
    ],
  },
};

describe("ExplainerArtifact — R4 P-B visuals", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(explainerWithR4);
  });

  it("renders an attached diagram visual through the shared ArtifactVisuals block", () => {
    render(<ExplainerArtifact artifact={explainerWithR4} />);
    expect(screen.getByText(/Visuals \(1\)/i)).toBeInTheDocument();
    // "Request path" is the visual title (it may also appear in the diagram
    // fallback render), so assert at least one occurrence rather than uniqueness.
    expect(screen.getAllByText(/Request path/i).length).toBeGreaterThan(0);
    // The per-visual comment affordance (region-commentable diagram) is present.
    expect(screen.getByRole("button", { name: /Comment on this diagram/i })).toBeInTheDocument();
  });
});

describe("ExplainerArtifact — R4 P-C unknowns", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(explainerWithR4);
    stubIO(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the 'What I'm not sure about' block above the fold with each gap", () => {
    render(<ExplainerArtifact artifact={explainerWithR4} />);
    expect(screen.getByTestId("explainer-unknowns")).toBeInTheDocument();
    expect(screen.getByText(/What I'm not sure about \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/didn't read cli\/init\.ts/i)).toBeInTheDocument();
  });

  it("each gap carries a one-click Ask that prefills the ask-anything composer (the CTA)", async () => {
    const user = userEvent.setup();
    render(<ExplainerArtifact artifact={explainerWithR4} />);
    const unknown = screen.getByTestId("explainer-unknown");
    await user.click(within(unknown).getByTestId("explainer-unknown-ask"));
    const ask = within(screen.getByTestId("explainer-ask-anything")).getByRole("textbox");
    await waitFor(() => {
      expect((ask as HTMLTextAreaElement).value).toMatch(/didn't read cli\/init\.ts/i);
    });
  });
});
