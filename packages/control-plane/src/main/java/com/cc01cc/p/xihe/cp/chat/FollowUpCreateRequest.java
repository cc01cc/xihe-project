package com.cc01cc.p.xihe.cp.chat;

import java.util.List;
import java.util.Map;

/** Request fields snapshotted by a Session-scoped Follow-up QueueItem. */
public record FollowUpCreateRequest(
        String content,
        List<String> attachments,
        String branchId,
        String toolMode,
        Map<String, Integer> toolTimeouts,
        String provider,
        String model) {
}
