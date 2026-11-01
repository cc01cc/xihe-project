package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0614 (blank start): register/login/refresh never create a workspace.
 *
 * <p>A fresh account authenticates successfully (201/200) with {@code workspaceId = null} and an empty
 * {@code GET /api/v1/workspaces}; the first workspace only exists after the user creates it explicitly.
 * An account that already has workspaces keeps getting its first one — nothing is migrated.</p>
 */
class BlankStartAuthenticationIntegrationTest extends AbstractH2Test {

    @Autowired
    private WorkspaceService workspaceService;

    @Test
    void freshAccountRegistersBlankWithoutSystemCreatedWorkspace() {
        String email = "plan0614-blank-" + UUID.randomUUID() + "@test.local";

        ResponseEntity<Map> registered = register(email);

        assertEquals(HttpStatus.CREATED, registered.getStatusCode(), String.valueOf(registered.getBody()));
        assertTrue(registered.getBody().containsKey("workspaceId"));
        assertNull(registered.getBody().get("workspaceId"),
                "V1/V2: a fresh account authenticates with no workspace instead of failing");
        String token = (String) registered.getBody().get("accessToken");
        assertNotNull(token);

        ResponseEntity<List> workspaces = restTemplate.exchange(url("/api/v1/workspaces"),
                HttpMethod.GET, authEntity(token), List.class);
        assertEquals(HttpStatus.OK, workspaces.getStatusCode());
        assertTrue(workspaces.getBody().isEmpty(),
                "I3: the list is an empty array, not a 404 and not a fabricated item");

        // No workspace context yet: the existing 404 stays 404 (no new error code, I2).
        ResponseEntity<String> current = restTemplate.exchange(
                url("/api/v1/workspaces/current"), HttpMethod.GET, authEntity(token), String.class);
        assertEquals(HttpStatus.NOT_FOUND, current.getStatusCode(),
                "no workspace context keeps the existing WORKSPACE_NOT_FOUND semantics");

        // Login and refresh behave the same: 200 with a null workspace id.
        ResponseEntity<Map> login = restTemplate.postForEntity(url("/api/v1/auth/login"),
                new HttpEntity<>(Map.of("identifier", email, "password", "pw-12345678"), jsonHeaders()),
                Map.class);
        assertEquals(HttpStatus.OK, login.getStatusCode(), String.valueOf(login.getBody()));
        assertNull(login.getBody().get("workspaceId"), "V4-adjacent: login does not create a workspace either");

        ResponseEntity<Map> refresh = restTemplate.postForEntity(url("/api/v1/auth/refresh"),
                new HttpEntity<>(Map.of("refreshToken", login.getBody().get("refreshToken")), jsonHeaders()),
                Map.class);
        assertEquals(HttpStatus.OK, refresh.getStatusCode(), String.valueOf(refresh.getBody()));
        assertNull(refresh.getBody().get("workspaceId"), "refresh does not create a workspace either");
    }

    @Test
    void existingAccountStillGetsItsFirstWorkspace() {
        String email = "plan0614-existing-" + UUID.randomUUID() + "@test.local";
        ResponseEntity<Map> registered = register(email);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode(), String.valueOf(registered.getBody()));
        String userId = ((Map<?, ?>) registered.getBody().get("user")).get("id").toString();

        Workspace created = workspaceService.createWorkspace("First explicit workspace", null, userId);

        ResponseEntity<Map> login = restTemplate.postForEntity(url("/api/v1/auth/login"),
                new HttpEntity<>(Map.of("identifier", email, "password", "pw-12345678"), jsonHeaders()),
                Map.class);

        assertEquals(HttpStatus.OK, login.getStatusCode(), String.valueOf(login.getBody()));
        assertEquals(created.getId().toString(), login.getBody().get("workspaceId"),
                "I5: an account with a workspace still receives its first active workspace");
        assertEquals(created.getId(),
                workspaceService.firstActiveWorkspace(userId).map(Workspace::getId).orElseThrow());
    }

    // ------------------------------------------------------------------ helpers

    private ResponseEntity<Map> register(String email) {
        return restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", "pw-12345678",
                        "name", "Blank Start"), jsonHeaders()), Map.class);
    }

    private static HttpHeaders jsonHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private static HttpEntity<Void> authEntity(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return new HttpEntity<>(headers);
    }
}
