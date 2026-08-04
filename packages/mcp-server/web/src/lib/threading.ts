/**
 * #192 — thread grouping now lives in @deeppairing/shared so the SERVER reuses
 * the exact same definition (the unanswered-question queue). This module stays
 * as the web import path so every ConversationRail/TurnIndicator/etc. import is
 * unchanged; the implementation is shared.
 */
export { threadRootId, buildThreads, type Thread } from "@deeppairing/shared";
