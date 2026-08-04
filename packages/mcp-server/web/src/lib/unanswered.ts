/**
 * #192 — the unanswered-question predicate now lives in @deeppairing/shared so
 * the SERVER reuses the exact same tail-walk definition (first-call hint +
 * check_feedback carryover) instead of a second, drifting one. This module stays
 * as the web import path so ConversationRail, TurnIndicator, and App's badge
 * count are unchanged.
 */
export { isUnansweredQuestion, countUnansweredQuestions } from "@deeppairing/shared";
