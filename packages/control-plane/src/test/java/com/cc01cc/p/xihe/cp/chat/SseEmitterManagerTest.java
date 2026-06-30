package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SseEmitterManagerTest {

    private final SseEmitterManager manager = new SseEmitterManager();

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
        manager.send("nonexistent", "test", "data");
    }

    @Test
    void hasEmitter_returnsFalseForUnknown() {
        assertFalse(manager.hasEmitter("unknown"));
    }
}
