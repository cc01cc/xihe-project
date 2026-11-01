package com.cc01cc.p.xihe.cp.crossmodule;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.doReturn;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.service.WorkspaceBackendPolicy;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0618 M1 (BL-178): chat and session creation honour the frozen docker backend.
 *
 * <p>The gate is the same predicate the file/exec/environment paths already use
 * ({@link WorkspaceBackendPolicy#requireOperationAllowed}), so the assertion is on the contract:
 * {@code 503 BACKEND_DISABLED} for a {@code managed_import} (docker) workspace, and <b>not</b> 503 for
 * the {@code direct_attach} default. The frozen switch is forced through a spy on {@code dockerEnabled()}
 * so the real gate body runs (no mocked 503, no docker container is ever created).
 */
class ChatBackendGateIntegrationTest extends AbstractWireMockTest {

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @MockitoSpyBean
    private WorkspaceBackendPolicy backendPolicy;

    /** Returns 5xx responses verbatim instead of throwing, so the 503 body can be asserted. */
    private org.springframework.web.client.RestTemplate gateRestTemplate;

    @BeforeEach
    void freezeDockerBackend() {
        doReturn(false).when(backendPolicy).dockerEnabled();
        gateRestTemplate = new org.springframework.web.client.RestTemplate();
        gateRestTemplate.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return false;
            }
        });
    }

    private record Session(String token, String userId) {
    }

    private Session register() {
        String email = "gate-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "Gate"),
                Map.class);
        assertEquals(HttpStatus.CREATED.value(), registration.getStatusCode().value());
        Map body = registration.getBody();
        assertNotNull(body);
        Map user = (Map) body.get("user");
        assertNotNull(user, "registration must return the user");
        return new Session((String) body.get("accessToken"), (String) user.get("id"));
    }

    private HttpHeaders headers(String token, String workspaceId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", workspaceId);
        return headers;
    }

    @Test
    void sessionCreationOnDockerWorkspaceIsRefusedWith503() {
        Session session = register();
        String workspaceId = workspaceFixture
                .createDockerOwnedWorkspace("gate-docker-session", session.userId()).getId().toString();

        ResponseEntity<Map> response = gateRestTemplate.postForEntity(
                url("/api/v1/sessions"),
                new HttpEntity<>(Map.of("title", "gated"), headers(session.token(), workspaceId)),
                Map.class);

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE.value(), response.getStatusCode().value(),
                String.valueOf(response.getBody()));
        assertNotNull(response.getBody());
        assertEquals("BACKEND_DISABLED", response.getBody().get("code"));
        assertTrue(String.valueOf(response.getBody().get("detail")).contains("direct_attach"),
                "the detail must point at the usable replacement: " + response.getBody().get("detail"));
    }

    @Test
    void chatDispatchOnDockerWorkspaceIsRefusedWith503() {
        Session session = register();
        String workspaceId = workspaceFixture
                .createDockerOwnedWorkspace("gate-docker-chat", session.userId()).getId().toString();

        ResponseEntity<Map> response = gateRestTemplate.postForEntity(
                url("/api/v1/chat"),
                new HttpEntity<>(Map.of(
                        "sessionId", UUID.randomUUID().toString(),
                        "branchId", UUID.randomUUID().toString(),
                        "content", "hello"), headers(session.token(), workspaceId)),
                Map.class);

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE.value(), response.getStatusCode().value(),
                String.valueOf(response.getBody()));
        assertNotNull(response.getBody());
        assertEquals("BACKEND_DISABLED", response.getBody().get("code"));
    }

    @Test
    void directAttachWorkspaceIsNotGated() {
        Session session = register();
        String workspaceId = workspaceFixture
                .createOwnedWorkspace("gate-direct-attach", session.userId()).getId().toString();

        ResponseEntity<Map> response = gateRestTemplate.exchange(
                url("/api/v1/sessions"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("title", "allowed"), headers(session.token(), workspaceId)),
                Map.class);

        // The reverse check: the direct_attach default must not be refused by the backend gate. Any
        // later failure is a different concern, so only "not 503" is asserted here.
        assertNotEquals(HttpStatus.SERVICE_UNAVAILABLE.value(), response.getStatusCode().value(),
                "direct_attach must not be refused by the frozen-backend gate: " + response.getBody());
        if (response.getBody() != null && response.getBody().get("code") != null) {
            assertNotEquals("BACKEND_DISABLED", response.getBody().get("code"));
        }
    }
}
