package com.cc01cc.p.xihe.cp.runtime;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.service.WorkspaceExecutionSpecService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class RuntimeExecutionSpecIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private WorkspaceExecutionSpecService executionSpecService;

    @Test
    void runtimeHeartbeatRequiresBearerAndIsAccepted() {
        ResponseEntity<Map> unauthorized = restTemplate.postForEntity(
                url("/internal/v1/runtime/heartbeat"),
                Map.of("deviceId", "device-test", "status", "ready"),
                Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED, unauthorized.getStatusCode());

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("dev-token-not-secure");
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/internal/v1/runtime/heartbeat"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("deviceId", "device-test", "status", "ready"), headers),
                Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("accepted", response.getBody().get("status"));
    }

    @Test
    void targetedExecutionSpecRequiresBearerAndReturnsSpec() {
        // Targeted endpoint must reject missing bearer.
        ResponseEntity<Map> unauthorized = restTemplate.getForEntity(
                url("/internal/v1/runtime/workspaces/unknown/execution-spec"), Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED, unauthorized.getStatusCode());

        String email = "execspec-" + System.currentTimeMillis() + "@test.com";
        ResponseEntity<AuthResponse> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, "ExecutionSpec Test"),
                AuthResponse.class);
        String workspaceId = registration.getBody().getWorkspaceId();
        assertNotNull(workspaceId);

        executionSpecService.createExecutionSpec(
                workspaceId,
                "{\"image\":\"xihe/workspace:latest\",\"profile\":\"strict\"}",
                "test-actor",
                "test-update");

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("dev-token-not-secure");
        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                url("/internal/v1/runtime/workspaces/" + workspaceId + "/execution-spec"),
                HttpMethod.GET,
                new HttpEntity<>(headers),
                new ParameterizedTypeReference<Map<String, Object>>() { });

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<String, Object> spec = response.getBody();
        assertNotNull(spec);
        assertEquals(workspaceId, spec.get("workspaceId"));
        assertNotEquals(0, spec.get("generation"));
        assertNotEquals("", spec.get("sandboxSpecHash"));
        assertEquals("strict", ((Map<?, ?>) spec.get("sandboxSpec")).get("profile"));
    }

    @Test
    void targetedExecutionSpecReturns404ForUnknownWorkspace() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("dev-token-not-secure");
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/internal/v1/runtime/workspaces/00000000-0000-0000-0000-000000000000/execution-spec"),
                HttpMethod.GET,
                new HttpEntity<>(headers),
                Map.class);
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
    }
}
