/**
 * Simple line-level diff using longest common subsequence.
 * No external dependencies — works for typical code snippet sizes (< 500 lines).
 */

export interface DiffLine {
  type: "unchanged" | "added" | "removed";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/**
 * Compute a line-level diff between two strings.
 * Returns an array of DiffLine entries for rendering.
 */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    // `!` safe throughout: dp is (m+1)×(n+1) and i/j stay within the loop bounds.
    const row = dp[i]!;
    const prevRow = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        row[j] = prevRow[j - 1]! + 1;
      } else {
        row[j] = Math.max(prevRow[j]!, row[j - 1]!);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  // `!` safe throughout: each branch's guards keep i/j (and thus every index)
  // within array bounds — standard LCS backtrack invariants.
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "unchanged", content: oldLines[i - 1]!, oldLineNum: i, newLineNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ type: "added", content: newLines[j - 1]!, newLineNum: j });
      j--;
    } else {
      // Reaching here implies i > 0 (the j-branch above absorbs every i === 0 case).
      result.push({ type: "removed", content: oldLines[i - 1]!, oldLineNum: i });
      i--;
    }
  }

  return result.reverse();
}

/** A collapsed gap standing in for `count` consecutive unchanged lines. */
export interface DiffGap {
  type: "gap";
  count: number;
}

export type DiffRow = DiffLine | DiffGap;

/**
 * Collapse long runs of unchanged lines into gap markers, keeping `context`
 * lines around every change. Turns "the whole file again" into a focused diff
 * (changed hunks + a few lines of context) for incremental edits to a file the
 * user already approved. A run of unchanged lines is only collapsed when it is
 * longer than the context it would otherwise leave on both sides + 1, so we
 * never replace e.g. 2 lines with a "2 unchanged" marker that costs as much.
 */
export function collapseDiff(diff: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array(diff.length).fill(false);
  for (let i = 0; i < diff.length; i++) {
    if (diff[i]!.type !== "unchanged") { // `!` safe: i < diff.length loop bound
      const lo = Math.max(0, i - context);
      const hi = Math.min(diff.length - 1, i + context);
      for (let k = lo; k <= hi; k++) keep[k] = true;
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < diff.length) {
    if (keep[i]) {
      rows.push(diff[i]!); // `!` safe: i < diff.length loop bound
      i++;
      continue;
    }
    let j = i;
    while (j < diff.length && !keep[j]) j++;
    const count = j - i;
    // Collapsing 1 line saves nothing (the marker is itself a row).
    if (count <= 1) {
      for (let k = i; k < j; k++) rows.push(diff[k]!); // `!` safe: k < j <= diff.length
    } else {
      rows.push({ type: "gap", count });
    }
    i = j;
  }
  return rows;
}
