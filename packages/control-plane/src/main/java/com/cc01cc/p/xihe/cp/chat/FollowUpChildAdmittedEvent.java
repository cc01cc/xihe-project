package com.cc01cc.p.xihe.cp.chat;

import java.util.UUID;
import java.util.Map;

/** Signals that an admitted child ChatRun is durable and may be handed to the existing Agent worker. */
record FollowUpChildAdmittedEvent(String sessionId, UUID queueItemId, String childRunId,
                                  Map<String, Integer> toolTimeouts) {
    FollowUpChildAdmittedEvent {
        toolTimeouts = toolTimeouts == null ? Map.of() : Map.copyOf(toolTimeouts);
    }
}
