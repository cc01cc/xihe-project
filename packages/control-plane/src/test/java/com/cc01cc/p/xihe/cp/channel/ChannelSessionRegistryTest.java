package com.cc01cc.p.xihe.cp.channel;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit tests for the channel session registry and handler helpers (PLAN-245).
 * Pure in-memory behaviour — no WebSocket transport involved.
 */
class ChannelSessionRegistryTest {

    @Test
    void register_then_lookup_by_device() {
        ChannelSessionRegistry registry = new ChannelSessionRegistry();
        String deviceId = java.util.UUID.randomUUID().toString();
        assertNotNull(registry.register(deviceId, "session-1"));
        assertNotNull(registry.byDevice(deviceId));
        assertEquals(1, registry.deviceIds().size());
    }

    @Test
    void duplicate_deviceId_is_rejected() {
        ChannelSessionRegistry registry = new ChannelSessionRegistry();
        String deviceId = java.util.UUID.randomUUID().toString();
        assertNotNull(registry.register(deviceId, "session-1"));
        assertNull(registry.register(deviceId, "session-2"));
        assertEquals("session-1", registry.byDevice(deviceId).sessionId());
    }

    @Test
    void unregister_removes_only_matching_session() {
        ChannelSessionRegistry registry = new ChannelSessionRegistry();
        String deviceId = java.util.UUID.randomUUID().toString();
        registry.register(deviceId, "session-1");

        assertNull(registry.unregister("session-other"));
        ChannelSessionRegistry.ChannelSession removed = registry.unregister("session-1");
        assertNotNull(removed);
        assertNull(registry.byDevice(deviceId));
    }

    @Test
    void touchHeartbeat_updates_lastHeartbeat_and_sequence() {
        ChannelSessionRegistry registry = new ChannelSessionRegistry();
        String deviceId = java.util.UUID.randomUUID().toString();
        registry.register(deviceId, "session-1");
        long before = registry.byDevice(deviceId).lastHeartbeatEpochMs();

        ChannelSessionRegistry.ChannelSession updated =
                registry.touchHeartbeat("session-1", 42L);
        assertNotNull(updated);
        assertEquals(42L, updated.lastSequence());
        assertTrue(updated.lastHeartbeatEpochMs() >= before);
    }

    @Test
    void stale_returns_sessions_past_timeout() throws InterruptedException {
        ChannelSessionRegistry registry = new ChannelSessionRegistry();
        registry.register(java.util.UUID.randomUUID().toString(), "session-1");
        Thread.sleep(5);
        assertTrue(registry.stale(1).size() == 1);
        assertTrue(registry.stale(60_000).isEmpty());
    }

    @Test
    void isValidDeviceId_matches_uuid_v4_shape() {
        assertTrue(RuntimeChannelHandler.isValidDeviceId(java.util.UUID.randomUUID().toString()));
        assertFalse(RuntimeChannelHandler.isValidDeviceId("not-a-uuid"));
        assertFalse(RuntimeChannelHandler.isValidDeviceId(""));
        assertFalse(RuntimeChannelHandler.isValidDeviceId(null));
        assertFalse(RuntimeChannelHandler.isValidDeviceId("a".repeat(36)));
    }

    @Test
    void diffWorkspaces_flags_incomplete_summaries() throws Exception {
        RuntimeChannelHandler handler = newChannelHandler();
        String body = """
                {"workspaces":[
                  {"workspaceId":"ws-1","generation":3,"sandboxSpecHash":"abc","state":"Ready"},
                  {"workspaceId":"","generation":0,"sandboxSpecHash":"","state":"Unknown"},
                  {"workspaceId":"ws-3","generation":0,"sandboxSpecHash":"x","state":"Ready"}
                ]}""";
        var root = new com.fasterxml.jackson.databind.ObjectMapper().readTree(body);
        var drifted = handler.diffWorkspaces(root.path("workspaces"));
        // ws-1 complete; empty id flagged; ws-3 zero generation flagged.
        assertEquals(2, drifted.size());
        assertTrue(drifted.contains("ws-3"));
    }

    @Test
    void diffWorkspaces_handles_missing_field() throws Exception {
        RuntimeChannelHandler handler = newChannelHandler();
        var root = new com.fasterxml.jackson.databind.ObjectMapper().readTree("{}");
        assertTrue(handler.diffWorkspaces(root).isEmpty());
    }

    private RuntimeChannelHandler newChannelHandler() {
        return new RuntimeChannelHandler(
                new com.fasterxml.jackson.databind.ObjectMapper(),
                new ChannelSessionRegistry(),
                new ChannelProperties(90));
    }
}
