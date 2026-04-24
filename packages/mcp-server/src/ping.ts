/**
 * R4 — opt-in anonymous install-health ping.
 *
 * Disabled by default. Flip `DEEPPAIRING_PING=1` AND set
 * `DEEPPAIRING_PING_URL` to enable. Both guards required — so nobody
 * accidentally phones home because we shipped a default endpoint.
 *
 * Payload is deliberately aggregate: no projectRoot, no session/artifact
 * content, no identifiers. Answers the "did the install actually work?"
 * question from Anthropic's 2026 Agentic Coding Trends Report without
 * giving up anything we'd cringe to have leaked.
 */

export interface PingPayload {
  version: string;
  event: "daemon_startup";
  skillLikelyLoaded: boolean;
  recentArtifactActivity: boolean;
  platform: NodeJS.Platform;
  nodeMajor: number;
  at: string;
}

export interface PingContext {
  version: string;
  skillLikelyLoaded: boolean;
  recentArtifactActivity: boolean;
}

export function buildPingPayload(ctx: PingContext): PingPayload {
  const nodeMajor = Number((process.versions.node ?? "0").split(".")[0]) || 0;
  return {
    version: ctx.version,
    event: "daemon_startup",
    skillLikelyLoaded: ctx.skillLikelyLoaded,
    recentArtifactActivity: ctx.recentArtifactActivity,
    platform: process.platform,
    nodeMajor,
    at: new Date().toISOString(),
  };
}

export interface PingDecision {
  shouldSend: boolean;
  url?: string;
  reason: string;
}

export function decidePing(env: NodeJS.ProcessEnv): PingDecision {
  const pingFlag = env.DEEPPAIRING_PING;
  const urlFlag = env.DEEPPAIRING_PING_URL;
  if (pingFlag !== "1" && pingFlag !== "true" && pingFlag !== "yes") {
    return { shouldSend: false, reason: "DEEPPAIRING_PING is not set to 1/true/yes" };
  }
  if (!urlFlag) {
    return { shouldSend: false, reason: "DEEPPAIRING_PING is set but DEEPPAIRING_PING_URL is not — refusing to send to a default endpoint" };
  }
  try {
    const u = new URL(urlFlag);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { shouldSend: false, reason: `DEEPPAIRING_PING_URL protocol ${u.protocol} not supported` };
    }
  } catch {
    return { shouldSend: false, reason: `DEEPPAIRING_PING_URL is not a valid URL` };
  }
  return { shouldSend: true, url: urlFlag, reason: "opted in via DEEPPAIRING_PING + DEEPPAIRING_PING_URL" };
}

/**
 * Fire-and-forget POST. Never throws; a failed ping must never affect the
 * daemon. 5s timeout so a hung endpoint doesn't keep the process alive.
 */
export async function sendPing(url: string, payload: PingPayload): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
