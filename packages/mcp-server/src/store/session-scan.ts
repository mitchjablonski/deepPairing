import fs from "node:fs";
import path from "node:path";
import type { Artifact, Retrospective, RetrospectiveVerdict } from "@deeppairing/shared";
import { nanoid } from "nanoid";
import { salvageArray } from "./salvage.js";
import { writeJsonAtomic } from "./atomic-write.js";
import type { DecisionRecord } from "./store-interface.js";

/**
 * Cross-session READ helpers — every function here walks
 * `.deeppairing/sessions/` on disk and never touches a live FileStore
 * instance. Extracted from file-store.ts; the FileStore statics
 * (listSessions/searchAll/findPastPredictions/addRetrospective) delegate
 * here so existing call sites stay byte-compatible.
 */

export function listSessions(projectRoot: string): Array<{
  id: string;
  createdAt: string;
  lastActivity: string;
  summary: string;
  artifactCount: number;
  hasDecisions: boolean;
}> {
  const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const sessions: Array<{
    id: string;
    createdAt: string;
    lastActivity: string;
    summary: string;
    artifactCount: number;
    hasDecisions: boolean;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const sessionDir = path.join(sessionsDir, entry.name);
    try {
      const artFile = path.join(sessionDir, "artifacts.json");
      if (!fs.existsSync(artFile)) continue;

      const artifacts: Artifact[] = salvageArray<Artifact>(
        `${entry.name}/artifacts.json`, JSON.parse(fs.readFileSync(artFile, "utf-8")), "id");
      if (artifacts.length === 0) continue;

      const decFile = path.join(sessionDir, "decisions.json");
      // D1 review — a null decisions.json threw here and the per-session
      // catch SKIPPED the whole (otherwise healthy) session from the list.
      const decRaw = fs.existsSync(decFile) ? JSON.parse(fs.readFileSync(decFile, "utf-8")) : [];
      const hasDecisions = Array.isArray(decRaw) && decRaw.length > 0;

      const sorted = [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const firstArtifact = sorted[0];
      const lastArtifact = sorted.at(-1);
      // Unreachable (length checked above) — skip like any other bad session.
      if (!firstArtifact || !lastArtifact) continue;

      sessions.push({
        id: entry.name,
        createdAt: firstArtifact.createdAt,
        lastActivity: lastArtifact.updatedAt ?? lastArtifact.createdAt,
        summary: firstArtifact.title,
        artifactCount: artifacts.length,
        hasDecisions,
      });
    } catch {
      // Skip corrupted sessions
    }
  }

  return sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

/**
 * Search every session in the project for artifacts matching a free-text query.
 * Scoring (simple, transparent):
 *   concept name match   × 3
 *   rejected-approach    × 2
 *   title match          × 2
 *   content match        × 1
 * Case-insensitive substring across all token positions. Capped at {@link limit}
 * results total so the UI stays fast on large projects.
 */
export function searchAll(
  projectRoot: string,
  query: string,
  limit = 50,
): Array<{
  sessionId: string;
  sessionTitle: string;
  artifactId: string;
  artifactType: string;
  title: string;
  excerpt: string;
  score: number;
  matchedVia: Array<"concept" | "title" | "content" | "rejected">;
}> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: Array<{
    sessionId: string;
    sessionTitle: string;
    artifactId: string;
    artifactType: string;
    title: string;
    excerpt: string;
    score: number;
    matchedVia: Array<"concept" | "title" | "content" | "rejected">;
  }> = [];

  const sessions = listSessions(projectRoot);
  for (const session of sessions) {
    const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
    const artFile = path.join(sessionDir, "artifacts.json");
    if (!fs.existsSync(artFile)) continue;
    let artifacts: Artifact[];
    try {
      artifacts = salvageArray(`${session.id}/artifacts.json`, JSON.parse(fs.readFileSync(artFile, "utf-8")), "id");
    } catch {
      continue;
    }

    // Pull rejected approaches from preferences.json for this project
    const prefsFile = path.join(projectRoot, ".deeppairing", "preferences.json");
    let rejected: Array<{ description?: string; concept?: string; reason?: string; sourceArtifactId?: string }> = [];
    try {
      if (fs.existsSync(prefsFile)) {
        const prefs = JSON.parse(fs.readFileSync(prefsFile, "utf-8"));
        const raw = prefs.rejectedApproaches ?? [];
        rejected = Array.isArray(raw)
          ? raw.map((r: any) => (typeof r === "string" ? { description: r } : r))
          : [];
      }
    } catch {}

    for (const artifact of artifacts) {
      const matchedVia = new Set<"concept" | "title" | "content" | "rejected">();
      let score = 0;

      // Title
      if (artifact.title && artifact.title.toLowerCase().includes(q)) {
        score += 2;
        matchedVia.add("title");
      }

      // Concept (reasoning artifacts)
      const concept = (artifact.content as any)?.concept;
      if (concept?.name && String(concept.name).toLowerCase().includes(q)) {
        score += 3;
        matchedVia.add("concept");
      }

      // Rejected approach tied to this artifact (or matching the query directly)
      for (const rej of rejected) {
        const matchesArtifact = rej.sourceArtifactId === artifact.id;
        const desc = (rej.description ?? "").toLowerCase();
        const reason = (rej.reason ?? "").toLowerCase();
        const conceptStr = (rej.concept ?? "").toLowerCase();
        const hit = desc.includes(q) || reason.includes(q) || conceptStr.includes(q);
        if (matchesArtifact && hit) {
          score += 2;
          matchedVia.add("rejected");
        }
      }

      // Content fallback — stringify and substring-check
      let contentBlob = "";
      try {
        contentBlob = JSON.stringify(artifact.content ?? {}).toLowerCase();
      } catch {}
      if (contentBlob.includes(q)) {
        score += 1;
        matchedVia.add("content");
      }

      if (score === 0) continue;

      // Excerpt: short context window around the first match in content/title
      const source = artifact.title + " — " + contentBlob;
      const idx = source.indexOf(q);
      const excerpt =
        idx >= 0
          ? source
              .slice(Math.max(0, idx - 40), idx + q.length + 80)
              .replace(/\s+/g, " ")
              .trim()
          : artifact.title;

      results.push({
        sessionId: session.id,
        sessionTitle: session.summary,
        artifactId: artifact.id,
        artifactType: artifact.type,
        title: artifact.title,
        excerpt,
        score,
        matchedVia: Array.from(matchedVia),
      });
    }
  }

  // Sort by score desc, then recency (session.lastActivity is already in
  // listSessions order; we preserve insertion order via stable sort).
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * N3.3: find the user's past predictions on similar past decisions.
 * Source: resolved decisions with a non-empty `response.predictedOutcome`
 * (captured by the companion UI on high-stakes decisions).
 *
 * Match is concept-token overlap between `query` and each past decision's
 * artifact title + context + chosen option text. We don't use exact match
 * because the phrasing of a decision evolves; we do cap at tokens ≥4 chars
 * to keep the signal-to-noise reasonable.
 */
export function findPastPredictions(
  projectRoot: string,
  query: string,
  opts: { excludeArtifactId?: string; limit?: number } = {},
): Array<{
  sessionId: string;
  sessionTitle?: string;
  artifactId: string;
  artifactTitle: string;
  context: string;
  decisionId: string;
  chosenOptionTitle: string;
  predictedOutcome: string;
  confidence?: "low" | "medium" | "high";
  resolvedAt: string;
  daysAgo: number;
  retrospective?: Retrospective;
}> {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return [];

  const limit = opts.limit ?? 3;
  const now = Date.now();

  const out: ReturnType<typeof findPastPredictions> = [];
  const sessions = listSessions(projectRoot);
  for (const session of sessions) {
    const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
    const artFile = path.join(sessionDir, "artifacts.json");
    const decFile = path.join(sessionDir, "decisions.json");
    if (!fs.existsSync(artFile) || !fs.existsSync(decFile)) continue;

    let artifacts: Artifact[];
    let decisions: DecisionRecord[];
    try {
      artifacts = salvageArray(`${session.id}/artifacts.json`, JSON.parse(fs.readFileSync(artFile, "utf-8")), "id");
      decisions = salvageArray(`${session.id}/decisions.json`, JSON.parse(fs.readFileSync(decFile, "utf-8")), "decisionId");
    } catch {
      continue;
    }

    for (const dec of decisions) {
      if (!dec.response?.predictedOutcome) continue;
      if (opts.excludeArtifactId && dec.artifactId === opts.excludeArtifactId) continue;
      const artifact = artifacts.find((a) => a.id === dec.artifactId);
      if (!artifact) continue;

      const haystack = (
        artifact.title + " " +
        (dec.context ?? "") + " " +
        ((dec.options ?? []).find((o: any) => o.id === dec.response!.optionId)?.title ?? "") + " " +
        ((dec.options ?? []).find((o: any) => o.id === dec.response!.optionId)?.description ?? "")
      ).toLowerCase();

      const hits = tokens.filter((t) => haystack.includes(t));
      // N3.3 — match on concept-token OVERLAP, not a majority of the (broad)
      // title+context query. The old `ceil(tokens.length / 2)` rule scaled
      // with query length, so a paraphrased decision that shared the real
      // concept but differed in wording almost never cleared the bar — the
      // calibration loop basically never fired. Require a fixed floor of
      // shared ≥4-char tokens instead (2, or the single token when that's all
      // the query has). Decisions that recorded a prediction are rare, so this
      // surfaces the relevant ones without flooding.
      const required = Math.min(2, tokens.length);
      if (hits.length < required) continue;

      const chosen = (dec.options ?? []).find((o: any) => o.id === dec.response!.optionId);
      const resolvedAt = dec.resolvedAt ?? dec.createdAt;
      const daysAgo = Math.max(0, Math.floor((now - new Date(resolvedAt).getTime()) / (24 * 60 * 60 * 1000)));

      // Hydrate any existing retrospective for this decision so the
      // breadcrumb can render the verdict alongside the prediction.
      const retrosPath = path.join(sessionDir, "retrospectives.json");
      let retrospective: Retrospective | undefined;
      try {
        if (fs.existsSync(retrosPath)) {
          const retros: Retrospective[] = salvageArray<Retrospective>(
            "retrospectives.json", JSON.parse(fs.readFileSync(retrosPath, "utf-8")), "decisionId");
          retrospective = retros.find((r) => r.decisionId === dec.decisionId);
        }
      } catch {}

      out.push({
        sessionId: session.id,
        sessionTitle: session.summary,
        artifactId: dec.artifactId,
        artifactTitle: artifact.title,
        context: dec.context ?? "",
        decisionId: dec.decisionId,
        chosenOptionTitle: chosen?.title ?? dec.response!.optionId,
        predictedOutcome: dec.response!.predictedOutcome,
        confidence: (dec.response as any).confidence,
        resolvedAt,
        daysAgo,
        retrospective,
      });
    }
  }

  // Newest first — the user likely remembers recent predictions better.
  return out.sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt)).slice(0, limit);
}

/**
 * P2 — write a retrospective for a decision that was made in some past
 * session. Walks sessions to find the one owning the decisionId; replaces
 * any existing retrospective for that decision (users can change their
 * minds as more evidence comes in).
 *
 * Returns the hydrated retrospective on success, or null if no session
 * owns the decisionId (caller should 404).
 */
export function addRetrospective(
  projectRoot: string,
  params: { decisionId: string; verdict: RetrospectiveVerdict; note?: string },
): { retrospective: Retrospective; sessionId: string } | null {
  const sessions = listSessions(projectRoot);
  for (const session of sessions) {
    const sessionDir = path.join(projectRoot, ".deeppairing", "sessions", session.id);
    const decFile = path.join(sessionDir, "decisions.json");
    if (!fs.existsSync(decFile)) continue;
    let decisions: DecisionRecord[];
    try {
      decisions = salvageArray(`${session.id}/decisions.json`, JSON.parse(fs.readFileSync(decFile, "utf-8")), "decisionId");
    } catch {
      continue;
    }
    if (!decisions.some((d) => d.decisionId === params.decisionId)) continue;

    const retrospective: Retrospective = {
      id: `retro_${nanoid(10)}`,
      decisionId: params.decisionId,
      verdict: params.verdict,
      note: params.note?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    const retrosPath = path.join(sessionDir, "retrospectives.json");
    let existing: Retrospective[] = [];
    try {
      if (fs.existsSync(retrosPath)) {
        existing = salvageArray("retrospectives.json (write path)", JSON.parse(fs.readFileSync(retrosPath, "utf-8")), "decisionId");
      }
    } catch {}
    const filtered = existing.filter((r) => r.decisionId !== params.decisionId);
    filtered.push(retrospective);
    writeJsonAtomic(retrosPath, filtered);

    return { retrospective, sessionId: session.id };
  }
  return null;
}
