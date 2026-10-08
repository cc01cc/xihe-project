package com.cc01cc.p.xihe.cp.chat;

/** In-process wakeup detail. Durable ChatRun/QueueItem rows remain authoritative. */
record ChatRunTerminalizedEvent(String sessionId, String runId, String status, String terminalOutcome) {
}
