import type { Artifact } from "@deeppairing/shared";
import { coercePageContent, PAGE_HTML_MAX_BYTES } from "@deeppairing/shared";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { ConceptBadge } from "../ConceptBadge";
import { PrototypeFrame } from "../PrototypeFrame";
import { ArtifactStatusActions } from "./ArtifactStatusActions";

/**
 * #680 slice 1 — viewer for `page` artifacts: an agent-authored HTML page
 * presented for review.
 *
 * Isolation is PrototypeFrame's, reused rather than copied: an opaque-origin
 * sandbox (never `allow-same-origin`) plus an injected no-network CSP. The page
 * renders at once in a script-less frame (`sandbox=""`) so its markup and CSS
 * read immediately; agent scripts stay click-to-run. The cap is the page cap
 * (2 MB), not the 512 KB prototype-visual cap.
 *
 * The footer is the standard ArtifactStatusActions: Respond / Ask, Request
 * changes, Reject (with the "name the pattern" capture, so a reject feeds
 * rejection memory) and Approve. Element/text annotation inside the frame is
 * slice 2.
 */
export function PageArtifact({ artifact }: { artifact: Artifact }) {
  const page = coercePageContent(artifact.content);
  return (
    <div className="space-y-3" data-testid="page-artifact">
      {page.summary && (
        <div className="px-4 py-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg">
          <SimpleMarkdown text={page.summary} className="prose-field text-sm text-text-primary space-y-2" />
        </div>
      )}
      {(page.sourcePath || page.concept) && (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
          {page.concept && <ConceptBadge name={page.concept.name} explanation={page.concept.oneLineExplanation} />}
          {page.sourcePath && (
            <span>
              From <code className="font-mono text-text-secondary">{page.sourcePath}</code>
            </span>
          )}
        </div>
      )}
      <PrototypeFrame
        html={page.html}
        maxBytes={PAGE_HTML_MAX_BYTES}
        staticFirst
        noun="page"
        frameClassName="w-full h-[70vh] min-h-[420px] rounded border border-border-default bg-white"
      />
      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
