package com.cc01cc.p.xihe.cp.chat;

import java.util.List;

/** Durable Session queue projection; item rows remain the source of truth. */
public record FollowUpQueueSnapshot(
        String sessionId,
        String queueState,
        long outstandingCount,
        int capacityLimit,
        String pauseReason,
        List<FollowUpItemView> items) {
}
