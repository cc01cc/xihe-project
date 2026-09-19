package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0354 V3/V4: real CP → Agent summarize hop against WireMock plus the
 * compaction.applied observation fields and the pricing mapping (Q5-A).
 */
class AgentSummarizeIntegrationTest extends AbstractWireMockTest {

    private static final String WORKSPACE_ID = "aaaaaaaa-0000-0000-0000-000000000010";
    private static final String USER_ID = "bbbbbbbb-0000-0000-0000-000000000001";

    @DynamicPropertySource
    static void agentProps(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-base-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private ContextService contextService;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ProviderConnectionRepository providerConnectionRepository;

    @Autowired
    private ConfigService configService;

    @BeforeEach
    void setUp() {
        wireMock.resetAll();
        configService.putLayer("instance", "pricing", Map.of(
                "models", "{\"deepseek/m1\":{\"inputPerMTok\":1.0,\"outputPerMTok\":2.0,\"currency\":\"USD\"}}"),
                "test", null, null);
        configService.putLayer("instance", "context-policy", Map.of(
                "defaults", "{\"summaryProvider\":\"llm\",\"summaryTimeoutMs\":15000,\"pruneWindowChars\":80000}"),
                "test", null, null);
    }

    @Test
    void llmSummaryIsUsedAndCostedOnCompactionEvent() {
        String sessionId = createBoundSession("cccccccc-0000-0000-0000-000000000001");
        appendConversation(sessionId);
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/summarize")).willReturn(
                aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"summary\":\"[Goal] ship PLAN-0354\\n[Work State] Active: T1\","
                                + "\"usage\":{\"inputTokens\":100,\"outputTokens\":20,\"totalTokens\":120,"
                                + "\"source\":\"real\"}}")));

        ContextEvent applied = contextService.compact(sessionId, WORKSPACE_ID, USER_ID, null, "manual", null);

        JsonNode payload = read(applied);
        assertThat(payload.path("provider").asText()).isEqualTo("llm");
        assertThat(payload.path("model").asText()).isEqualTo("deepseek/m1");
        assertThat(payload.path("fallbackReason").isMissingNode()).isTrue();
        assertThat(payload.path("beforeTokens").asLong()).isPositive();
        assertThat(payload.path("afterTokens").asLong()).isPositive();
        assertThat(payload.path("source").asText()).isEqualTo("real");
        JsonNode usage = payload.path("usage");
        assertThat(usage.path("inputTokens").asLong()).isEqualTo(100);
        assertThat(usage.path("totalTokens").asLong()).isEqualTo(120);
        assertThat(usage.path("costSource").asText()).isEqualTo("price_table");
        assertThat(usage.path("cost").decimalValue()).isPositive();
        // Statistical fields only: no credential material in the event.
        assertThat(applied.getPayload()).doesNotContain("pl_");
    }

    @Test
    void agentFailureFallsBackToRuleAndStillAppliesCompaction() {
        String sessionId = createBoundSession("cccccccc-0000-0000-0000-000000000002");
        appendConversation(sessionId);
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/summarize")).willReturn(aResponse().withStatus(500)));

        ContextEvent applied = contextService.compact(sessionId, WORKSPACE_ID, USER_ID, null, "manual", null);

        JsonNode payload = read(applied);
        assertThat(payload.path("provider").asText()).isEqualTo("rule");
        assertThat(payload.path("fallbackReason").asText()).isEqualTo("agent_error");
        assertThat(payload.path("usage").isMissingNode()).isTrue();
        assertThat(payload.path("summary").asText()).isNotBlank();
        assertThat(payload.path("up_to_sequence").asLong()).isPositive();
    }

    @Test
    void summarizeTimeoutFallsBackToRule() {
        String sessionId = createBoundSession("cccccccc-0000-0000-0000-000000000003");
        appendConversation(sessionId);
        configService.putLayer("instance", "context-policy", Map.of(
                "defaults", "{\"summaryProvider\":\"llm\",\"summaryTimeoutMs\":1000,\"pruneWindowChars\":80000}"),
                "test", null, null);
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/summarize")).willReturn(
                aResponse().withStatus(200)
                        .withFixedDelay(1500)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"summary\":\"[Goal] late\",\"usage\":{}}")));

        ContextEvent applied = contextService.compact(sessionId, WORKSPACE_ID, USER_ID, null, "manual", null);

        JsonNode payload = read(applied);
        assertThat(payload.path("provider").asText()).isEqualTo("rule");
        assertThat(payload.path("fallbackReason").asText()).isEqualTo("timeout");
    }

    private JsonNode read(ContextEvent event) {
        try {
            return objectMapper.readTree(event.getPayload());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String createBoundSession(String sessionId) {
        ProviderConnection connection = providerConnectionRepository
                .findByOwnerTypeAndOwnerIdAndProviderId(
                        ProviderConnection.OWNER_USER, USER_ID, "deepseek")
                .orElseGet(() -> {
                    ProviderConnection created = new ProviderConnection();
                    created.setId(UUID.randomUUID());
                    created.setOwnerType(ProviderConnection.OWNER_USER);
                    created.setOwnerId(USER_ID);
                    created.setProviderId("deepseek");
                    created.setLabel("test connection");
                    created.setBaseUrl("http://localhost:1");
                    created.setEncryptionKeyVersion("v1");
                    created.setStatus(ProviderConnection.STATUS_READY);
                    created.setEnabled(true);
                    created.setRevision(1L);
                    return providerConnectionRepository.save(created);
                });

        Session session = new Session(WORKSPACE_ID, USER_ID, "summary test");
        session.setId(UUID.fromString(sessionId));
        session.setModelProvider("deepseek");
        session.setModelName("m1");
        session.setProviderConnectionId(connection.getId().toString());
        session.setConnectionRevision(1L);
        sessionRepository.save(session);
        return sessionId;
    }

    private void appendConversation(String sessionId) {
        eventStoreService.append(sessionId, WORKSPACE_ID, USER_ID, "session.created", Map.of(
                "workspace_id", WORKSPACE_ID,
                "user_id", USER_ID,
                "epoch_id", "e1",
                "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        eventStoreService.append(sessionId, WORKSPACE_ID, USER_ID, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "please finish PLAN-0354")));
        eventStoreService.append(sessionId, WORKSPACE_ID, USER_ID, "assistant.responded", Map.of(
                "message", Map.of("role", "ai", "content", "working on src/App.vue")));
    }
}
