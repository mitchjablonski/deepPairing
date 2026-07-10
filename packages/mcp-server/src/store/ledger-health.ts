import fs from "node:fs";
import path from "node:path";
import type { GlobalStore } from "./global-store.js";

/**
 * H2-1 — fact-gathering for the `dp doctor` philosophy-ledger health check.
 * Pure w.r.t. presentation (returns data, does no console I/O) so it's testable
 * with a real GlobalStore pointed at a tmp file — fakes not mocks. doctor
 * renders this with its own colors.
 *
 * The philosophy ledger is the single most precious file deepPairing owns:
 * months of accumulated cross-project taste, no other copy. v0.1.6 FREEZES
 * writes when the file is unreadable (so a reset can't destroy history), but
 * that freeze was invisible — recordInstance() returns void and every call site
 * swallows in try/catch. This surfaces the freeze AND, deliberately, only ever
 * REPORTS: it computes the exact `mv` command for the user to run, and never
 * itself deletes/truncates/overwrites the ledger.
 */
export interface LedgerHealthReport {
  state: "ok" | "frozen";
  ledgerPath: string;
  /** true when the live ledger parses (state === "ok"). */
  parses: boolean;
  /** Why the ledger is distrusted (frozen only). */
  reason?: string;
  /** This-process `.corrupt-<ts>` snapshot, when one was captured. */
  backupPath?: string;
  /** Every `.corrupt-*` snapshot found next to the ledger on disk (absolute). */
  corruptSnapshots: string[];
  /** Size of the live (unreadable) file, printed as "shape" before any move. */
  sizeBytes?: number;
  /** Suggested non-destructive move-aside target (frozen only). */
  asidePath?: string;
  /** The exact, non-destructive shell command the user should run (frozen only). */
  remedyCommand?: string;
}

/** Gather ledger-health facts from a GlobalStore (which knows its own path). */
export function buildLedgerHealthReport(store: GlobalStore): LedgerHealthReport {
  const health = store.getHealth();
  const ledgerPath = health.ledgerPath;

  // Scan the ledger dir for `.corrupt-*` snapshots left by ANY prior freeze —
  // a fresh doctor process's in-memory snapshot map only knows corruption it
  // saw itself, but a previous daemon may have left recovery copies on disk.
  let corruptSnapshots: string[] = [];
  try {
    const dir = path.dirname(ledgerPath);
    const base = path.basename(ledgerPath);
    corruptSnapshots = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + ".corrupt-"))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    // dir missing / unreadable — nothing to report
  }

  if (health.state === "ok") {
    return { state: "ok", ledgerPath, parses: true, corruptSnapshots };
  }

  let sizeBytes: number | undefined;
  try {
    sizeBytes = fs.statSync(ledgerPath).size;
  } catch {
    // file may be unreadable/gone — omit the size rather than guessing
  }
  const asidePath = `${ledgerPath}.unreadable-${Date.now()}`;
  return {
    state: "frozen",
    ledgerPath,
    parses: false,
    ...(health.reason ? { reason: health.reason } : {}),
    ...(health.backupPath ? { backupPath: health.backupPath } : {}),
    corruptSnapshots,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    asidePath,
    remedyCommand: `mv '${ledgerPath}' '${asidePath}'`,
  };
}
