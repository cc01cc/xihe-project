package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.UserQuestion;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0660 M5-B / T5.10: the wire projection of one question.
 *
 * <p>One shape for every reader (addressee and session-visible reader alike): the design freezes
 * "会话可见者可读**投影**" (PLAN-0648 design.md §5.2) and {@code spec/session/user-channel.md} §6
 * freezes the row it projects — there is no field-level redaction to invent. The <b>only</b>
 * difference between the two readers is the right to answer (addressee only); the answer body itself
 * is session content, exactly like a message.
 *
 * <p>Wire names are camelCase; {@code settledAt} is the frozen {@code settled_at} stamp, i.e. the
 * "answered at" instant for an answered question (no extra column, no derived field).
 */
public final class UserQuestionViews {

    private UserQuestionViews() {
    }

    public record UserQuestionView(
            UUID id,
            UUID sessionId,
            UUID runId,
            String state,
            String prompt,
            String answer,
            Instant expiresAt,
            Instant createdAt,
            Instant firstDeliveredAt,
            Instant settledAt) {
    }

    /** {@code GET /api/v1/user-questions} body: the items and the count of <b>the same filter</b>. */
    public record UserQuestionListResponse(List<UserQuestionView> items, long pendingCount) {
    }

    public static UserQuestionView toView(UserQuestion row) {
        return new UserQuestionView(row.getId(), row.getSessionId(), row.getRunId(), row.getState(),
                row.getPrompt(), row.getAnswer(), row.getExpiresAt(), row.getCreatedAt(),
                row.getFirstDeliveredAt(), row.getSettledAt());
    }

    public static List<UserQuestionView> toViews(List<UserQuestion> rows) {
        return rows.stream().map(UserQuestionViews::toView).toList();
    }
}
