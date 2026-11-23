import { isClosedArtifactStatus, type Artifact } from "@deeppairing/shared";

/** Follow the same page lineage for presentation replay and feedback reads. */
export function findPageSuccessor(backing: Artifact, artifacts: readonly Artifact[]): Artifact | undefined {
  const rank = (a: Artifact) => [isClosedArtifactStatus(a.status) ? 0 : 1, a.version ?? 0, Date.parse(a.createdAt ?? "") || 0];
  const newer = (a: Artifact, b: Artifact) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
    return false;
  };
  let latest = backing;
  const seen = new Set<string>([backing.id]);
  while (true) {
    // A fork: prefer a live child, then the highest version, then the newest.
    const next = artifacts.reduce<Artifact | undefined>((best, a) =>
      a.type === "page" && a.sessionId === backing.sessionId && a.parentId === latest.id && !seen.has(a.id) &&
      (!best || newer(a, best)) ? a : best, undefined);
    if (!next) return latest === backing ? undefined : latest;
    seen.add(next.id);
    latest = next;
  }
}
