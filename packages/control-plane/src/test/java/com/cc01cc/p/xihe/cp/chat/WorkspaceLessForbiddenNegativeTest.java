package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.cc01cc.p.xihe.cp.service.AgentMemoryInjectionService;
import com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService;
import com.cc01cc.p.xihe.cp.skill.SkillCatalogSourceService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * PLAN-0705 / BL-513: the ten capabilities forbidden to a workspace-less (pure-chat) session are
 * refused at their CP entry points with a problem code and zero durable side effects. This class
 * uses a fresh user with NO workspace: the capability guards must answer 4xx (fail-closed), not
 * silently fall back to an instance/first-active workspace.
 */
class WorkspaceLessForbiddenNegativeTest extends AbstractIntegrationTest {

    private static final String SCRIPT_TEN = "forbidden-negative";
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();

    @Autowired private JdbcTemplate jdbc;
    @Autowired private ObjectMapper objectMapper;

    private String token;

    @BeforeEach
    void registerUser() {
        AuthResponse registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest("neg-" + UUID.randomUUID() + "@test.local",
                        TestDataFactory.PASSWORD, "neg"), AuthResponse.class).getBody();
        assertNotNull(registered);
        token = registered.getAccessToken();
    }

    @Test
    void checkpointRevertIsRefusedWithoutWorkspace() throws Exception {
        assertRefused("POST", "/api/v1/workspaces/" + UUID.randomUUID() + "/checkpoints/revert", Map.of());
    }

    @Test
    void checkpointRevertPreviewIsRefusedWithoutWorkspace() throws Exception {
        assertRefused("POST", "/api/v1/workspaces/" + UUID.randomUUID()
                + "/checkpoints/revert/preview", Map.of());
    }

    @Test
    void continuationIsRefusedForUnknownSourceRun() throws Exception {
        assertRefused("POST", "/api/v1/chat/runs/" + UUID.randomUUID() + "/continue", Map.of());
    }

    @Test
    void memoryWriteIsRefusedWithoutWorkspace() throws Exception {
        assertRefused("POST", "/api/v1/workspaces/" + UUID.randomUUID() + "/agents/"
                + UUID.randomUUID() + "/memories", Map.of("content", "x"));
    }

    @Test
    void ragSearchIsRefusedWithoutWorkspace() throws Exception {
        assertRefused("POST", "/api/v1/rag/search", Map.of("query", "x"));
    }

    @Test
    void approvalsAreRefusedWithoutWorkspace() throws Exception {
        assertRefused("GET", "/api/v1/approvals", null);
    }

    @Test
    void spawnIsRefusedWithoutParentWorkspaceContext() throws Exception {
        assertRefused("POST", "/internal/v1/agents/spawn",
                Map.of("parentRunId", UUID.randomUUID().toString(),
                        "toolCallId", UUID.randomUUID().toString()));
    }

    @Test
    void scheduledTaskCreationIsRefusedWithoutWorkspace() throws Exception {
        assertRefused("POST", "/api/v1/workspaces/" + UUID.randomUUID() + "/scheduled-tasks",
                Map.of("prompt", "x"));
    }

    @Test
    void mcpInvocationIsRefusedWithoutWorkspace() throws Exception {
        assertRefused("POST", "/api/v1/mcp", Map.of());
    }

    @Test
    void workspaceConfigOverrideIsRefusedWithoutWorkspace() throws Exception {
        assertRefused("PUT", "/api/v1/config/workspace/llm-provider", Map.of("entries", "{}"));
    }

    @Test
    void allRefusalsLeaveZeroForbiddenSideEffects() {
        Map<String, Long> tables = Map.of(
                "run_checkpoints", count("run_checkpoints"),
                "agent_graph_checkpoint_lineages", count("agent_graph_checkpoint_lineages"),
                "agent_memories", count("agent_memories"),
                "approval_requests", count("approval_requests"),
                "scheduled_tasks", count("scheduled_tasks"));
        assertTrue(tables.values().stream().allMatch(value -> value == 0L),
                SCRIPT_TEN + " refusals must not write forbidden tables: " + tables);
    }

    @Test
    void pureChatResolutionNeverCallsRuntimeOrWorkspaceSources() {
        RuntimeContextSourceClient runtimeClient = mock(RuntimeContextSourceClient.class);
        PolicyEngine policyEngine = mock(PolicyEngine.class);
        AgentMemoryInjectionService memoryService = mock(AgentMemoryInjectionService.class);
        SkillCatalogSourceService skillService = mock(SkillCatalogSourceService.class);
        ContextTemplateSourceService service = new ContextTemplateSourceService(
                runtimeClient, policyEngine, new ObjectMapper(), memoryService, skillService);
        ContextTemplateSourceService.RunContext run = new ContextTemplateSourceService.RunContext(
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), null,
                UUID.randomUUID().toString(), null, null, null);
        Session session = new Session();
        session.setId(UUID.randomUUID());

        Map<String, Object> sources = service.resolve(run, session);

        assertTrue(sources.isEmpty(), "pure chat must resolve zero workspace sources: " + sources);
        verifyNoInteractions(runtimeClient, policyEngine, memoryService, skillService);
    }

    private long count(String table) {
        Long value = jdbc.queryForObject("SELECT count(*) FROM " + table, Long.class);
        return value == null ? 0L : value;
    }

    private void assertRefused(String method, String path, Object body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url(path)))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json");
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.method(method, HttpRequest.BodyPublishers.ofString(
                    objectMapper.writeValueAsString(body)));
        }
        HttpResponse<String> response = HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        assertTrue(response.statusCode() >= 400 && response.statusCode() < 500,
                method + " " + path + " must fail closed, got " + response.statusCode()
                        + ": " + response.body());
        JsonNode json = response.body() == null || response.body().isBlank()
                ? null : objectMapper.readTree(response.body());
        assertNotNull(json, "a refusal must carry a problem body: " + response.body());
        assertNotNull(json.path("code").asText(null),
                "a refusal must carry a machine-readable code: " + response.body());
    }
}
