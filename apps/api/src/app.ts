import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createDecisionRoutes } from "./routes/decisions.js";
import { createForkRoutes } from "./routes/forks.js";
import { createArtifactRoutes } from "./routes/artifacts.js";
import { createCommentRoutes } from "./routes/comments.js";
import { createAgentService } from "./services/agent-factory.js";
import { SessionStore } from "./services/session-store.js";
import { DecisionManager } from "./services/decision-manager.js";
import { ReasoningTracker } from "./services/reasoning-tracker.js";
import { ForkManager } from "./services/fork-manager.js";
import { GitWorktreeManager } from "./services/worktree-manager.js";
import { ArtifactStore } from "./services/artifact-store.js";
import {
  FakeArtifactRepository,
  FakeCommentRepository,
} from "./repositories/__fakes__/fake-repositories.js";
import type { PlanReviewResult } from "@deeppairing/mcp-server";

// Repositories (fake for now, swap for Neon when DATABASE_URL is set)
const artifactRepo = new FakeArtifactRepository();
const commentRepo = new FakeCommentRepository();

// Services
const sessionStore = new SessionStore();
const decisionManager = new DecisionManager();
const reasoningTracker = new ReasoningTracker();
const artifactStore = new ArtifactStore(artifactRepo, commentRepo);
const worktreeManager = new GitWorktreeManager();

// Plan review callback — blocks via a deferred promise, resolved by HTTP endpoint
const pendingPlanReviews = new Map<
  string,
  { resolve: (result: PlanReviewResult) => void }
>();

function onPlanReview(artifactId: string): Promise<PlanReviewResult> {
  return new Promise<PlanReviewResult>((resolve) => {
    pendingPlanReviews.set(artifactId, { resolve });
  });
}

// Agent service (uses fake when no API key, real when key present)
const agentService = createAgentService({
  artifactStore,
  decisionManager,
  onPlanReview,
  reasoningTracker,
});

const forkManager = new ForkManager(agentService, worktreeManager);

// Hono app
export const app = new Hono();

app.use("/*", cors());

app.route("/", healthRoute);
app.route("/", createSessionRoutes(agentService, sessionStore));
app.route("/", createDecisionRoutes(decisionManager, sessionStore));
app.route("/", createForkRoutes(forkManager, sessionStore));
app.route("/", createArtifactRoutes(artifactStore, pendingPlanReviews, sessionStore));
app.route("/", createCommentRoutes(artifactStore));

// Export for testing and route access
export {
  agentService,
  sessionStore,
  decisionManager,
  reasoningTracker,
  artifactStore,
  forkManager,
  pendingPlanReviews,
};
