import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SessionBoundStore } from "../index.js";

const RichEvidenceSchema = z.object({
  filePath: z.string().describe("Path to the file"),
  lineStart: z.number().describe("Starting line number"),
  lineEnd: z.number().describe("Ending line number"),
  snippet: z.string().describe("The actual code at this location — copy the real lines"),
  context: z.string().optional().describe("Surrounding code for understanding"),
  language: z.string().optional().describe("Language (typescript, python, etc.)"),
  explanation: z.string().describe("WHY this code is relevant to the finding"),
  relatedPaths: z.array(z.string()).optional().describe("Other files where this pattern appears"),
});

export function createPresentFindingsTool(artifactStore: SessionBoundStore) {
  return tool(
    "deepPairing_present_findings",
    `Present your research findings with RICH evidence. The human needs to deeply understand each finding — not just a summary.

For each finding, provide:
- A short title and detailed explanation
- The ACTUAL CODE that demonstrates the issue (use the evidence array with snippets)
- WHY it matters (explanation on each evidence item)
- What IMPACT it has if not addressed
- What you RECOMMEND doing about it

BAD evidence: "auth.ts:5"
GOOD evidence: [{ filePath: "src/auth.ts", lineStart: 5, lineEnd: 8, snippet: "const hash = bcrypt.hash(pw, 10);", explanation: "Uses only 10 salt rounds. OWASP recommends 12+ or argon2id." }]`,
    {
      summary: z.string().describe("Brief summary of what you found"),
      findings: z.array(
        z.object({
          category: z.string().describe("Category (Security, Architecture, Performance, etc.)"),
          title: z.string().optional().describe("Short title for this finding"),
          detail: z.string().describe("Thorough explanation — not just what, but WHY it matters"),
          evidence: z.union([
            z.string().describe("Simple file reference (legacy — prefer rich evidence)"),
            z.array(RichEvidenceSchema).describe("Rich evidence with actual code snippets"),
          ]).describe("Evidence supporting this finding — include actual code"),
          significance: z.enum(["low", "medium", "high"]).describe("How important is this finding"),
          impact: z.string().optional().describe("What happens if this is not addressed"),
          recommendation: z.string().optional().describe("What should be done about this"),
        }),
      ).describe("List of findings — be thorough, include code"),
      openQuestions: z.array(z.string()).optional().describe("Questions that need human input"),
    },
    async (args) => {
      const artifact = await artifactStore.createArtifact({
        type: "research",
        title: "Research Findings",
        content: {
          summary: args.summary,
          findings: args.findings,
          openQuestions: args.openQuestions ?? [],
        },
      });

      const comments = await artifactStore.getUnacknowledgedComments();
      const commentContext = comments.length > 0
        ? `\n\nHuman feedback from earlier in this session:\n${comments.map((c) => `- ${c.content}`).join("\n")}`
        : "";

      if (comments.length > 0) {
        await artifactStore.acknowledgeComments(comments.map((c) => c.id));
      }

      return {
        content: [{
          type: "text" as const,
          text: `Findings presented to human (artifact: ${artifact.id}). They can now review and comment on each finding and its evidence.${commentContext}`,
        }],
      };
    },
  );
}
