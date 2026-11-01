package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.cc01cc.p.xihe.cp.integration.TestDataFactory;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0618 (Lead 裁定 B): {@code WorkspaceMembershipSeamIntegrationTest#workspaceCreationBindsTheCreatorAsOwner}
 * moved here verbatim, because creating a workspace through the public API now needs an explicit
 * {@code direct_attach} payload plus a reachable Runtime probe — and the plain integration lane has no
 * Runtime. The WireMock lane can stub the probe, so the original assertion ("API creation binds the
 * creator as WS_OWNER") keeps its full meaning instead of being downgraded to a fixture bypass.
 */
class WorkspaceCreationOwnerBindingWireMockTest extends AbstractWireMockTest {

    /** Point the CP's Runtime client at this class' WireMock so the direct_attach probe is stubbed. */
    @org.springframework.test.context.DynamicPropertySource
    static void runtimeUrl(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void workspaceCreationViaApiBindsTheCreatorAsOwner() {
        // register → token + user id
        String email = "seam-creator-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "Seam Creator"),
                Map.class);
        assertEquals(HttpStatus.CREATED.value(), registration.getStatusCode().value());
        assertNotNull(registration.getBody());
        String token = (String) registration.getBody().get("accessToken");
        Map<?, ?> user = (Map<?, ?>) registration.getBody().get("user");
        String userId = (String) user.get("id");

        // the Runtime capability probe answers READY, so direct_attach creation is allowed
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                                + "\"executionMode\":\"windows-host\",\"available\":true}")));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);

        String hostPath;
        try {
            hostPath = java.nio.file.Files.createTempDirectory("seam-created-ws").toAbsolutePath().toString();
        } catch (java.io.IOException cause) {
            throw new IllegalStateException("cannot create the fixture host directory", cause);
        }

        ResponseEntity<String> created = restTemplate.exchange(url("/api/v1/workspaces"), HttpMethod.POST,
                new HttpEntity<>(Map.of(
                        "name", "seam-created-" + UUID.randomUUID(),
                        "storageMode", "direct_attach",
                        "hostPath", hostPath,
                        "executionMode", "windows-host"), headers),
                String.class);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        String workspaceId = created.getBody().replaceAll("(?s).*\"id\"\\s*:\\s*\"([^\"]+)\".*", "$1");

        // the creator holds exactly one workspace-tier binding (WS_OWNER) — the original assertion
        List<String> roles = jdbcTemplate.queryForList(
                "SELECT r.name FROM role_bindings b JOIN roles r ON r.id = b.role_id"
                        + " WHERE b.subject_type = 'user' AND b.subject_id = CAST(? AS UUID)"
                        + " AND b.scope_type = 'workspace' AND b.scope_id = CAST(? AS UUID)",
                String.class, userId, workspaceId);
        assertEquals(List.of("WS_OWNER"), roles,
                "the creator holds exactly one workspace-tier binding");

        ResponseEntity<String> members = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/members"), HttpMethod.GET,
                new HttpEntity<>(headers), String.class);
        assertEquals(HttpStatus.OK, members.getStatusCode(), members.getBody());
        String body = members.getBody();
        assertEquals(1, body.split("\"userId\"").length - 1, "the creator is the only member");
        assertEquals(true, body.contains(userId), "the sole member is the creator: " + body);
        assertEquals(true, body.contains("\"OWNER\""), "the creator is OWNER: " + body);
    }
}
