package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-306: a session holds multiple SSE connections; different connection instances coexist and
 * only the same instance is replaced. The legacy single-entry semantics are gone by default.
 */
class SseEmitterManagerTest {

    private final SseEmitterManager manager = new SseEmitterManager();

    @AfterEach
    void tearDown() {
        manager.complete("session-1");
        manager.complete("session-2");
    }

    @Test
    void createEmitter_registersEmitter() {
        var emitter = manager.createEmitter("session-1");
        assertNotNull(emitter);
        assertTrue(manager.hasEmitter("session-1"));
        assertEquals(1, manager.activeConnectionCount("session-1"));
    }

    @Test
    void differentConnectionInstancesCoexist() {
        var first = manager.createEmitter("session-1", null, "tab-a");
        var second = manager.createEmitter("session-1", null, "tab-b");

        assertNotSame(first, second);
        assertEquals(2, manager.activeConnectionCount("session-1"));
        assertTrue(manager.hasEmitter("session-1"));
    }

    @Test
    void serverGeneratedConnectionInstancesCoexistWithoutClientId() {
        var first = manager.createEmitter("session-1");
        var second = manager.createEmitter("session-1");

        assertNotSame(first, second);
        assertEquals(2, manager.activeConnectionCount("session-1"));
    }

    @Test
    void sameConnectionInstanceIsReplaced() {
        var first = manager.createEmitter("session-1", null, "tab-a");
        var second = manager.createEmitter("session-1", null, "tab-a");

        assertNotSame(first, second);
        assertEquals(1, manager.activeConnectionCount("session-1"));
        first.complete();
        assertEquals(1, manager.activeConnectionCount("session-1"),
                "a replaced emitter completion must not remove the new entry");
    }

    @Test
    void completingOneConnectionDoesNotCompleteOtherConnections() {
        var first = manager.createEmitter("session-1", null, "tab-a");
        var second = manager.createEmitter("session-1", null, "tab-b");

        assertTrue(manager.complete("session-1", first));
        assertEquals(1, manager.activeConnectionCount("session-1"));
        assertFalse(manager.complete("session-1", first),
                "completing the same connection twice is a no-op");
        assertTrue(manager.complete("session-1", second));
        assertEquals(0, manager.activeConnectionCount("session-1"));
        assertFalse(manager.hasEmitter("session-1"));
    }

    @Test
    void connectionGenerationIncrementsPerSession() {
        manager.createEmitter("session-1", null, "tab-a");
        assertEquals(1L, manager.connectionGeneration("session-1"));
        manager.createEmitter("session-1", null, "tab-b");
        assertEquals(2L, manager.connectionGeneration("session-1"));
    }

    @Test
    void complete_removesAllConnections() {
        manager.createEmitter("session-1", null, "tab-a");
        manager.createEmitter("session-1", null, "tab-b");
        manager.complete("session-1");
        assertFalse(manager.hasEmitter("session-1"));
        assertEquals(0, manager.activeConnectionCount("session-1"));
    }

    @Test
    void complete_noEmitter_doesNotThrow() {
        manager.complete("nonexistent");
        assertFalse(manager.hasEmitter("nonexistent"));
    }

    @Test
    void send_noEmitter_doesNotThrow() {
        assertFalse(manager.send("nonexistent", "test", "data"));
    }

    @Test
    void hasEmitter_returnsFalseForUnknown() {
        assertFalse(manager.hasEmitter("unknown"));
    }

    @Test
    void connectionLimitReturnsExplicit409InsteadOfSilentlyEvicting() {
        List<Object> emitters = new ArrayList<>();
        for (int index = 0; index < 8; index += 1) {
            emitters.add(manager.createEmitter("session-1", null, "tab-" + index));
        }
        assertEquals(8, manager.activeConnectionCount("session-1"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> manager.createEmitter("session-1", null, "tab-overflow"));
        assertEquals("SSE_CONNECTION_LIMIT", error.getCode());
        assertEquals(409, error.getStatus().value());
        assertEquals(8, manager.activeConnectionCount("session-1"),
                "the rejected connection must not evict an existing one");
    }
}
