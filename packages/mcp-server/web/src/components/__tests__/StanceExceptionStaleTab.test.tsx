/**
 * #501 round 4 (Sol P2) — a stale tab (it missed the grant and revoke
 * broadcasts) previews a block whose allowance the daemon already revoked.
 * Real routes (the StanceWorld daemon), real dialog: the preview shows the
 * terminal state and offers no Allow; nothing claims a fresh grant; the
 * daemon's state stays revoked (nothing re-armed).
 */
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AllowOnceDialogHost } from "../AllowOnceDialog";
import { useAllowOnceStore } from "../../stores/allowOnce";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useToastStore } from "../../stores/toast";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { useConnectionGraceStore } from "../../lib/connectionGrace";
import { resetAnnouncedGrantsForTests } from "../../lib/stanceException";
import { setCurrentHost } from "../../lib/api";

// The real daemon harness lives with the server tests. A runtime import (the
// AttentionPr5 pattern) keeps the web tsconfig's rootDir clean.
const HARNESS = "../../../../src/daemon/__tests__/stance-exceptions.harness.ts";
const PROJECT_ROOT = "../../../../src/project-root.ts";
type World = {
  dir: string;
  wrapper: () => Promise<{ sessionId: string; call: (n: string, a: Record<string, unknown>) => Promise<unknown> }>;
  store: (sid: string) => unknown;
  newestBlock: () => Promise<{ id: string; concept: string } & Record<string, unknown>>;
  grant: (id: string) => Promise<Response>;
  revoke: (id: string) => Promise<Response>;
  allowances: () => Promise<Array<Record<string, unknown>>>;
  dispose: () => Promise<void>;
};
let world: World | undefined;
afterEach(async () => {
  cleanup();
  useAllowOnceStore.setState({ request: null });
  useToastStore.getState().dismissAll();
  delete (window as unknown as { __deepPairingToken?: string }).__deepPairingToken;
  setCurrentHost("");
  await world?.dispose();
  world = undefined;
});

it("the dialog shows the revoked state instead of offering Allow, and no 'Allowed once' appears", async () => {
  const { StanceWorld, holdStance, TOKEN } = await import(/* @vite-ignore */ HARNESS);
  const { projectHashOf } = await import(/* @vite-ignore */ PROJECT_ROOT);
  world = new StanceWorld("dp-sx-stale-") as World;
  const w = await world.wrapper();
  holdStance(world.store(w.sessionId), "global mutable state");
  await w.call("present_code_change", { filePath: "src/config.ts", changeType: "modify", before: "let config = {};", after: "export function loadConfig() {}", reasoning: "Remove global mutable state" });
  const block = await world.newestBlock();
  const id = ((await (await world.grant(block.id)).json()) as { allowance: { id: string } }).allowance.id;
  expect((await world.revoke(id)).status).toBe(200);

  resetAnnouncedGrantsForTests();
  usePreflightBlockStore.setState({ blocks: [{ ...block, serverId: block.id, allowance: undefined, seenAt: undefined }], loaded: true, liveRev: {}, lastSeenAt: null } as never);
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: w.sessionId, projectHash: projectHashOf(world.dir), disconnectedSince: null } as never);
  useConnectionGraceStore.setState({ everConnected: true, graceOver: false, hydrationStalled: false });
  usePreferencesStore.setState({ nextUpBar: false });
  (window as unknown as { __deepPairingToken: string }).__deepPairingToken = TOKEN;
  setCurrentHost("localhost:1");
  render(<AllowOnceDialogHost />);
  act(() => useAllowOnceStore.getState().open({ blockId: block.id, concept: block.concept }));
  expect(await screen.findByTestId("allow-once-existing")).toHaveTextContent("that allowance is now revoked. Nothing new was allowed.");
  expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  expect(useToastStore.getState().toasts.map((t) => t.title).join(" ")).not.toContain("Waiting for Claude to retry");
  expect((await world.allowances())[0]).toMatchObject({ id, state: "revoked" });
});
