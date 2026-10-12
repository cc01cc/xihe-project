package com.cc01cc.p.xihe.cp.chat;

/** Synchronous in-process handoff for a committed scheduled wakeup Run (PLAN-0489 决策 #7). */
record ScheduledRunDispatchRequestedEvent(String sessionId, String runId) {
}
