import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeaturesModal } from "../FeaturesModal";
import { enterSessionReplay } from "../../lib/session-replay";

// The cross-session navigation is exercised by its own module; here we assert
// the modal CALLS it with the right target (and closes) — a fake, not a mock.
vi.mock("../../lib/session-replay", () => ({
  enterSessionReplay: vi.fn().mockResolvedValue(true),
}));

const M6 = {
  id: "milestone-6",
  title: "Milestone 6",
  artifactCount: 2,
  openItemCount: 2,
  lastActivity: "2026-08-01T10:00:00Z",
  artifactRefs: [
    { sessionId: "s1", artifactId: "a1", type: "plan", title: "quota backfill plan", status: "approved", createdAt: "2026-08-01T09:00:00Z" },
    { sessionId: "s1", artifactId: "a2", type: "changeset", title: "quota backfill changeset", status: "draft", createdAt: "2026-08-01T10:00:00Z" },
  ],
  openItems: [
    { kind: "decision", label: "Which cache backend?", sessionId: "s1", artifactId: "a1" },
    { kind: "question", label: "why the 15m TTL?", sessionId: "s1", artifactId: "a2", commentId: "q1" },
  ],
  fileTouches: [
    { path: "src/quota.ts", alsoIn: [] },
    { path: "src/shared.ts", alsoIn: ["Phase 9"] },
  ],
};
const UNGROUPED = {
  id: "__ungrouped__",
  title: "Ungrouped",
  ungrouped: true,
  artifactCount: 1,
  openItemCount: 0,
  lastActivity: "2026-07-01T10:00:00Z",
  artifactRefs: [
    { sessionId: "s1", artifactId: "z1", type: "plan", title: "loose refactor", status: "approved", createdAt: "2026-07-01T10:00:00Z" },
  ],
  openItems: [],
  fileTouches: [],
};

function stubFeatures(payload: { groups: unknown[]; failedSessions: unknown[] }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
}

beforeEach(() => {
  vi.mocked(enterSessionReplay).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FeaturesModal", () => {
  it("renders a group with its count + open-item badge, and its timeline", async () => {
    stubFeatures({ groups: [M6], failedSessions: [] });
    render(<FeaturesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Milestone 6")).toBeInTheDocument());
    expect(screen.getByText(/2 items/)).toBeInTheDocument();
    // Named features are expanded by default → timeline artifacts visible.
    expect(screen.getByText("quota backfill plan")).toBeInTheDocument();
    expect(screen.getByText("quota backfill changeset")).toBeInTheDocument();
    // Open items are labelled by kind.
    expect(screen.getByText("Which cache backend?")).toBeInTheDocument();
    expect(screen.getByText("why the 15m TTL?")).toBeInTheDocument();
  });

  it("empty state renders when nothing grouped and nothing failed", async () => {
    stubFeatures({ groups: [], failedSessions: [] });
    render(<FeaturesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no features yet/i)).toBeInTheDocument());
  });

  it("all-ungrouped: the Ungrouped bucket renders, collapsed by default", async () => {
    stubFeatures({ groups: [UNGROUPED], failedSessions: [] });
    render(<FeaturesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Ungrouped")).toBeInTheDocument());
    // Collapsed → its timeline artifact is NOT shown until expanded.
    expect(screen.queryByText("loose refactor")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Ungrouped"));
    expect(await screen.findByText("loose refactor")).toBeInTheDocument();
  });

  it("clicking a timeline artifact navigates to its session, then closes", async () => {
    const onClose = vi.fn();
    stubFeatures({ groups: [M6], failedSessions: [] });
    render(<FeaturesModal onClose={onClose} />);
    const row = await screen.findByText("quota backfill plan");
    await userEvent.click(row);
    await waitFor(() => expect(enterSessionReplay).toHaveBeenCalledWith("s1", "a1"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("clicking an open item navigates to the artifact it points at", async () => {
    stubFeatures({ groups: [M6], failedSessions: [] });
    render(<FeaturesModal onClose={() => {}} />);
    const q = await screen.findByText("why the 15m TTL?");
    await userEvent.click(q);
    await waitFor(() => expect(enterSessionReplay).toHaveBeenCalledWith("s1", "a2"));
  });

  it("file touches are collapsible and show cross-group 'also touched by'", async () => {
    stubFeatures({ groups: [M6], failedSessions: [] });
    render(<FeaturesModal onClose={() => {}} />);
    const toggle = await screen.findByText(/files touched \(2\)/i);
    // Collapsed by default.
    expect(screen.queryByText("src/quota.ts")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(await screen.findByText("src/quota.ts")).toBeInTheDocument();
    expect(screen.getByText(/also touched by Phase 9/i)).toBeInTheDocument();
  });

  it("states the honest grouping limits in-UI", async () => {
    stubFeatures({ groups: [M6], failedSessions: [] });
    render(<FeaturesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Milestone 6")).toBeInTheDocument());
    expect(screen.getByText(/derived from artifact titles/i)).toBeInTheDocument();
    expect(screen.getByText(/decisions don't carry file attribution/i)).toBeInTheDocument();
  });

  it("shows an honest partial banner when a session failed to read", async () => {
    stubFeatures({ groups: [M6], failedSessions: [{ sessionId: "s_bad", reason: "bad json" }] });
    render(<FeaturesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/couldn't be read/i)).toBeInTheDocument());
    expect(screen.getByText(/s_bad/)).toBeInTheDocument();
  });

  it("surfaces a load failure honestly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<FeaturesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/couldn't load features/i)).toBeInTheDocument());
  });

  it("renaming a group posts a rename override and shows the new title (#206)", async () => {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ groups: [{ ...M6, title: "Quota backfill" }], failedSessions: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ groups: [M6], failedSessions: [] }) });
    }));
    render(<FeaturesModal onClose={() => {}} />);
    await screen.findByText("Milestone 6");
    await userEvent.click(screen.getByLabelText("Rename Milestone 6")); // the ✎ button
    const input = screen.getByLabelText("Rename Milestone 6"); // now the input
    await userEvent.clear(input);
    await userEvent.type(input, "Quota backfill{Enter}");
    await waitFor(() => expect(screen.getByText("Quota backfill")).toBeInTheDocument());
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(String(post!.init!.body))).toEqual({ action: "rename", groupKey: "milestone-6", title: "Quota backfill" });
  });

  it("moving an artifact posts an assign override to the chosen feature (#206)", async () => {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ groups: [M6, UNGROUPED], failedSessions: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ groups: [M6, UNGROUPED], failedSessions: [] }) });
    }));
    render(<FeaturesModal onClose={() => {}} />);
    await screen.findByText("quota backfill plan");
    // M6 (expanded) rows carry a move-select whose only target is Ungrouped.
    const selects = screen.getAllByLabelText(/to another feature/i);
    await userEvent.selectOptions(selects[0]!, "__ungrouped__");
    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post!.init!.body))).toEqual({ action: "assign", artifactId: "a1", groupKey: "__ungrouped__" });
    });
  });

  it("the footnote mentions the feature tags and human corrections (#206)", async () => {
    stubFeatures({ groups: [M6], failedSessions: [] });
    render(<FeaturesModal onClose={() => {}} />);
    await screen.findByText("Milestone 6");
    expect(screen.getByText(/feature tags the agent stamps/i)).toBeInTheDocument();
    expect(screen.getByText(/rename a feature/i)).toBeInTheDocument();
  });

  it("Ungrouped is rendered last, after named features", async () => {
    stubFeatures({ groups: [M6, UNGROUPED], failedSessions: [] });
    render(<FeaturesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Milestone 6")).toBeInTheDocument());
    const groupsList = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-feature-group"));
    expect(within(groupsList[0]!).getByText("Milestone 6")).toBeInTheDocument();
    expect(within(groupsList.at(-1)!).getByText("Ungrouped")).toBeInTheDocument();
  });
});
