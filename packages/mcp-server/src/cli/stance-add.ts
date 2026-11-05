import path from "node:path";
import type { IStore } from "../store/store-interface.js";
import { formatRecordStanceOutcome, parseStanceArguments, recordStance, STANCE_USAGE } from "../store/stance-add.js";

/**
 * #620 — `deeppairing stance add <what> -- <why>` for source installs. Same
 * parser, validation and add-only write as the `/deeppairing:reject` MCP door
 * (store/stance-add.ts). It writes through a FileStore on this project, the
 * way `philosophy publish` does, so it works whether or not the daemon is
 * running; the daemon and the hook read preferences.json fresh on every
 * check, so the stance applies on the next proposal or edit.
 *
 * `requestedBy` is "user" only from an interactive terminal outside Claude
 * Code; otherwise "unknown". Self-reported, like every door label here.
 */
export interface StanceAddIo {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  write: (text: string) => void;
  writeErr: (text: string) => void;
  openStore: () => Promise<Pick<IStore, "recordRejectedApproach" | "getSessionMemory"> & { dispose?: () => void }>;
}

export async function runStanceAddCommand(args: string[], io: StanceAddIo): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.writeErr(`  Usage: stance add ${STANCE_USAGE}\n  Example: stance add "global mutable state for config" -- "keep configuration explicit"\n`);
    return args.length === 0 ? 1 : 0;
  }
  const { what, why } = parseStanceArguments(args);
  const requestedBy = io.stdinIsTTY && io.env.CLAUDECODE !== "1" ? "user" : "unknown";
  const store = await io.openStore();
  try {
    const outcome = await recordStance(store, { what, why, addedVia: "cli", requestedBy });
    const { ok, text } = formatRecordStanceOutcome(outcome, `Project ${path.basename(io.projectRoot)}`);
    if (ok) io.write(`${text.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
    else io.writeErr(`  ✗ ${text}\n`);
    return ok ? 0 : 1;
  } finally {
    store.dispose?.();
  }
}
