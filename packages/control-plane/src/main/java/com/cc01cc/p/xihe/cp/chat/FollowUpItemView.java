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
        Instant updatedAt,
        /**
         * task-188 S3 (V173): who put this item here — {@code null} (NO attribution: every
         * pre-V173 row and every ordinary human follow-up) | {@code human} | {@code agent_steer}
         * (the Lead's mid-run 指挥插话). The UI renders a "来自 Lead" badge only for
         * {@code agent_steer}; it must never substitute a default for null (a fabricated "human"
         * would attribute rows nobody attributed), so this stays a plain nullable string the
         * client compares literally.
         */
        String sourceKind,
        /** The steering Session for {@code agent_steer} rows; null otherwise. */
        UUID fromSessionId,
        /**
         * ADVISORY-ONLY echo (D-1830): the board revision the steering Lead assumed, persisted on
         * the row purely so a reader can see what the interjection was written against. Nothing
         * gates on it — the queue has no revision and this endpoint performs no CAS.
         */
        Integer expectedRevision) {
}