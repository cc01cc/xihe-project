package com.cc01cc.p.xihe.cp.chat;

/** Synchronous in-process handoff for a committed spawn Run. */
record SpawnRunDispatchRequestedEvent(String parentRunId, String childRunId) {
}
