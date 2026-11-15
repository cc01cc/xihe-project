package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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

    /**
     * task-269: the fan-out claim must be about <b>content</b>. Every other test in this class
     * counts entries or compares emitter identity — none of them would notice a broadcast that
     * only reaches the first connection. This one reads what each transport actually received.
     */
    @Test
    void fanOutDeliversTheSamePayloadToEveryConnection() throws Exception {
        var first = manager.createEmitter("session-1", null, "tab-a");
        var second = manager.createEmitter("session-1", null, "tab-b");
        SseEmitterCapture firstWire = SseEmitterCapture.attach(first, null);
        SseEmitterCapture secondWire = SseEmitterCapture.attach(second, null);

        assertTrue(manager.send("session-1", "usage", Map.of("runId", "r1", "type", "usage")));

        assertTrue(firstWire.delivered("runId=r1"),
                "tab A must receive the payload, frames=" + firstWire.frames());
        assertTrue(secondWire.delivered("runId=r1"),
                "tab B must receive the same payload, frames=" + secondWire.frames());
        assertTrue(firstWire.delivered("usage") && secondWire.delivered("usage"),
                "the event name must reach both connections");
    }

    /**
     * task-269 (card criterion 5): a broken connection may only remove itself. The healthy
     * connection must still receive the very same event, and the broadcast must still report
     * success.
     */
    @Test
    void aBrokenConnectionDoesNotStopTheBroadcast() throws Exception {
        var broken = manager.createEmitter("session-1", null, "tab-broken");
        var healthy = manager.createEmitter("session-1", null, "tab-healthy");
        SseEmitterCapture.attach(broken, new java.io.IOException("simulated dead socket"));
        SseEmitterCapture healthyWire = SseEmitterCapture.attach(healthy, null);

        assertTrue(manager.send("session-1", "usage", Map.of("runId", "r2", "type", "usage")),
                "one dead connection must not turn the whole broadcast into a failure");

        assertTrue(healthyWire.delivered("runId=r2"),
                "the healthy connection must receive the event, frames=" + healthyWire.frames());
        assertEquals(1, manager.activeConnectionCount("session-1"),
                "only the broken entry may be removed");
        assertTrue(manager.hasEmitter("session-1"));
    }

    /**
     * task-269: a declared participant view is filtered per connection, not per session — the
     * owner connection keeps the full stream while the declared view only gets its own producer.
     * Asserted on delivered content, so a filter that silently drops everything cannot pass.
     */
    @Test
    void producerFilteringIsAppliedPerConnectionOnTheDeliveredContent() throws Exception {
        var owner = manager.createEmitter("session-1", null, "tab-owner");
        var declared = manager.createEmitter("session-1", "participant-1", "tab-view");
        SseEmitterCapture ownerWire = SseEmitterCapture.attach(owner, null);
        SseEmitterCapture declaredWire = SseEmitterCapture.attach(declared, null);

        manager.send("session-1", "usage", Map.of("runId", "foreign", "type", "usage"), "participant-2");
        assertTrue(ownerWire.delivered("runId=foreign"), "the observer keeps the full stream");
        assertFalse(declaredWire.delivered("runId=foreign"),
                "a declared view must not receive another producer's output");

        manager.send("session-1", "usage", Map.of("runId", "own", "type", "usage"), "participant-1");
        assertTrue(declaredWire.delivered("runId=own"),
                "the declared view must receive its own producer's output");
        assertEquals(2, manager.activeConnectionCount("session-1"),
                "filtering is a skip, not a disconnect");
    }
}
