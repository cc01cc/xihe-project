package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0660 T5.4 — the user-channel contract (`spec/session/user-channel.md` §4/§5).
 *
 * <p>Everything here is about the three things a naive SSE manager gets wrong: keeping **every** tab
 * of one user (no single-connection replacement — unlike Chat SSE), never leaking one user's hint
 * into another user's connection, and refusing the 9th connection **explicitly** rather than
 * dropping it silently.</p>
 */
class UserChannelSseManagerTest {

    private static final String USER_A = "user-a";
    private static final String USER_B = "user-b";

    /** Counts frames per emitter: {@code connected} on open, then one frame per hint. */
    private static final class CountingEmitter extends SseEmitter {
        private final AtomicInteger frames = new AtomicInteger();

        CountingEmitter() {
            super(0L);
        }

        @Override
        public void send(SseEventBuilder builder) throws IOException {
            frames.incrementAndGet();
        }

        int frames() {
            return frames.get();
        }
    }

    @Test
    void everyTabOfTheSameUserReceivesTheHint() {
        UserChannelSseManager manager = new UserChannelSseManager();
        CountingEmitter first = new CountingEmitter();
        CountingEmitter second = new CountingEmitter();
        manager.registerForTest(USER_A, first);
        manager.registerForTest(USER_A, second);
        assertEquals(1, first.frames(), "each connection gets the connected frame on open");
        assertEquals(1, second.frames());

        manager.participantNotified(USER_A, "session-1", "participant-1");

        assertEquals(2, manager.connectionCount(USER_A), "multi-tab: connections are NOT replaced");
        assertEquals(2, first.frames(), "the first tab must still receive the hint");
        assertEquals(2, second.frames(), "the second tab receives it too — both-must-receive is frozen");
    }

    @Test
    void aHintNeverLeaksToAnotherUser() {
        UserChannelSseManager manager = new UserChannelSseManager();
        CountingEmitter mine = new CountingEmitter();
        CountingEmitter other = new CountingEmitter();
        manager.registerForTest(USER_A, mine);
        manager.registerForTest(USER_B, other);

        manager.participantNotified(USER_A, "session-1", "participant-1");

        assertEquals(2, mine.frames(), "the addressee receives the hint");
        assertEquals(1, other.frames(), "another user's connection sees only its own connected frame");
    }

    @Test
    void theNinthConnectionIsRefusedExplicitly() {
        UserChannelSseManager manager = new UserChannelSseManager();
        for (int index = 0; index < UserChannelSseManager.MAX_SUBSCRIBERS_PER_USER; index++) {
            manager.registerForTest(USER_A, new CountingEmitter());
        }

        CpApiException refusal = assertThrows(CpApiException.class,
                () -> manager.registerForTest(USER_A, new CountingEmitter()));

        assertEquals("USER_CHANNEL_FULL", refusal.getCode(), "the cap is an explicit problem code");
        assertEquals(429, refusal.getStatus().value(), "and an explicit status, never a silent drop");
        assertEquals(UserChannelSseManager.MAX_SUBSCRIBERS_PER_USER, manager.connectionCount(USER_A));
    }

    @Test
    void theEventNamesAreTheClosedPublicSet() {
        assertEquals("connected", UserChannelSseManager.EVENT_CONNECTED);
        assertEquals("participant_notified", UserChannelSseManager.EVENT_PARTICIPANT_NOTIFIED);
        assertEquals("user_question", UserChannelSseManager.EVENT_USER_QUESTION);
        for (String name : new String[] {UserChannelSseManager.EVENT_CONNECTED,
                UserChannelSseManager.EVENT_PARTICIPANT_NOTIFIED,
                UserChannelSseManager.EVENT_USER_QUESTION}) {
            assertEquals(false, name.startsWith("wake_"),
                    "public wire names are intentionally NOT the internal wake_* names (D-102)");
        }
    }
}
