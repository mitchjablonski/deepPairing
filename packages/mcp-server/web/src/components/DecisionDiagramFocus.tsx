import { createPortal } from "react-dom";
import type { PlanVisual } from "@deeppairing/shared";
import { useModal } from "../hooks/useModal";
import { VisualBody } from "./ArtifactVisuals";

/**
 * #173 — the FOCUSED VIEW for region-commenting a decision option's diagram.
 *
 * The "Compare diagrams" grid cells are too cramped for reliable drag-select
 * (the #172/#173 ergonomics the region machinery was hardened against), so the
 * grid stays read-only and this dialog is the ONE surface where the region
 * layer goes live. It opens the option's diagram FULL-WIDTH, mounts VisualBody
 * WITHOUT `readOnly` (so `DiagramRegionLayer` — bounded well, crosshair,
 * pointer capture, gutter-clamped normalizeRect — is live), and threads
 * `optionId` through so a comment anchors to optionId + visualId + region
 * together (all three already in the schema — no new fields).
 *
 * Deliberately SELF-CONTAINED and prop-driven: it takes an artifact id, the
 * option, and the visual, and renders a real modal (focus trap + Esc + restore
 * via useModal). It is NOT wired into DecisionCard internals, so the
 * decision discuss-workbench (#174) can nest it as a zoom target unchanged.
 */
export interface DecisionDiagramFocusProps {
  /** The decision artifact id the comment anchors to. */
  artifactId: string;
  /** The option id this diagram belongs to (part of the comment anchor). */
  optionId: string;
  /** The option's human title, for the breadcrumb. */
  optionTitle: string;
  /** The diagram visual to open. */
  visual: PlanVisual;
  /** Close the focused view and return to the compare grid. */
  onClose: () => void;
}

export function DecisionDiagramFocus({
  artifactId,
  optionId,
  optionTitle,
  visual,
  onClose,
}: DecisionDiagramFocusProps) {
  // A real dialog: focus moves in, Tab is trapped, Esc closes and focus
  // restores to the expand affordance that opened it (useModal contract).
  const { dialogProps } = useModal({ onClose });
  const diagramTitle = visual.title || "Architecture diagram";

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-auto"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label={`Comment on the ${optionTitle} option's ${diagramTitle}`}
        data-testid="decision-diagram-focus"
        className="relative w-full max-w-[920px] bg-surface-primary border border-border-default rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Breadcrumb: Decision ▸ Option: <name> ▸ <diagram> · Esc / back. */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle bg-surface-secondary text-xs text-text-muted">
          <span>Decision</span>
          <span aria-hidden="true" className="text-border-default">▸</span>
          <span>
            Option: <b className="text-text-secondary font-semibold">{optionTitle}</b>
          </span>
          <span aria-hidden="true" className="text-border-default">▸</span>
          <b className="text-text-secondary font-semibold truncate">{diagramTitle}</b>
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to compare diagrams"
            className="ml-auto shrink-0 text-2xs text-text-muted hover:text-text-primary border border-border-default rounded px-2 py-1 bg-surface-elevated transition-colors press-scale"
          >
            Esc · Back to compare
          </button>
        </div>

        {/* Stage — the diagram gets full width so the drag-select has room.
            VisualBody mounts WITHOUT readOnly, so the DiagramRegionLayer is
            live: drag a region, pick a node by keyboard, see existing region
            comments pinned + their threads, all through the shipped machinery. */}
        <div className="p-4 bg-surface-secondary max-h-[80vh] overflow-auto">
          <VisualBody artifactId={artifactId} visual={visual} optionId={optionId} />
          {visual.caption && (
            <div className="mt-2 text-2xs text-text-secondary leading-relaxed">{visual.caption}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
