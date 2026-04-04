import type { AgentService } from "./agent-types.js";
import { FakeAgentService } from "./__fakes__/fake-agent.js";
import { ClaudeAgentService, type ClaudeAgentDeps } from "./claude-agent.js";

export function createAgentService(deps?: ClaudeAgentDeps): AgentService {
  if (process.env.USE_FAKE_AGENT === "true") {
    console.log("[deepPairing] Using fake agent service (USE_FAKE_AGENT=true)");
    return new FakeAgentService();
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[deepPairing] WARNING: No ANTHROPIC_API_KEY found.\n" +
      "  deepPairing requires an Anthropic API key for the full collaboration experience.\n" +
      "  Get one at: https://console.anthropic.com/settings/keys\n" +
      "  Falling back to fake agent for development.\n" +
      "  Set USE_FAKE_AGENT=true to silence this warning.",
    );
    return new FakeAgentService();
  }

  if (!deps) {
    console.warn("[deepPairing] No dependencies provided for ClaudeAgentService, using fake");
    return new FakeAgentService();
  }

  console.log("[deepPairing] Using Claude Agent SDK with collaboration tools");
  return new ClaudeAgentService(deps);
}
