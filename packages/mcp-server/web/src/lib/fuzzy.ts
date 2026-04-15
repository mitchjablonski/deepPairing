/**
 * Simple fuzzy match scoring.
 * Returns a score >= 0 (higher is better) or -1 for no match.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length === 0) return 0;

  let score = 0;
  let qi = 0;
  let consecutive = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1 + consecutive * 2; // Bonus for consecutive matches
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === "_") {
        score += 5; // Bonus for word boundary match
      }
      consecutive++;
      qi++;
    } else {
      consecutive = 0;
    }
  }

  return qi === q.length ? score : -1;
}
