import type { Provenance } from "../lib/provenance";

/**
 * #569 proposal 1 — live work vs demo/sample content, made unmistakable.
 *
 *   - ProvenanceChip: compact, inline. Live work reads "● Live · <project>";
 *     demo/sample reads "Demo" in a dashed violet chip. Text carries the
 *     meaning — colour is a second channel, never the only one. Violet, not
 *     amber: amber is the "needs you" colour in this shell.
 *   - DemoContentBanner: one slim named region above demo/sample content,
 *     "Demo — sample content, not your project". It sits at the TOP of the
 *     panel, never near the composer.
 *
 * Labelling only: neither component reads or changes gates, attention or
 * counts.
 */
export function ProvenanceChip({ provenance, className = "" }: { provenance: Provenance | null; className?: string }) {
  if (!provenance) return null;
  if (provenance.kind === "live") {
    const word = provenance.history ? "Your project" : "Live";
    const name = provenance.projectName;
    return (
      <span
        data-testid="provenance-live"
        data-provenance="live"
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs shrink-0 min-w-0
                    bg-accent-green-dim text-accent-green border border-accent-green/30 ${className}`}
        title={`Real work${name ? ` in ${name}` : ""}${provenance.history ? " (past session, read-only)" : ""} — not demo content`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green shrink-0" aria-hidden="true" />
        <span className="font-semibold shrink-0">{word}</span>
        {name && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate max-w-32">{name}</span>
          </>
        )}
      </span>
    );
  }
  return (
    <span
      data-testid="provenance-demo"
      data-provenance={provenance.kind}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-semibold shrink-0
                  bg-accent-violet-dim text-accent-violet border border-dashed border-accent-violet/60 ${className}`}
      title="Demo — sample content, not your project"
    >
      Demo
    </span>
  );
}

/** Inline "Demo" tag for a session name in a list (session bar, past sessions, Threads). */
export function DemoTag() {
  return (
    <span
      data-testid="demo-tag"
      className="text-[9px] uppercase tracking-wide font-semibold px-1 py-0.5 rounded shrink-0
                 bg-accent-violet-dim text-accent-violet border border-dashed border-accent-violet/60"
    >
      Demo
    </span>
  );
}

export function DemoContentBanner({ provenance }: { provenance: Provenance | null }) {
  if (!provenance || provenance.kind === "live") return null;
  return (
    <section
      aria-label="Demo content"
      data-testid="demo-banner"
      data-provenance={provenance.kind}
      className="flex items-center gap-2 px-3 py-1 shrink-0 border-b border-dashed border-accent-violet/60 bg-accent-violet-dim"
    >
      <ProvenanceChip provenance={provenance} />
      <p className="text-2xs text-accent-violet min-w-0 truncate">
        <span className="font-semibold">Demo — sample content, not your project.</span>{" "}
        Nothing here is your real work.
      </p>
    </section>
  );
}
