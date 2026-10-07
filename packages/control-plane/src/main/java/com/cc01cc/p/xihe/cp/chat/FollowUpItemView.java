package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Owner-scoped view of one outstanding or terminal Follow-up item. */
public record FollowUpItemView(
        UUID queueItemId,
        long queueSequence,
        String status,
        String content,
        List<AttachmentInfo> attachments,
        UUID branchId,
        UUID anchorRunId,
        String pauseReason,
        UUID childRunId,
        UUID childMessageId,
        Instant createdAt,
        Instant updatedAt) {
}
