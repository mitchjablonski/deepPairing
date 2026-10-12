/**
 * The line diff moved to @deeppairing/shared (#470 slice 3) so the CLI's
 * `stance allow` preview and the companion UI render the same diff. This
 * module keeps the old import path working.
 */
export { computeLineDiff, collapseDiff, type DiffLine, type DiffGap, type DiffRow } from "@deeppairing/shared";
