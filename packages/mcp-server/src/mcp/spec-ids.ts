/**
 * #589 — spec requirement and edge-path ids are the comment-anchor keys
 * (`requirementId`, `spec:edge-path:<id>`), so they must be unique, bounded and
 * unambiguous. WARN, don't reject: normalize deterministically and tell the
 * agent what changed, so a near-miss never costs a re-post.
 *
 * Order per id: truncate to MAX_SPEC_ID_LENGTH, (edge paths only) prefix a
 * purely numeric id with `ep-` so it can't collide with the legacy
 * `spec:edge-path:<index>` fallback, then suffix later duplicates `-2`, `-3`.
 * Unique, in-bounds, non-numeric ids pass through untouched (no warning), and
 * id-less edge paths stay id-less so legacy index anchors keep resolving.
 */
export const MAX_SPEC_ID_LENGTH = 64;

interface IdRow {
  id?: string;
}

function normalizeIds<T extends IdRow>(
  rows: readonly T[],
  label: string,
  prefixNumeric: boolean,
  notes: string[],
): T[] {
  // Every explicit id, so a generated suffix never steals a later explicit id.
  const reserved = new Set<string>();
  for (const r of rows) if (typeof r.id === "string" && r.id.length > 0) reserved.add(r.id);
  const used = new Set<string>();
  return rows.map((row, i) => {
    if (typeof row.id !== "string" || row.id.length === 0) return row;
    const original = row.id;
    let id = original;
    if (id.length > MAX_SPEC_ID_LENGTH) {
      id = id.slice(0, MAX_SPEC_ID_LENGTH);
      notes.push(`${label} #${i + 1} id truncated to ${MAX_SPEC_ID_LENGTH} chars ("${id}")`);
    }
    if (prefixNumeric && /^\d+$/.test(id)) {
      const prefixed = `ep-${id}`;
      notes.push(`${label} #${i + 1} id "${id}" is purely numeric (collides with the index fallback) — renamed "${prefixed}"`);
      id = prefixed;
    }
    if (used.has(id)) {
      let n = 2;
      let candidate: string;
      do {
        const suffix = `-${n++}`;
        candidate = `${id.slice(0, MAX_SPEC_ID_LENGTH - suffix.length)}${suffix}`;
      } while (used.has(candidate) || reserved.has(candidate));
      notes.push(`${label} #${i + 1} id "${id}" is a duplicate — renamed "${candidate}"`);
      id = candidate;
    }
    used.add(id);
    return id === original ? row : { ...row, id };
  });
}

export function normalizeSpecIds<R extends IdRow, E extends IdRow>(
  requirements: readonly R[],
  edgePaths: readonly E[] | undefined,
): { requirements: R[]; edgePaths: E[] | undefined; warning: string } {
  const notes: string[] = [];
  const reqs = normalizeIds(requirements, "requirement", false, notes);
  const eps = edgePaths ? normalizeIds(edgePaths, "edge path", true, notes) : undefined;
  const warning = notes.length > 0
    ? ` (spec ids adjusted so comments anchor unambiguously: ${notes.join("; ")}. Keep ids unique, non-numeric and <= ${MAX_SPEC_ID_LENGTH} chars in revisions.)`
    : "";
  return { requirements: reqs, edgePaths: eps, warning };
}
