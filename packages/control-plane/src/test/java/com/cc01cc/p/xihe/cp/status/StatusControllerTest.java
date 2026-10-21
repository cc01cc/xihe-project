package com.cc01cc.p.xihe.cp.status;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class StatusControllerTest {

    @Test
    void statusResponseShapeIsUnchangedByVersionEndpoint() {
        HealthMonitor monitor = mock(HealthMonitor.class);
        when(monitor.getAgentHealth()).thenReturn(new HealthMonitor.ServiceHealth("up", 0, 1));
        when(monitor.getRuntimeHealth()).thenReturn(new HealthMonitor.ServiceHealth("up", 0, 1));
        when(monitor.getAgentBreaker()).thenReturn(
            new CircuitBreaker("agent", 3, java.time.Duration.ofSeconds(30)));
        when(monitor.getRuntimeBreaker()).thenReturn(
            new CircuitBreaker("runtime", 3, java.time.Duration.ofSeconds(30)));
        StatusController controller = new StatusController(mock(JdbcTemplate.class), monitor);

        Map<String, Object> result = controller.getStatus();

        assertEquals(List.of("status", "timestamp", "services"), List.copyOf(result.keySet()));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> services = (List<Map<String, Object>>) result.get("services");
        assertEquals(
            List.of("Control Plane", "Agent", "Runtime", "PostgreSQL"),
            services.stream().map(service -> service.get("name")).toList());
    }
}
