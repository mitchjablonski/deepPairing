import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSwitcher } from "../ProjectSwitcher";
import { setCurrentHost } from "../../lib/api";

// ProjectSwitcher discovers peers via GET /api/projects and reads the current
// host to decide which project is selected. Stub both.
const projects = [
  { projectRoot: "/a", projectHash: "h1", port: 3848, label: "alpha", isSelf: true, pendingCount: 0 },
  { projectRoot: "/b", projectHash: "h2", port: 3884, label: "beta", isSelf: false, pendingCount: 3 },
];

beforeEach(() => {
  setCurrentHost("localhost:3848"); // viewing "alpha"
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ projects }) }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentHost("");
});

describe("ProjectSwitcher — waiting badges", () => {
  it("shows a global indicator counting pending in OTHER projects (not the current one)", async () => {
    render(<ProjectSwitcher />);
    // alpha (current) has 0, beta (other) has 3 → global shows 3.
    await waitFor(() => expect(screen.getByLabelText(/3 items waiting in other projects/i)).toBeInTheDocument());
  });

  it("shows a per-project badge in the dropdown for a project with pending items", async () => {
    render(<ProjectSwitcher />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());
    await userEvent.click(screen.getByTitle(/waiting in other projects/i));
    // beta's row shows its count badge; alpha (0) shows none.
    expect(screen.getByLabelText(/^3 waiting$/i)).toBeInTheDocument();
  });

  it("no global indicator when other projects have nothing pending", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ projects: projects.map((p) => ({ ...p, pendingCount: 0 })) }),
    });
    render(<ProjectSwitcher />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());
    expect(screen.queryByLabelText(/waiting in other projects/i)).not.toBeInTheDocument();
  });
});
