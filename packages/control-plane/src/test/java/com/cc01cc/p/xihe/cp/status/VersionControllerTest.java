package com.cc01cc.p.xihe.cp.status;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class VersionControllerTest {

    @Test
    void responseShapeIsVersionIdentityOnly() {
        MockEnvironment environment = new MockEnvironment()
            .withProperty("XIHE_STACK_ID", "stack-2")
            .withProperty("XIHE_RELEASE_CHANNEL", "beta")
            .withProperty("XIHE_BUILD_COMMIT", "b0c68ddf");
        HealthMonitor monitor = mock(HealthMonitor.class);
        when(monitor.getAgentHealth()).thenReturn(new HealthMonitor.ServiceHealth(
            "up", 0, 1, "up", "ready", "rev-1", "2026-10-21T00:00:00Z",
            "0.1.0", "b0c68ddf", "langgraph"));
        when(monitor.getRuntimeHealth()).thenReturn(new HealthMonitor.ServiceHealth(
            "up", 0, 1, "up", "unknown", "", null,
            "0.1.0", "b0c68ddf", null));

        Map<String, Object> result = new VersionController(
            new BuildVersion(), monitor, environment).getVersion();

        assertEquals(List.of("stackId", "releaseChannel", "startedAt", "commit", "modules"),
            List.copyOf(result.keySet()));
        assertEquals("stack-2", result.get("stackId"));
        assertEquals("beta", result.get("releaseChannel"));
        assertEquals("b0c68ddf", result.get("commit"));
        assertTrue(result.get("startedAt") instanceof String);
        @SuppressWarnings("unchecked")
        Map<String, Object> modules = (Map<String, Object>) result.get("modules");
        assertEquals(List.of("cp", "agent", "runtime"), List.copyOf(modules.keySet()));
        assertFalse(modules.containsKey("ui"));
        @SuppressWarnings("unchecked")
        Map<String, Object> cp = (Map<String, Object>) modules.get("cp");
        @SuppressWarnings("unchecked")
        Map<String, Object> agent = (Map<String, Object>) modules.get("agent");
        @SuppressWarnings("unchecked")
        Map<String, Object> runtime = (Map<String, Object>) modules.get("runtime");
        assertEquals(List.of("version", "commit"), List.copyOf(cp.keySet()));
        assertEquals(List.of("version", "commit", "framework"), List.copyOf(agent.keySet()));
        assertEquals(List.of("version", "commit"), List.copyOf(runtime.keySet()));
        assertEquals("langgraph", agent.get("framework"));
    }

    @Test
    void defaultsToStackOneDevAndNullCommit() {
        MockEnvironment environment = new MockEnvironment();
        HealthMonitor monitor = mock(HealthMonitor.class);
        when(monitor.getAgentHealth()).thenReturn(new HealthMonitor.ServiceHealth("down", 3, 1));
        when(monitor.getRuntimeHealth()).thenReturn(new HealthMonitor.ServiceHealth("down", 3, 1));

        Map<String, Object> result = new VersionController(
            new BuildVersion(), monitor, environment).getVersion();

        assertEquals("stack-1", result.get("stackId"));
        assertEquals("dev", result.get("releaseChannel"));
        assertNull(result.get("commit"));
        @SuppressWarnings("unchecked")
        Map<String, Object> modules = (Map<String, Object>) result.get("modules");
        @SuppressWarnings("unchecked")
        Map<String, Object> agent = (Map<String, Object>) modules.get("agent");
        @SuppressWarnings("unchecked")
        Map<String, Object> runtime = (Map<String, Object>) modules.get("runtime");
        assertNull(agent.get("version"));
        assertNull(agent.get("commit"));
        assertNull(agent.get("framework"));
        assertNull(runtime.get("version"));
    }

    @Test
    void invalidChannelAndCommitFallBackHonestly() {
        MockEnvironment environment = new MockEnvironment()
            .withProperty("XIHE_RELEASE_CHANNEL", "nightly")
            .withProperty("XIHE_BUILD_COMMIT", "not-a-sha");
        HealthMonitor monitor = mock(HealthMonitor.class);
        when(monitor.getAgentHealth()).thenReturn(new HealthMonitor.ServiceHealth("down", 3, 1));
        when(monitor.getRuntimeHealth()).thenReturn(new HealthMonitor.ServiceHealth("down", 3, 1));

        Map<String, Object> result = new VersionController(
            new BuildVersion(), monitor, environment).getVersion();

        assertEquals("dev", result.get("releaseChannel"));
        assertNull(result.get("commit"));
    }
}
