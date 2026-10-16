package com.cc01cc.p.xihe.cp.chat;

/** Handoff for a committed continuation Run; dispatch is performed after commit. */
record ContinuationRunDispatchRequestedEvent(String sourceRunId, String continuationRunId,
                                             java.util.List<String> completedToolCallIds) {
    ContinuationRunDispatchRequestedEvent {
        completedToolCallIds = completedToolCallIds == null ? java.util.List.of()
                : java.util.List.copyOf(completedToolCallIds);
    }
}
