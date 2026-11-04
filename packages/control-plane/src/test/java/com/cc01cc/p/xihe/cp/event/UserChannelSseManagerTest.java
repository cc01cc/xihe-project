package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0660 T5.4 / T5.5 — the user-channel contract (`spec/session/user-channel.md` §4/§5).
 *
 * <p>Three things a naive SSE manager gets wrong are pinned here: keeping <b>every</b> tab of one user
 * (no single-connection replacement — unlike Chat SSE), never leaking one user's hint into another
 * user's connection, and refusing the 9th connection <b>explicitly</b> rather than dropping it
 * silently. Plus the hint whitelist: payload keys are asserted as a <b>subset</b> of the frozen keys,
 * so a future "just add the count/body to the hint" change fails here instead of leaking onto the wire.</p>
 */
class UserChannelSseManagerTest {

    private static final String USER_A = "user-a";
    private static final String USER_B = "user-b";
    private static final Set<String> NOTIFIED_HINT_KEYS = Set.of("sessionId", "participantId");
    private static final Set<String> QUESTION_HINT_KEYS = Set.of("questionId", "sessionId", "state");

    /** Counts frames per emitter and remembers the payload key sets it was handed. */
    private static final class CountingEmitter extends SseEmitter {
        private final AtomicInteger frames = new AtomicInteger();
        private final List<Map<?, ?>> payloads = new ArrayList<>();

        CountingEmitter() {
            super(0L);
        }

        @Override
        public void send(SseEventBuilder builder) throws IOException {
            frames.incrementAndGet();
            builder.build().forEach(data -> {
                if (data.getData() instanceof Map<?, ?> map) {
                    payloads.add(map);
                }
            });
        }

        int frames() {
            return frames.get();
        }

        List<Map<?, ?>> payloads() {
            return payloads;
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
            assertTrue(!name.startsWith("wake_"),
                    "public wire names are intentionally NOT the internal wake_* names (D-102)");
        }
    }

    @Test
    void theNotifiedHintCarriesOnlyTheTwoFrozenKeys() {
        UserChannelSseManager manager = new UserChannelSseManager();
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, tab);

        manager.participantNotified(USER_A, "session-1", "participant-1");

        Map<?, ?> hint = tab.payloads().stream()
                .filter(payload -> payload.containsKey("participantId"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("the participant_notified hint was not pushed"));
        assertTrue(NOTIFIED_HINT_KEYS.containsAll(hint.keySet()),
                "hint keys must be a SUBSET of {sessionId, participantId}; got " + hint.keySet());
        assertEquals(NOTIFIED_HINT_KEYS, hint.keySet(), "and carry both identifiers, nothing else");
    }

    @Test
    void theQuestionHintCarriesOnlyTheThreeFrozenKeys() {
        UserChannelSseManager manager = new UserChannelSseManager();
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, tab);

        manager.questionChanged(USER_A, "question-1", "session-1", "pending");

        Map<?, ?> hint = tab.payloads().stream()
                .filter(payload -> payload.containsKey("questionId"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("the user_question hint was not pushed"));
        assertTrue(QUESTION_HINT_KEYS.containsAll(hint.keySet()),
                "hint keys must be a SUBSET of {questionId, sessionId, state}; got " + hint.keySet());
        assertEquals(QUESTION_HINT_KEYS, hint.keySet());
    }
}
