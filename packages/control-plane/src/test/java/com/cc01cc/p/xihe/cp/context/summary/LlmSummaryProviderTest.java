package com.cc01cc.p.xihe.cp.context.summary;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0354 V1/V3: provider selection and the frozen fallback-reason enum.
 * Pure unit tests (no Spring context, no HTTP).
 */
class LlmSummaryProviderTest {

    private static final String SESSION_ID = "11111111-1111-1111-1111-111111111111";
    private static final String WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
    private static final String USER_ID = "33333333-3333-3333-3333-333333333333";

    private final ConfigService configService = mock(ConfigService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ProviderCredentialLeaseService credentialLeases = mock(ProviderCredentialLeaseService.class);
    private final ConstraintExtractor constraintExtractor = mock(ConstraintExtractor.class);
    private final AgentSummarizeClient agentClient = mock(AgentSummarizeClient.class);
    private final RuleBasedSummaryProvider ruleProvider = new RuleBasedSummaryProvider(constraintExtractor);

    private final LlmSummaryProvider provider = new LlmSummaryProvider(
            configService, sessionRepository, credentialLeases, ruleProvider,
            constraintExtractor, agentClient, new ObjectMapper());

    @BeforeEach
    void setUp() {
        when(configService.resolveDomain("context-policy", UUID.fromString(USER_ID), UUID.fromString(WORKSPACE_ID)))
                .thenReturn(Map.of(
                "defaults", "{\"summaryProvider\":\"llm\",\"summaryTimeoutMs\":15000,\"pruneWindowChars\":80000}"));
        when(configService.resolveDomain("llm-provider", UUID.fromString(USER_ID), UUID.fromString(WORKSPACE_ID)))
                .thenReturn(Map.of(
                "defaultProvider", "deepseek", "defaultModel", "m1"));
        when(constraintExtractor.extract(any(), any(), any())).thenReturn(List.of());
        when(constraintExtractor.renderSection(any(), any(), any())).thenReturn(null);
    }

    @Test
    void llmSuccessReturnsLlmResultWithNormalizedUsage() {
        givenSession(boundSession());
        givenLease();
        when(agentClient.summarize(any(), anyLong())).thenReturn(new AgentSummarizeClient.Result(
                "[Goal] ship the plan\n[Work State] Active: T1",
                new java.util.HashMap<>(Map.of("inputTokens", 100, "outputTokens", 20, "source", "real"))));

        SummaryProvider.SummaryResult result = provider.summarize(request());

        assertThat(result.provider()).isEqualTo("llm");
        assertThat(result.model()).isEqualTo("deepseek/m1");
        assertThat(result.fallbackReason()).isNull();
        assertThat(result.summary()).contains("[Goal] ship the plan");
        assertThat(result.usage()).containsEntry("inputTokens", 100);
        assertThat(result.usage()).containsEntry("totalTokens", 120L);
        assertThat(result.usage()).containsEntry("model", "deepseek/m1");
        assertThat(result.usage()).containsKey("durationMs");
    }

    @Test
    void noProviderConnectionFallsBackWithNoCredential() {
        Session session = new Session(WORKSPACE_ID, USER_ID, "t");
        session.setId(UUID.fromString(SESSION_ID));
        session.setModelProvider("deepseek");
        session.setModelName("m1");
        givenSession(session);
        when(constraintExtractor.extract(any(), any(), any())).thenReturn(List.of());

        SummaryProvider.SummaryResult result = provider.summarize(request());

        assertThat(result.provider()).isEqualTo("rule");
        assertThat(result.fallbackReason()).isEqualTo("no_credential");
        assertThat(result.usage()).isNull();
        verify(agentClient, never()).summarize(any(), anyLong());
    }

    @Test
    void leaseFailureFallsBackWithLeaseFailed() {
        givenSession(boundSession());
        when(credentialLeases.issue(any(), any(), any(), any(), any(), any(), any(), any(), any()))
                .thenThrow(new IllegalArgumentException("stale revision"));

        SummaryProvider.SummaryResult result = provider.summarize(request());

        assertThat(result.provider()).isEqualTo("rule");
        assertThat(result.fallbackReason()).isEqualTo("lease_failed");
        verify(agentClient, never()).summarize(any(), anyLong());
    }

    @Test
    void timeoutFallsBackWithTimeout() {
        givenSession(boundSession());
        givenLease();
        when(agentClient.summarize(any(), anyLong()))
                .thenThrow(new AgentSummarizeClient.AgentSummarizeException("timeout", "timed out"));

        SummaryProvider.SummaryResult result = provider.summarize(request());

        assertThat(result.provider()).isEqualTo("rule");
        assertThat(result.fallbackReason()).isEqualTo("timeout");
    }

    @Test
    void upstreamErrorFallsBackWithAgentError() {
        givenSession(boundSession());
        givenLease();
        when(agentClient.summarize(any(), anyLong()))
                .thenThrow(new AgentSummarizeClient.AgentSummarizeException("agent_error", "status 502"));

        SummaryProvider.SummaryResult result = provider.summarize(request());

        assertThat(result.provider()).isEqualTo("rule");
        assertThat(result.fallbackReason()).isEqualTo("agent_error");
    }

    @Test
    void unusableOutputFallsBackWithInvalidOutputKeepingUsage() {
        givenSession(boundSession());
        givenLease();
        when(agentClient.summarize(any(), anyLong())).thenReturn(new AgentSummarizeClient.Result(
                "no section headers here", Map.of("inputTokens", 5, "outputTokens", 1, "source", "real")));

        SummaryProvider.SummaryResult result = provider.summarize(request());

        assertThat(result.provider()).isEqualTo("rule");
        assertThat(result.fallbackReason()).isEqualTo("invalid_output");
        // The provider call completed: its usage (cost) is still reported.
        assertThat(result.usage()).isNotNull();
        assertThat(result.usage()).containsEntry("inputTokens", 5);
    }

    @Test
    void configuredRuleModeIsDirectRuleWithoutFallbackReason() {
        when(configService.resolveDomain("context-policy", UUID.fromString(USER_ID), UUID.fromString(WORKSPACE_ID)))
                .thenReturn(Map.of(
                "defaults", "{\"summaryProvider\":\"rule\"}"));
        givenSession(boundSession());

        SummaryProvider.SummaryResult result = provider.summarize(request());

        assertThat(result.provider()).isEqualTo("rule");
        assertThat(result.fallbackReason()).isNull();
        assertThat(result.usage()).isNull();
        verify(agentClient, never()).summarize(any(), anyLong());
    }

    @Test
    void llmOutputConstraintsSectionIsReplacedByCodeExtraction() {
        givenSession(boundSession());
        givenLease();
        when(agentClient.summarize(any(), anyLong())).thenReturn(new AgentSummarizeClient.Result(
                "[Goal] g\n[Constraints] model invented a constraint\n[Recent] r",
                Map.of("inputTokens", 10, "outputTokens", 5, "source", "real")));
        when(constraintExtractor.renderSection(any(), any(), any()))
                .thenReturn("[Constraints] 不要动 production 配置");

        SummaryProvider.SummaryResult result = provider.summarize(request());

        assertThat(result.provider()).isEqualTo("llm");
        assertThat(result.summary()).doesNotContain("model invented a constraint");
        assertThat(result.summary()).contains("[Constraints] 不要动 production 配置");
    }

    @Test
    void priorSummaryConstraintsAreStrippedBeforeAgentCall() {
        givenSession(boundSession());
        givenLease();
        when(agentClient.summarize(any(), anyLong())).thenReturn(new AgentSummarizeClient.Result(
                "[Goal] g\n[Recent] r", Map.of("inputTokens", 1, "outputTokens", 1, "source", "real")));

        provider.summarize(request("[Goal] keep\n[Constraints] secret rule\n[Recent] r"));

        org.mockito.ArgumentCaptor<Map<String, Object>> captor = org.mockito.ArgumentCaptor.forClass(Map.class);
        verify(agentClient).summarize(captor.capture(), anyLong());
        String prior = String.valueOf(captor.getValue().get("priorSummary"));
        assertThat(prior).contains("[Goal] keep");
        assertThat(prior).doesNotContain("[Constraints]");
        assertThat(prior).doesNotContain("secret rule");
    }

    private void givenSession(Session session) {
        when(sessionRepository.findById(UUID.fromString(SESSION_ID))).thenReturn(Optional.of(session));
    }

    private void givenLease() {
        when(credentialLeases.issue(anyString(), anyString(), anyString(), any(), anyString(),
                anyString(), anyString(), any(), any()))
                .thenReturn(new ProviderCredentialLeaseService.IssuedLease("pl_test", Instant.now().plusSeconds(60)));
    }

    private Session boundSession() {
        Session session = new Session(WORKSPACE_ID, USER_ID, "t");
        session.setId(UUID.fromString(SESSION_ID));
        session.setModelProvider("deepseek");
        session.setModelName("m1");
        session.setProviderConnectionId("44444444-4444-4444-4444-444444444444");
        session.setConnectionRevision(1L);
        return session;
    }

    private SummaryProvider.SummaryRequest request() {
        return request(null);
    }

    private SummaryProvider.SummaryRequest request(String previousSummary) {
        ObjectMapper mapper = new ObjectMapper();
        ObjectNode context = mapper.createObjectNode();
        var messages = context.putArray("messages");
        messages.addObject().put("role", "human").put("content", "hello world");
        messages.addObject().put("role", "ai").put("content", "hi");
        return new SummaryProvider.SummaryRequest(
                SESSION_ID, WORKSPACE_ID, USER_ID, context, previousSummary, 0L, "auto", null);
    }
}
