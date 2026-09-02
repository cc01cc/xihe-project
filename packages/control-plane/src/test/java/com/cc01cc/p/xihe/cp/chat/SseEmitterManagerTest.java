package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.AfterEach;
import static org.junit.jupiter.api.Assertions.*;

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
    }

    @Test
    void createEmitter_replacesExisting() {
        var first = manager.createEmitter("session-1");
        var second = manager.createEmitter("session-1");
        assertNotSame(first, second);
        assertTrue(manager.hasEmitter("session-1"));
    }

    @Test
    void replacedEmitterCompletionDoesNotRemoveCurrentEmitter() {
        var first = manager.createEmitter("session-1");
        var second = manager.createEmitter("session-1");

        first.complete();

        assertTrue(manager.hasEmitter("session-1"));
        assertTrue(manager.complete("session-1", second));
        assertFalse(manager.hasEmitter("session-1"));
    }

    @Test
    void completingStaleEmitterDoesNotCompleteCurrentEmitter() {
        var first = manager.createEmitter("session-1");
        var second = manager.createEmitter("session-1");

        assertFalse(manager.complete("session-1", first));
        assertTrue(manager.hasEmitter("session-1"));
        assertTrue(manager.complete("session-1", second));
    }

    @Test
    void connectionGenerationIncrementsPerSession() {
        manager.createEmitter("session-1");
        assertEquals(1L, manager.connectionGeneration("session-1"));
        manager.createEmitter("session-1");
        assertEquals(2L, manager.connectionGeneration("session-1"));
    }

    @Test
    void complete_removesEmitter() {
        manager.createEmitter("session-1");
        manager.complete("session-1");
        assertFalse(manager.hasEmitter("session-1"));
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
}
