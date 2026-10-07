package com.cc01cc.p.xihe.cp.chat;

/** In-process queue wakeup only; QueueItem rows remain durable truth. */
record FollowUpQueueWakeupEvent(String sessionId) {
}
