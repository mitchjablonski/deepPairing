import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ArtifactDetail } from "../ArtifactPanel";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #158 — the secret-warning CONSUMER. The server has scanned code changes /
 * findings for secret shapes since V4 and broadcast a `secret_warning` WS
 * event — but nothing ever consumed it, so a pasted API key landed on disk
 * with zero user-visible signal. The warning is now PERSISTED on the artifact
 * (`secretWarnings`, labels + pattern prefixes only) and rendered as a
 * role="alert" banner on the artifact detail card.
 *
 * The fixture secret is deliberately AWS's documented EXAMPLE key — it is not,
 * and never was, a real credential.
 */
const FAKE_SECRET = "AKIAIOSFODNN7EXAMPLE";

const mkArtifact = (over: Record<string, unknown> = {}) =>
  ({
    id: "art_secret1",
    sessionId: "s1",
    type: "code_change",
    title: "modify src/config.ts",
    status: "draft",
    version: 1,
    parentId: null,
    agentReasoning: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    content: {
      filePath: "src/config.ts",
      changeType: "modify",
      before: "const key = process.env.AWS_KEY;",
      after: `const key = "${FAKE_SECRET}";`,
      reasoning: "hardcode for the demo",
    },
    ...over,
  }) as any;

const flagged = () =>
  mkArtifact({ secretWarnings: [{ pattern: "AKIA", label: "AWS access key id" }] });

beforeEach(() => {
  useArtifactStore.getState().reset();
});

describe("#158 — secret-warning banner on the artifact card", () => {
  it("renders a role=alert banner naming the secret KIND when the scanner flagged the artifact", () => {
    render(<ArtifactDetail artifact={flagged()} />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/possible secret detected/i);
    // The KIND (label) and the pattern prefix are shown…
    expect(banner).toHaveTextContent(/AWS access key id/);
    expect(banner).toHaveTextContent(/review .*before approving/i);
  });

  it("renders NO banner on a clean artifact", () => {
    render(<ArtifactDetail artifact={mkArtifact()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/possible secret detected/i)).toBeNull();
  });

  it("NEVER echoes the matched secret value into the banner", () => {
    render(<ArtifactDetail artifact={flagged()} />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).not.toContain(FAKE_SECRET);
  });

  // #160 — the scanner records WHERE it matched (field path + 1-based line);
  // the banner renders the location so the human doesn't have to hunt.
  it("shows the match location when the warning carries field + line", () => {
    render(
      <ArtifactDetail
        artifact={mkArtifact({
          secretWarnings: [
            { pattern: "AKIA", label: "AWS access key id", field: "after", line: 4 },
          ],
        })}
      />,
    );
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/in `after` \(line 4\)/);
    expect(banner.textContent).not.toContain(FAKE_SECRET);
  });

  it("still renders a pre-#160 warning that has no location (back-compat)", () => {
    render(<ArtifactDetail artifact={flagged()} />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/AWS access key id/);
    expect(banner.textContent).not.toMatch(/line /);
  });

  it("survives a reload: a plain-JSON artifact hydrated into the store still shows the banner", () => {
    // Simulate the WS `connected` hydration path: the daemon replays stored
    // artifacts as plain JSON (JSON round-trip strips any live references).
    const fromDisk = JSON.parse(JSON.stringify(flagged()));
    useArtifactStore.getState().addArtifact(fromDisk);
    const stored = useArtifactStore
      .getState()
      .artifacts.find((a) => a.id === "art_secret1")!;
    render(<ArtifactDetail artifact={stored} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/possible secret detected/i);
  });
});
