import { useMemo, useState } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { usePreflightBlockStore, type PreflightBlockRecord } from "../stores/preflightBlocks";
import { useOfflineReason } from "../hooks/useOfflineReason";
import { postRevoke, receiptLabel } from "../lib/stanceException";

/**
 * #470 slice 2 — where an allowance stays visible after the toast fades:
 * the artifact badge, the debrief's system section, and the Ledger. Built
 * from the artifacts' own `admission` stamps and the daemon's block-log
 * receipts — never from agent prose, so an agent-written debrief can't drop
 * it. The labels name the door (UI/CLI); they never name or verify a person.
 */

const DOOR_NOTE = "The label names the door the grant came through, not who granted it.";

export function AllowedOnceBadge({ artifact }: { artifact: Artifact }) {
  if (!artifact.admission) return null;
  const via = artifact.admission.grantedVia === "cli" ? "CLI" : "UI";
  return (
    <div className="inline-flex items-center gap-1 rounded border border-accent-violet/40 bg-accent-violet-dim/30 px-2 py-0.5 text-2xs text-accent-violet"
      data-testid="allowed-once-badge" title={`Blocked by your stance, then let through once because you allowed this exact proposal. ${DOOR_NOTE}`}>
      Allowed once ({via})
    </div>
  );
}

/** The debrief's system section: every allowance used in this session. */
export function AllowedOnceSection({ sessionId }: { sessionId?: string }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const admitted = useMemo(
    () => artifacts.filter((a) => a.admission && (!sessionId || a.sessionId === sessionId)),
    [artifacts, sessionId],
  );
  if (admitted.length === 0) return null;
  return (
    <section className="bg-surface-secondary rounded-lg border border-accent-violet/30 p-3.5 space-y-2" data-testid="debrief-allowed-once" aria-label="Allowed once this session">
      <h3 className="text-xs font-semibold text-text-primary">Allowed once this session</h3>
      <p className="text-2xs text-text-muted">Added by deepPairing from its own records, not written by the agent. {DOOR_NOTE}</p>
      <ul className="text-2xs space-y-1">
        {admitted.map((a) => (
          <li key={a.id}>
            <span className="text-text-primary">{a.title}</span>{" "}
            <span className="text-text-muted">({a.id}) · {a.admission!.grantedVia === "cli" ? "CLI" : "UI"} · {a.status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The Ledger drawer's view: allowances per stance, receipts, and Revoke. */
export function LedgerAllowances() {
  const blocks = usePreflightBlockStore((s) => s.blocks);
  const offline = useOfflineReason();
  const [error, setError] = useState<string | null>(null);
  const byStance = useMemo(() => {
    const groups = new Map<string, PreflightBlockRecord[]>();
    for (const b of blocks) {
      if (!b.allowance) continue;
      groups.set(b.concept, [...(groups.get(b.concept) ?? []), b]);
    }
    return [...groups.entries()];
  }, [blocks]);
  if (byStance.length === 0) return null;
  return (
    <div className="px-5 py-3 border-b border-border-default space-y-2" data-testid="ledger-allowances">
      <div className="text-2xs font-semibold text-text-secondary">Allowed once</div>
      {byStance.map(([concept, items]) => (
        <div key={concept} className="text-2xs">
          <div className="text-text-primary">'{concept}' · {items.length} allowance{items.length === 1 ? "" : "s"}</div>
          <ul className="mt-0.5 space-y-1">
            {items.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 text-text-secondary">
                <span>{receiptLabel(b.allowance!.state, b.allowance!.grantedVia)}{b.allowance!.reason ? ` — “${b.allowance!.reason}”` : ""}</span>
                {b.allowance!.state === "allowed" && (
                  <button type="button" disabled={!!offline} title={offline ?? undefined}
                    onClick={async () => { const r = await postRevoke(b.allowance!.id); setError(r.ok ? null : r.message ?? "Revoke failed"); }}
                    className="min-h-[32px] min-w-[32px] px-2 rounded border border-border-default hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed">
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {error && <div role="alert" className="text-2xs text-accent-red">{error}</div>}
    </div>
  );
}
