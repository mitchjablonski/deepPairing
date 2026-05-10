import { getGlobalStore } from "../../store/global-store.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * CC10 — extracted from server.ts case "recall". server.ts had grown to
 * 1,512 LOC; this handler was the largest single in-line block (~190
 * LOC). The dispatcher now stays a thin switch that delegates to the
 * tools/* directory, matching the present-*.ts split. No behavior
 * change — the four mode branches (ledger, philosophy, sessions, any)
 * and their text-formatting paths are byte-identical.
 *
 * Entry-point contract (from server.ts:tools list):
 *   - args.query: string  — free-text query
 *   - args.mode:  "philosophy" | "sessions" | "ledger" | "any" (default "any")
 *   - args.stance: "avoid" | "prefer" | "mixed" — only for mode="philosophy"
 *   - args.limit: number — capped to [1, 100], default 20
 */
export async function handleRecall(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store } = ctx;
  const query = String(args?.query ?? "").trim();
  const mode = (args?.mode ?? "any") as "philosophy" | "sessions" | "ledger" | "any";
  const stanceFilter = typeof args?.stance === "string" ? args.stance : undefined;
  // DD5 — `source` filter for mode='philosophy'. Lets the agent ask
  // "show me what the user explicitly seeded" or "show me what came
  // purely from sessions" without grepping prose. Validated against
  // the same enum the inputSchema declares.
  const sourceFilter =
    args?.source === "user-seeded" || args?.source === "session"
      ? (args.source as "user-seeded" | "session")
      : undefined;
  const limit = Math.min(
    Math.max(typeof args?.limit === "number" ? args.limit : 20, 1),
    100,
  );

  // --- Philosophy branch ---
  const runPhilosophy = async () => {
    const concept = query || undefined;
    const entries = getGlobalStore().query({
      concept,
      stance: stanceFilter as "avoid" | "prefer" | "mixed" | undefined,
      source: sourceFilter,
      limit,
    });
    return entries;
  };

  // --- Sessions branch ---
  const runSessions = async () => {
    if (!query) return [];
    // AA7b — typed optional method.
    return (await store.searchSessions?.(query, limit)) ?? [];
  };

  // BB4 — agent-facing moat surface. Same shape as /api/ledger/digest
  // (the YourTaste drawer). Lets the agent open with "your ledger
  // has shaped N proposals, top stances are X, Y, Z" before doing
  // anything else. Cursor 3 / Claude Code auto-memory structurally
  // can't ship this — they don't store rejection reasoning as
  // first-class objects.
  if (mode === "ledger") {
    if (typeof store.getLedgerDigest !== "function") {
      return {
        content: [{ type: "text", text: "recall with mode='ledger' requires a project-bound store (not available here)." }],
        isError: true,
      };
    }
    const digest = await store.getLedgerDigest();
    // CC8 — surface user-seeded stances even when shapedThisProject===0.
    // Pre-CC8 the agent saw "Ledger is empty" until at least one
    // preflight cited a stance, so a fresh project where the user
    // had pasted rules into the SeedAffordance got NO acknowledgement
    // from the agent — the seed action was invisible to the AI for
    // the entire first session. Now we query the global ledger for
    // entries that originated from a manual seed (project="manual"
    // markers) and surface them as a "User has seeded:" list.
    const allLedger = getGlobalStore().query({ limit: 200 });
    const seededStances = allLedger
      .filter((e) => e.instances.some((i) => i.project === "manual"))
      .map((e) => ({
        concept: e.concept,
        stance: e.stance,
        citedTimesElsewhere: e.instances.filter((i) => i.project !== "manual").length,
      }));
    const ledgerIsEmpty =
      digest.shapedThisProject === 0 &&
      digest.globalLedger.concepts === 0 &&
      seededStances.length === 0;
    if (ledgerIsEmpty) {
      return {
        content: [{
          type: "text",
          text: "Ledger is empty. The user hasn't accumulated cross-project stances yet — pair with them on rejected/approved approaches and the ledger will start filling in.",
        }],
      };
    }
    const top = digest.topCitedStances.slice(0, 8).map((s) => {
      const tag = s.source === "team" ? "TEAM" : "self";
      return `- [${tag}] "${s.concept}" — cited ${s.citationCount}× (sample: ${s.sampleArtifactId ?? "—"})`;
    });
    const seededLines = seededStances.slice(0, 12).map((s) => {
      const elsewhere = s.citedTimesElsewhere > 0
        ? ` (also cited ${s.citedTimesElsewhere}× in real sessions)`
        : "";
      return `- [SEED] "${s.concept}" — ${s.stance.toUpperCase()}${elsewhere}`;
    });
    const headline =
      `Project: shaped ${digest.shapedThisProject} proposal${digest.shapedThisProject === 1 ? "" : "s"}` +
      ` across ${digest.sessionsTouched} session${digest.sessionsTouched === 1 ? "" : "s"}` +
      ` — ${digest.nearMissesThisProject} near-miss${digest.nearMissesThisProject === 1 ? "" : "es"} caught, ${digest.blockedThisProject} blocked.`;
    const cross =
      `Cross-project ledger: ${digest.globalLedger.concepts} concept${digest.globalLedger.concepts === 1 ? "" : "s"}` +
      ` across ${digest.globalLedger.projects} project${digest.globalLedger.projects === 1 ? "" : "s"}` +
      (digest.globalLedger.multiProjectConcepts > 0 ? ` (${digest.globalLedger.multiProjectConcepts} multi-project)` : "") +
      ".";
    const seededSection = seededLines.length
      ? `\n\nUser-seeded stances (weight these as direct user policy):\n${seededLines.join("\n")}`
      : "";
    return {
      content: [{
        type: "text",
        text: `${headline}\n${cross}${top.length ? `\n\nTop cited stances:\n${top.join("\n")}` : ""}${seededSection}\n\nRespect these stances — especially TEAM-source, high-citation, and SEED entries — when shaping new proposals.`,
      }],
    };
  }

  if (mode === "philosophy") {
    const entries = await runPhilosophy();
    if (entries.length === 0) {
      return {
        content: [{
          type: "text",
          text: query
            ? `No philosophy-ledger entries match "${query}" yet. The user hasn't expressed a cross-project stance on this concept.`
            : "The philosophy ledger is empty. It builds as the user approves / rejects concepts across sessions.",
        }],
      };
    }
    const formatted = entries.slice(0, 10).map((e) => {
      const rejections = e.instances.filter((i) => i.verdict === "rejected").length;
      const approvals = e.instances.filter((i) => i.verdict === "approved").length;
      const projects = new Set(e.instances.map((i) => i.project)).size;
      const latestReason = [...e.instances].reverse().find((i) => i.reason)?.reason;
      const reasonLine = latestReason ? `\n    latest reason: "${latestReason}"` : "";
      return `- [${e.stance.toUpperCase()}] "${e.concept}" — ${rejections} reject${rejections !== 1 ? "s" : ""}, ${approvals} approval${approvals !== 1 ? "s" : ""} across ${projects} project${projects !== 1 ? "s" : ""}${reasonLine}`;
    });
    const trailer = entries.length > 10 ? `\n…${entries.length - 10} more entries.` : "";
    return {
      content: [{
        type: "text",
        text: `Philosophy ledger (${entries.length} match${entries.length === 1 ? "" : "es"}${query ? ` for "${query}"` : ""}):\n${formatted.join("\n")}${trailer}\n\nWeight these strongly — especially 'avoid' stances with multi-project support.`,
      }],
    };
  }

  if (mode === "sessions") {
    if (!query) {
      return {
        content: [{ type: "text", text: "recall with mode='sessions' requires a query." }],
        isError: true,
      };
    }
    if (typeof store.searchSessions !== "function") {
      return {
        content: [{ type: "text", text: "recall with mode='sessions' requires the daemon store (not available here)." }],
        isError: true,
      };
    }
    const results = await runSessions();
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No past-session matches for "${query}".` }],
      };
    }
    const lines = results.slice(0, 20).map((r: any) => {
      const via = r.matchedVia?.length ? ` (via ${r.matchedVia.join(", ")})` : "";
      return `- [${r.sessionId}/${r.artifactId}] ${r.artifactType}: "${r.title}"${via}\n    ${r.excerpt}`;
    });
    const trailer = results.length > 20 ? `\n…${results.length - 20} more results.` : "";
    return {
      content: [{
        type: "text",
        text: `Found ${results.length} match${results.length === 1 ? "" : "es"} for "${query}":\n${lines.join("\n")}${trailer}\n\nRead a full session via resource deeppairing://session/{id} or an artifact via deeppairing://artifact/{id}.`,
      }],
    };
  }

  // mode === "any" — union with philosophy first.
  if (!query) {
    return {
      content: [{ type: "text", text: "recall with mode='any' requires a query (or use mode='philosophy' with no query to list the ledger)." }],
      isError: true,
    };
  }
  const halfLimit = Math.max(5, Math.floor(limit / 2));
  const philosophyHits = getGlobalStore().query({ concept: query, limit: halfLimit });
  const sessionHits = await runSessions();

  if (philosophyHits.length === 0 && sessionHits.length === 0) {
    return {
      content: [{ type: "text", text: `No deepPairing memory matches "${query}".` }],
    };
  }

  const lines: string[] = [];
  if (philosophyHits.length > 0) {
    lines.push(`## Philosophy ledger (cross-project stances)`);
    for (const e of philosophyHits) {
      const latestReason = [...e.instances].reverse().find((i) => i.reason)?.reason;
      lines.push(`- [${e.stance.toUpperCase()}] "${e.concept}" × ${e.instances.length}${latestReason ? ` — "${latestReason}"` : ""}`);
    }
  }
  if (sessionHits.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`## Session artifacts (this project)`);
    for (const h of sessionHits.slice(0, 10)) {
      lines.push(`- ${h.artifactType}: "${h.title}" [${h.sessionId}]`);
    }
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
