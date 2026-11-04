package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0666 M1b: the recorder's contract at the seams (D3 dispatch-time collection, D5 workspace
 * switch, fail-open). The pure hashing is covered by {@link ContextFingerprintCalculatorTest}; here
 * we pin what gets collected, that volatile per-dispatch values are excluded, and that nothing can
 * throw into the dispatch path.
 */
class ContextFingerprintRecorderTest {

    private static final String RUN_ID = "11111111-1111-4111-8111-111111111111";
    private static final String SESSION_ID = "22222222-2222-4222-8222-222222222222";
    private static final String BRANCH_ID = "33333333-3333-4333-8333-333333333333";
    private static final String USER_ID = "44444444-4444-4444-8444-444444444444";
    private static final String WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";

    private ChatRunRepository chatRunRepository;
    private ContextProjectionService projectionService;
    private ConfigService configService;
    private ContextFingerprintRecorder recorder;

    @BeforeEach
    void setUp() {
        chatRunRepository = mock(ChatRunRepository.class);
        projectionService = mock(ContextProjectionService.class);
        configService = mock(ConfigService.class);
        when(chatRunRepository.recordContextFingerprint(org.mockito.ArgumentMatchers.any(),
                anyString())).thenReturn(1);
        recorder = new ContextFingerprintRecorder(
                chatRunRepository, projectionService, configService, new ObjectMapper());
    }

    private static Map<String, Object> outbound() {
        Map<String, Object> outbound = new LinkedHashMap<>();
        outbound.put("sessionId", SESSION_ID);
        outbound.put("content", "hello");
        outbound.put("runId", RUN_ID);
        outbound.put("requestId", "request-1");
        outbound.put("credentialLease", "secret-token");
        outbound.put("toolMode", "auto");
        outbound.put("images", List.of(Map.of("id", "img-1")));
        return outbound;
    }

    private static ContextFingerprintRecorder.RecordInput recordInput() {
        Map<String, Object> componentSources = new LinkedHashMap<>();
        componentSources.put("agent_memory", "remembered fact");
        ObjectNode template = new ObjectMapper().createObjectNode().put("templateId", "tpl-1");
        ObjectNode skills = new ObjectMapper().createObjectNode().put("status", "empty");
        return new ContextFingerprintRecorder.RecordInput(
                RUN_ID, SESSION_ID, BRANCH_ID, USER_ID, WORKSPACE_ID, template, skills, "hello",
                componentSources, "system instructions",
                Map.of("rag", Map.of("topK", "5")), Map.of(), outbound());
    }

    @Test
    void recordsAllLayersAndKeepsToolsUnavailable() {
        when(configService.resolveDomain(eq("context-policy"), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any())).thenReturn(Map.of("defaults", "{}"));
        when(projectionService.currentHistoryMessages(SESSION_ID, BRANCH_ID))
                .thenReturn(new ObjectMapper().createArrayNode());
        org.mockito.ArgumentCaptor<String> json = org.mockito.ArgumentCaptor.forClass(String.class);
        recorder.recordFirstDispatch(recordInput());
        verify(chatRunRepository).recordContextFingerprint(org.mockito.ArgumentMatchers.any(), json.capture());
        try {
            JsonNode document = new ObjectMapper().readTree(json.getValue());
            assertEquals("ok", document.path("status").asText());
            assertEquals(true, document.path("enabled").asBoolean());
            assertEquals(1, document.path("dispatchAttempt").asInt());
            assertEquals("agent_side", document.path("layers").path("tools").path("unavailable").asText());
            assertTrue(document.path("layers").path("history").has("hash"));
            assertTrue(document.path("layers").path("memory").has("hash"));
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
    }

    @Test
    void volatileDispatchFieldsNeverEnterTheOutboundHash() {
        when(configService.resolveDomain(eq("context-policy"), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any())).thenReturn(Map.of("defaults", "{}"));
        when(projectionService.currentHistoryMessages(SESSION_ID, BRANCH_ID))
                .thenReturn(new ObjectMapper().createArrayNode());
        Map<String, Object> volatileChanged = new LinkedHashMap<>(outbound());
        volatileChanged.put("runId", "99999999-9999-4999-8999-999999999999");
        volatileChanged.put("requestId", "request-2");
        volatileChanged.put("credentialLease", "another-secret");
        ContextFingerprintRecorder.RecordInput second = new ContextFingerprintRecorder.RecordInput(
                RUN_ID, SESSION_ID, BRANCH_ID, USER_ID, WORKSPACE_ID,
                recordInput().templateSnapshot(), recordInput().skillsSnapshot(), "hello",
                recordInput().componentSources(), recordInput().instructions(),
                recordInput().userOverrides(), recordInput().workspaceOverrides(), volatileChanged);

        org.mockito.ArgumentCaptor<String> json = org.mockito.ArgumentCaptor.forClass(String.class);
        recorder.recordFirstDispatch(recordInput());
        recorder.recordFirstDispatch(second);
        verify(chatRunRepository, org.mockito.Mockito.times(2))
                .recordContextFingerprint(org.mockito.ArgumentMatchers.any(), json.capture());
        List<String> written = json.getAllValues();
        try {
            JsonNode first = new ObjectMapper().readTree(written.get(0));
            JsonNode secondDoc = new ObjectMapper().readTree(written.get(1));
            assertEquals(first.path("outbound").path("hash").asText(),
                    secondDoc.path("outbound").path("hash").asText(),
                    "runId/requestId/credentialLease are per-dispatch, not context");
            assertFalse(first.path("outbound").path("hash").asText().isEmpty());
            String serialized = first.toString();
            assertFalse(serialized.contains("secret-token"), "auth material is never stored, only hashed");
            assertFalse(serialized.contains("another-secret"));
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
    }

    @Test
    void workspaceSwitchStoresAnExplicitDisabledDocument() {
        when(configService.resolveDomain(eq("context-policy"), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any()))
                .thenReturn(Map.of("defaults", "{\"fingerprintEnabled\":false}"));
        org.mockito.ArgumentCaptor<String> json = org.mockito.ArgumentCaptor.forClass(String.class);
        recorder.recordFirstDispatch(recordInput());
        verify(chatRunRepository).recordContextFingerprint(org.mockito.ArgumentMatchers.any(), json.capture());
        try {
            JsonNode document = new ObjectMapper().readTree(json.getValue());
            assertEquals(false, document.path("enabled").asBoolean());
            assertEquals("disabled", document.path("status").asText());
            assertEquals("workspace_disabled", document.path("reason").asText());
            assertFalse(document.has("layers"), "a disabled workspace does not pretend to have data");
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
    }

    @Test
    void unreadableHistoryDegradesOnlyThatLayer() {
        when(configService.resolveDomain(eq("context-policy"), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any())).thenReturn(Map.of("defaults", "{}"));
        when(projectionService.currentHistoryMessages(SESSION_ID, BRANCH_ID))
                .thenThrow(new IllegalStateException("projection unreadable"));
        org.mockito.ArgumentCaptor<String> json = org.mockito.ArgumentCaptor.forClass(String.class);
        recorder.recordFirstDispatch(recordInput());
        verify(chatRunRepository).recordContextFingerprint(org.mockito.ArgumentMatchers.any(), json.capture());
        try {
            JsonNode document = new ObjectMapper().readTree(json.getValue());
            assertEquals("ok", document.path("status").asText(),
                    "one unreadable layer must not blank the whole fingerprint");
            assertEquals("history_unreadable",
                    document.path("layers").path("history").path("unavailable").asText());
            assertTrue(document.path("layers").path("memory").has("hash"));
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
    }

    @Test
    void calculatorFailureIsWrittenAsErrorAndNeverThrows() {
        when(configService.resolveDomain(eq("context-policy"), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any())).thenReturn(Map.of("defaults", "{}"));
        when(projectionService.currentHistoryMessages(SESSION_ID, BRANCH_ID))
                .thenReturn(new ObjectMapper().createArrayNode());
        Map<String, Object> brokenOutbound = new LinkedHashMap<>(outbound());
        brokenOutbound.put("unsupported", new Object());
        ContextFingerprintRecorder.RecordInput broken = new ContextFingerprintRecorder.RecordInput(
                RUN_ID, SESSION_ID, BRANCH_ID, USER_ID, WORKSPACE_ID,
                recordInput().templateSnapshot(), recordInput().skillsSnapshot(), "hello",
                recordInput().componentSources(), recordInput().instructions(),
                recordInput().userOverrides(), recordInput().workspaceOverrides(), brokenOutbound);
        org.mockito.ArgumentCaptor<String> json = org.mockito.ArgumentCaptor.forClass(String.class);
        recorder.recordFirstDispatch(broken);
        verify(chatRunRepository, org.mockito.Mockito.atLeast(1))
                .recordContextFingerprint(org.mockito.ArgumentMatchers.any(), json.capture());
        try {
            JsonNode last = new ObjectMapper().readTree(json.getAllValues().getLast());
            assertEquals("error", last.path("status").asText());
            assertEquals("HASH_FAILED", last.path("reasonCode").asText());
            assertEquals(true, last.path("enabled").asBoolean(), "fail-open is not 'off'");
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
    }

    @Test
    void writeFailureIsSwallowed() {
        when(configService.resolveDomain(eq("context-policy"), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any())).thenReturn(Map.of("defaults", "{}"));
        when(projectionService.currentHistoryMessages(SESSION_ID, BRANCH_ID))
                .thenReturn(new ObjectMapper().createArrayNode());
        when(chatRunRepository.recordContextFingerprint(org.mockito.ArgumentMatchers.any(), anyString()))
                .thenThrow(new IllegalStateException("db down"));
        recorder.recordFirstDispatch(recordInput());
    }

    @Test
    void blankRunIdIsSkippedWithoutTouchingTheDatabase() {
        ContextFingerprintRecorder.RecordInput blank = new ContextFingerprintRecorder.RecordInput(
                " ", SESSION_ID, BRANCH_ID, USER_ID, WORKSPACE_ID, null, null, "x",
                Map.of(), null, Map.of(), Map.of(), Map.of());
        recorder.recordFirstDispatch(blank);
        verify(chatRunRepository, never()).recordContextFingerprint(org.mockito.ArgumentMatchers.any(), anyString());
    }
}
