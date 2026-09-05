/**
 * A session id is not an operation identity: A -> B -> A makes an old A
 * response look current again. Every navigation/recovery therefore receives a
 * monotonic token, shared by connection and replay code.
 */
export interface SessionTransitionToken {
  generation: number;
  sessionId: string | null;
}

let generation = 0;

export function beginSessionTransition(sessionId: string | null): SessionTransitionToken {
  return { generation: ++generation, sessionId };
}

export function isCurrentSessionTransition(token: SessionTransitionToken): boolean {
  return token.generation === generation;
}
