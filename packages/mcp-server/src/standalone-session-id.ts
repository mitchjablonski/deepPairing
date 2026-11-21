import { randomUUID } from "node:crypto";
import { projectHashOf } from "./project-root.js";

const REVIEW_SESSION = /^review_[0-9a-f]{8}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const prefixFor = (projectRoot: string) => `review_${projectHashOf(projectRoot)}_`;

export function createStandaloneSessionId(projectRoot: string): string {
  return prefixFor(projectRoot) + randomUUID();
}

export function isStandaloneSessionId(id: string): boolean {
  return REVIEW_SESSION.test(id);
}

export function isStandaloneSessionForProject(id: string, projectRoot: string): boolean {
  return isStandaloneSessionId(id) && id.startsWith(prefixFor(projectRoot));
}
