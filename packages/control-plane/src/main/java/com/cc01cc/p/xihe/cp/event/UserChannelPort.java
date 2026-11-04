package com.cc01cc.p.xihe.cp.event;

/**
 * PLAN-0660 T5.4/T5.5 — the narrow seam the notification domain uses to reach a **user's** channel.
 *
 * <p>Deliberately a port, following {@code CompactionNoticePort}: the wake/dispatch code may only say
 * "this participant was notified" / "this question changed state" and knows nothing about SSE
 * plumbing. Implementations are fire-and-forget — a delivery failure is logged there and never thrown
 * back into the dispatch path (a push is a hint, not a fact; the durable record is the fact).</p>
 *
 * <p>The payloads are frozen by {@code spec/session/user-channel.md} §4: hints carry **no counts, no
 * body text** — only identifiers the UI reloads from.</p>
 */
public interface UserChannelPort {

    /** Hint: {@code participant_notified} — {@code {sessionId, participantId}} only. */
    void participantNotified(String userId, String sessionId, String participantId);

    /** Hint: {@code user_question} — {@code {questionId, sessionId, state}} only. */
    void questionChanged(String userId, String questionId, String sessionId, String state);
}
