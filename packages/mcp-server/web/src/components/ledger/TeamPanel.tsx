import type { TeamPreferencesData, TeamPreference } from "./types";

export function TeamPanel({ data, error }: { data: TeamPreferencesData | null; error: string | null }) {
  if (error) {
    return (
      <div className="p-5 text-xs text-accent-red">
        Could not load team preferences: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="p-5 text-xs text-text-muted">Loading…</div>;
  }
  if (!data.exists || data.preferences.length === 0) {
    return (
      <div className="p-5 text-xs text-text-muted leading-relaxed space-y-3">
        <p className="font-medium text-text-secondary">No team conventions set up yet.</p>
        <p>
          Team conventions live at <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">.deeppairing/team.json</code> — a
          committable file your whole team's deepPairing sessions will pick up. Scaffold one with:
        </p>
        <pre className="text-[11px] bg-surface-elevated px-3 py-2 rounded border border-border-default overflow-x-auto">
          npx deeppairing team init
        </pre>
        <p className="leading-relaxed">
          Each preference carries a <strong>kind</strong> (require / prefer / avoid),
          a <strong>concept</strong> in plain English, a <strong>rationale</strong>,
          and optional path scope. Pre-flight validation uses avoid / require
          to refuse conflicting proposals; prefer is taste.
        </p>
      </div>
    );
  }

  const groups: Array<["require" | "avoid" | "prefer", string, TeamPreference[]]> = [
    ["require", "Required", data.preferences.filter((p) => p.kind === "require")],
    ["avoid", "Avoid", data.preferences.filter((p) => p.kind === "avoid")],
    ["prefer", "Preferred", data.preferences.filter((p) => p.kind === "prefer")],
  ];

  return (
    <div className="p-5 space-y-5">
      <div className="text-2xs text-text-muted leading-relaxed">
        Read-only here — edit <code className="text-[11px] bg-surface-elevated px-1 py-0.5 rounded">.deeppairing/team.json</code> and commit.
      </div>
      {groups.map(([kind, label, prefs]) => {
        if (prefs.length === 0) return null;
        return (
          <section key={kind}>
            <div className="text-2xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
              {label} ({prefs.length})
            </div>
            <ul className="space-y-2.5">
              {prefs.map((p) => (
                <TeamPrefRow key={p.id} pref={p} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function TeamPrefRow({ pref }: { pref: TeamPreference }) {
  const badge =
    pref.kind === "require" ? "bg-accent-red-dim text-accent-red"
    : pref.kind === "avoid" ? "bg-accent-red-dim text-accent-red"
    : "bg-accent-green-dim text-accent-green";

  return (
    <li className="rounded border border-border-default bg-surface-secondary p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-text-primary break-words">{pref.concept}</div>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${badge}`}>
          {pref.kind}
        </span>
      </div>
      <div className="mt-1 text-2xs text-text-secondary leading-relaxed">
        {pref.rationale}
      </div>
      {(pref.scope?.paths?.length || pref.addedBy) && (
        <div className="mt-1.5 text-[10px] text-text-muted flex gap-x-3 flex-wrap">
          {pref.scope?.paths?.length && (
            <span>scope: {pref.scope.paths.join(", ")}</span>
          )}
          {pref.addedBy && <span>added by {pref.addedBy}</span>}
        </div>
      )}
    </li>
  );
}
