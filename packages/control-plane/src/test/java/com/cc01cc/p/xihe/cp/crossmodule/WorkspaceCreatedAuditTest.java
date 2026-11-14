package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;

/**
 * task-575: creating a workspace is a user-facing action that carries an authorization fact (the creator
 * becomes WS_OWNER), so it must leave exactly one {@code workspace_created} audit row.
 *
 * <p>Before the fix the row count is 0, so this test must fail on the unfixed tree — the assertion is
 * "exactly one new row keyed to this workspace", not "some row exists": the creation path already writes
 * {@code workspace_membership_bound} and {@code authorization_role_grant_materialized}, and "a row exists"
 * would be satisfied by those two and stay green with the gap in place.</p>
 */
class WorkspaceCreatedAuditTest extends AbstractWireMockTest {

    @org.springframework.test.context.DynamicPropertySource
    static void runtimeUrl(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String token;

    @BeforeEach
    void setUpCreatedAudit() {
        token = registerAndLogin();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                                + "\"executionMode\":\"windows-host\",\"available\":true}")));
    }

    @Test
    void createWritesExactlyOneWorkspaceCreatedAuditRow() throws IOException {
        int before = createdRows();
        String rootPath = Files.createTempDirectory("ws-created-audit").toAbsolutePath().toString();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "created-audit-" + UUID.randomUUID());
        body.put("storageMode", "direct_attach");
        body.put("executionMode", "windows-host");
        body.put("roots", List.of(Map.of("path", rootPath)));

        ResponseEntity<String> created = restTemplate.exchange(url("/api/v1/workspaces"), HttpMethod.POST,
                entityWithAuth(body, token), String.class);
        assertThat(created.getStatusCode().value()).isEqualTo(201);

        Map<String, Object> latest = jdbcTemplate.queryForMap(
                "select id from workspaces order by created_at desc, id desc limit 1");
        String workspaceId = String.valueOf(latest.get("id"));

        assertThat(createdRows())
                .as("exactly one workspace_created row per creation (not merely 'a row exists')")
                .isEqualTo(before + 1);
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "select resource_id, details from audit_logs where action = 'workspace_created'"
                        + " and resource_id = ?", workspaceId);
        assertThat(rows).hasSize(1);
        assertThat(String.valueOf(rows.get(0).get("details")))
                .as("prefix-filterable details: storageMode first")
                .startsWith("storageMode=direct_attach;");
    }

    private int createdRows() {
        Integer count = jdbcTemplate.queryForObject(
                "select count(*) from audit_logs where action = 'workspace_created'", Integer.class);
        return count == null ? 0 : count;
    }
}
