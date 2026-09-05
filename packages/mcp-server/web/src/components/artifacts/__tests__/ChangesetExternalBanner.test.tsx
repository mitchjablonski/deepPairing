/**
 * Q6 (#232) — the external-review banner on ChangesetArtifact.
 *
 * A changeset normally means "I wrote this, it's waiting on your yes to land".
 * With `reviewIntent: "external"` it means the opposite — a colleague's PR,
 * here so you can read it — and the controls look identical either way. The
 * banner is the only thing standing between those two readings, so what it says
 * (and that it degrades to something TRUE when the source is thin) is worth
 * pinning line by line.
 *
 * Q4 SEAM: everything here is artifact-level. Nothing asserts on the per-file
 * header / picker internals that the round-11 UX rider owns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { ChangesetArtifact } from "../ChangesetArtifact";
import { useArtifactStore } from "../../../stores/artifact";
import { useOverlayStore } from "../../../stores/overlay";
import { useReplayStore } from "../../../stores/replay";

const FILES = [
  {
    path: "src/limiter.ts",
    changeType: "added" as const,
    hunks: [{ header: "@@ -0,0 +1,9 @@", lines: [{ kind: "add" as const, content: "const buckets = new Map()", newLine: 3 }] }],
  },
];

function changeset(content: Record<string, unknown>): Artifact {
  return {
    id: "art_cs",
    sessionId: "s1",
    type: "changeset",
    version: 1,
    parentId: null,
    title: "PR #123 — in-process rate limiting",
    status: "draft",
    content: { summary: "Adds a token-bucket limiter.", files: FILES, ...content },
    agentReasoning: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  } as Artifact;
}

const FULL_SOURCE = {
  kind: "github-pr",
  number: 123,
  url: "https://github.com/acme/widgets/pull/123",
  headRef: "feat/rate-limit",
  baseRef: "main",
  author: "dana",
  headSha: "0123456789abcdef0123456789abcdef01234567",
};

function renderChangeset(content: Record<string, unknown>) {
  const art = changeset(content);
  useArtifactStore.getState().reset();
  useArtifactStore.getState().addArtifact(art);
  useArtifactStore.setState({ selectedArtifactId: art.id });
  render(<ChangesetArtifact artifact={art} />);
  return art;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  useArtifactStore.getState().reset();
  useOverlayStore.setState({ count: 0 });
  useReplayStore.setState({ active: false });
});

describe("Q6 — external-review banner", () => {
  it("names the PR, its author, and the branches, and links the PR", () => {
    renderChangeset({ reviewIntent: "external", source: FULL_SOURCE });

    const banner = screen.getByTestId("external-review-banner");
    expect(banner).toHaveTextContent("External PR review");
    expect(banner).toHaveTextContent("#123");
    expect(banner).toHaveTextContent("by dana");
    expect(banner).toHaveTextContent("feat/rate-limit → main");
    expect(banner).toHaveTextContent("reviewed 0123456789ab");

    const link = screen.getByRole("link", { name: "#123" });
    expect(link).toHaveAttribute("href", FULL_SOURCE.url);
    // A PR link leaves the companion UI; open it out of the way, and never hand
    // the target a live window.opener.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("states the semantics that the verdict buttons cannot — verdicts stay local", () => {
    renderChangeset({ reviewIntent: "external", source: FULL_SOURCE });
    // The one sentence the whole banner exists for. If this line ever goes
    // missing, "Approve" on a colleague's PR reads as "ship it".
    expect(screen.getByTestId("external-review-banner")).toHaveTextContent(
      "your verdicts stay local until you post them",
    );
  });

  it("the verdict controls are deliberately UNCHANGED — the semantics live in the banner", () => {
    // Pins the design decision (see the component's header comment): renaming
    // the buttons per-intent would fork the keymap and every test that reads
    // them, to fix a problem of context rather than vocabulary.
    renderChangeset({ reviewIntent: "external", source: FULL_SOURCE });
    expect(screen.getByTestId("looks-right")).toBeInTheDocument();
  });

  it("a LOCAL changeset shows no banner at all", () => {
    renderChangeset({ reviewIntent: "local" });
    expect(screen.queryByTestId("external-review-banner")).not.toBeInTheDocument();
  });

  it("a PRE-Q6 changeset (no reviewIntent) shows no banner — absent means local", () => {
    renderChangeset({});
    expect(screen.queryByTestId("external-review-banner")).not.toBeInTheDocument();
  });
});

describe("Q6 — the banner degrades to something TRUE when the source is thin", () => {
  it("no source at all: still banners, still states the semantics, invents no PR number", () => {
    renderChangeset({ reviewIntent: "external" });
    const banner = screen.getByTestId("external-review-banner");
    expect(banner).toHaveTextContent("External PR review");
    expect(banner).toHaveTextContent("this PR");
    expect(banner).toHaveTextContent("your verdicts stay local until you post them");
    expect(banner.textContent).not.toMatch(/#\d/);
    // Scoped to the banner: the per-file "open in editor" links live elsewhere.
    expect(banner.querySelector("a")).toBeNull();
  });

  it("a number but no url: plain text, never a dead link", () => {
    renderChangeset({ reviewIntent: "external", source: { kind: "github-pr", number: 7 } });
    const banner = screen.getByTestId("external-review-banner");
    expect(banner).toHaveTextContent("#7");
    expect(banner.querySelector("a")).toBeNull();
  });

  it("no author: no dangling ' by '", () => {
    renderChangeset({ reviewIntent: "external", source: { kind: "github-pr", number: 7, url: "https://x/pull/7" } });
    expect(screen.getByTestId("external-review-banner").textContent).not.toMatch(/\bby\b/);
  });

  it("only one branch ref: the arrow is omitted rather than rendered half-empty", () => {
    renderChangeset({ reviewIntent: "external", source: { kind: "github-pr", number: 7, headRef: "feat/x" } });
    expect(screen.getByTestId("external-review-banner").textContent).not.toContain("→");
  });

  it("an unrecognized source kind is dropped by the coercer but the banner still fires on the INTENT", () => {
    // reviewIntent is the load-bearing field; source is decoration. Losing the
    // decoration must never lose the warning.
    renderChangeset({ reviewIntent: "external", source: { kind: "gitlab-mr", number: 9 } });
    const banner = screen.getByTestId("external-review-banner");
    expect(banner).toHaveTextContent("this PR");
    expect(banner).toHaveTextContent("your verdicts stay local until you post them");
  });
});

describe("Q6 — banner accessibility", () => {
  it("is exposed as a labelled note so a screen reader can reach it", () => {
    renderChangeset({ reviewIntent: "external", source: FULL_SOURCE });
    const note = screen.getByRole("note", { name: "External PR review" });
    expect(note).toBe(screen.getByTestId("external-review-banner"));
  });

  it("the decorative separators are hidden from the accessibility tree", () => {
    renderChangeset({ reviewIntent: "external", source: FULL_SOURCE });
    // "·" read aloud between every clause is noise; the text must read as prose.
    const banner = screen.getByTestId("external-review-banner");
    const dots = Array.from(banner.querySelectorAll("span")).filter((s) => s.textContent === "·");
    expect(dots.length).toBeGreaterThan(0);
    for (const d of dots) expect(d).toHaveAttribute("aria-hidden", "true");
  });
});
