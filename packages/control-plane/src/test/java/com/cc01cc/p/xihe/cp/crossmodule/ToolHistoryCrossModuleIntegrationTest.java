package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.context.service.ContextEventPayloadSafety;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.mockito.Mockito;

import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0381 T4.4/V15：真实 CP HTTP ingress → H2 持久化 → Projection → snapshot
 * 的跨模块证据（T2 档，WireMock Agent，无 Docker；由 integration-test-t2.sh 的
 * {@code -Dtest="crossmodule/*"} 白名单自动纳入）。
 *
 * 覆盖：大输出 bounded preview 与 artifactRef 穿透（V5/V15）、新旧 payload 双
 * 形状（V1）、同 call id 配对（V2）、下一轮 snapshot 等价恢复且事件不再增长
 * （V10/V13）、重投幂等不产生第二组消息（V19）、事件 payload 与 snapshot 可对账。
 */
class ToolHistoryCrossModuleIntegrationTest extends AbstractWireMockTest {

    /** /internal/v1 only accepts the service Bearer (SecurityConfig hasRole INTERNAL_SERVICE). */
    private static final String SERVICE_TOKEN = "dev-token-not-secure";

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-url", () -> "http://localhost:" + wireMock.port() + "/internal/v1/agent/chat");
        registry.add("cp.agent-base-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private SessionRepository sessionRepository;
    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private String token;
    private String userId;
    private String workspaceId;

    @BeforeEach
    void setUpContext() {
        // 父类 AbstractWireMockTest 的 @BeforeEach 已负责 restTemplate/wireMock。
        token = registerAndLogin();
        userId = jwtTokenProvider.getUserIdFromToken(token);
        Workspace ws = workspaceFixture.createOwnedWorkspace("Tool history test", userId);
        workspaceId = ws.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        token = jwtTokenProvider.createAccessToken(userId, jwtTokenProvider.getEmailFromToken(token), "USER", workspaceId, 0);

    }

    private String newSession() {
        String sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "tool history " + sessionId);
        session.setId(UUID.fromString(sessionId));
        sessionRepository.saveAndFlush(session);
        return sessionId;
    }

    private void postEvent(String sessionId, String type, Map<String, Object> payload) {
        ResponseEntity<String> response = restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/events"),
                HttpMethod.POST,
                entityWithAuth(Map.of("type", type, "payload", payload), SERVICE_TOKEN),
                String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), "event append must be accepted");
    }

    private JsonNode getSnapshot(String sessionId) throws Exception {
        ResponseEntity<String> response = restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/snapshot?afterSequence=0"),
                HttpMethod.GET,
                entityWithAuth(null, SERVICE_TOKEN),
                String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        return objectMapper.readTree(response.getBody());
    }

    @Test
    void boundedToolResultRoundTripsThroughRealHttpIngressAndSnapshot() throws Exception {
        String sessionId = newSession();
        String runId = "run-http-" + UUID.randomUUID();
        // Agent M2 gate-ON 事件形状：preview 已有界（≤4096 + 标记），ref/status 齐全。
        String preview = "x".repeat(3990)
                + "\n[output truncated: first 4000 of 90000 chars; no retained copy — re-query with a narrower range]";
        assertTrue(preview.length() <= 4096, "fixture preview must respect the frozen bound");

        postEvent(sessionId, "tool.called", Map.of(
                "schemaVersion", 2,
                "toolCallId", "tc-http-1",
                "toolName", "execute_command",
                "arguments", Map.of("command", "build")
        ));
        postEvent(sessionId, "tool.result", Map.of(
                "schemaVersion", 2,
                "toolCallId", "tc-http-1",
                "toolName", "execute_command",
                "status", "completed",
                "result", Map.of(
                        "preview", preview,
                        "truncated", true,
                        "artifactRef", "art-http-1",
                        "sizeBytes", 2_000_000,
                        "status", "available"
                )
        ));

        JsonNode snapshot = getSnapshot(sessionId);
        JsonNode messages = snapshot.get("messages");
        assertEquals(2, messages.size(), "one declaration + one result");
        // V2：同一 toolCallId 配对，不靠邻接猜测。
        assertEquals("tc-http-1", messages.get(0).path("tool_calls").get(0).path("call_id").asText());
        assertEquals("tc-http-1", messages.get(1).path("tool_call_id").asText());
        // PLAN-0649 M4（T4.3）：「有界 preview 穿透」是 PLAN-0381 的旧口径，已被 PLAN-0510
        // 决策 #6 的消毒闸取代——工具正文（含 preview/artifactRef/sizeBytes）不再进入 durable
        // history，也不进入模型投影，投影里恒为 CP 占位符。有界性仍须以「没有超限正文」成立，
        // 配对/状态等元数据不受影响（正文被 withhold ≠ 记录被删除）。
        assertEquals(ContextEventPayloadSafety.UNSAFE_TOOL_RESULT_PLACEHOLDER,
                messages.get(1).path("content").asText(),
                "the projection carries the CP placeholder, not the tool body");
        assertFalse(messages.get(1).path("content").asText().contains("no retained copy"),
                "no fragment of the tool body may survive into the projection");
        assertTrue(messages.get(1).path("content").asText().length() < 4096);
        assertTrue(messages.get(1).path("truncated").isMissingNode(),
                "body-derived metadata is withheld together with the body");
        assertTrue(messages.get(1).path("artifact_ref").isMissingNode());
        assertEquals("completed", messages.get(1).path("status").asText());

        // V15: read DTO payload is an object even though the persistence column is JSON text.
        ResponseEntity<String> eventsResponse = restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/events?afterSequence=0"),
                HttpMethod.GET, entityWithAuth(null, SERVICE_TOKEN), String.class);
        JsonNode events = objectMapper.readTree(eventsResponse.getBody());
        assertEquals(2, events.size());
        assertEquals("tool.result", events.get(1).path("type").asText());
        JsonNode storedPayload = events.get(1).path("payload");
        assertTrue(storedPayload.isObject(), "read DTO payload must not be double-encoded JSON");
        // PLAN-0649 M4（T4.3）：durable payload 落的是占位符字符串，原 preview 对象不再存在。
        assertTrue(storedPayload.path("result").isTextual(),
                "the durable result is the CP placeholder string");
        assertEquals(ContextEventPayloadSafety.UNSAFE_TOOL_RESULT_PLACEHOLDER,
                storedPayload.path("result").asText(),
                "the durable payload keeps the CP placeholder, not the tool body");
        assertFalse(storedPayload.toString().contains("no retained copy"));

        // V10：下一轮恢复 = 再取 snapshot 得到等价序列，且无新增事件（不重执行、不重复注入）。
        JsonNode round2 = getSnapshot(sessionId);
        assertEquals(snapshot.get("messages").toString(), round2.get("messages").toString());
        ResponseEntity<String> eventsAgain = restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/events?afterSequence=0"),
                HttpMethod.GET, entityWithAuth(null, SERVICE_TOKEN), String.class);
        assertEquals(events.size(), objectMapper.readTree(eventsAgain.getBody()).size(),
                "history read must never append events");
    }

    @Test
    void legacyPayloadsStillProjectWithPairing() throws Exception {
        String sessionId = newSession();
        postEvent(sessionId, "tool.called", Map.of(
                "call_id", "tc-legacy-1",
                "tool_name", "read_file",
                "tool_input", Map.of("path", "a.txt")
        ));
        postEvent(sessionId, "tool.result", Map.of(
                "call_id", "tc-legacy-1",
                "tool_name", "read_file",
                "result", "legacy bounded output"
        ));

        JsonNode messages = getSnapshot(sessionId).get("messages");
        assertEquals(2, messages.size());
        assertEquals("tc-legacy-1", messages.get(0).path("tool_calls").get(0).path("call_id").asText());
        assertEquals("tc-legacy-1", messages.get(1).path("tool_call_id").asText());
        // PLAN-0649 M4（T4.3）：legacy payload 的正文同样被消毒闸 withhold（旧断言按 PLAN-0381
        // 期望原文穿透）。配对与缺省状态不受影响——正文不落库不等于记录丢失。
        assertEquals(ContextEventPayloadSafety.UNSAFE_TOOL_RESULT_PLACEHOLDER,
                messages.get(1).path("content").asText());
        assertFalse(messages.get(1).path("content").asText().contains("legacy bounded output"));
        // legacy 缺 status → 读者缺省 completed（不得伪造失败）。
        assertEquals("completed", messages.get(1).path("status").asText());
    }

    /**
     * PLAN-0649 M4（T4.3 新增，正反两面）：
     *
     * <p><b>正向</b>：形状合规的 {@code refusalCode} 必须穿透三个承载面（写入后 durable payload →
     * 事件读 DTO → 投影/快照），且 {@code status=failed} 随之保留；<b>反向</b>：同一事件的正文
     * （{@code result}）不得穿透——任何一面出现工具正文都算失败。这条正是 PLAN-0649 的端到端
     * 主张：码是元数据可以走，正文是内容一步也不许走。</p>
     */
    @Test
    void refusalCodePenetratesWhileTheToolBodyStaysWithheld() throws Exception {
        String sessionId = newSession();
        String refusalCode = "DELEGATION_LIMIT_EXCEEDED";
        String body = "REFUSAL-BODY-PRIVATE " + "z".repeat(5_000);

        postEvent(sessionId, "tool.called", Map.of(
                "schemaVersion", 2,
                "toolCallId", "tc-refused-1",
                "toolName", "spawn_agent",
                "arguments", Map.of("prompt", "child task")
        ));
        postEvent(sessionId, "tool.result", Map.of(
                "schemaVersion", 2,
                "toolCallId", "tc-refused-1",
                "toolName", "spawn_agent",
                "status", "failed",
                "refusalCode", refusalCode,
                "result", Map.of("preview", body, "truncated", true, "artifactRef", "art-refused-1")
        ));

        // 正向：码与失败状态在 durable payload 与投影里都在。
        ResponseEntity<String> eventsResponse = restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/events?afterSequence=0"),
                HttpMethod.GET, entityWithAuth(null, SERVICE_TOKEN), String.class);
        assertEquals(HttpStatus.OK, eventsResponse.getStatusCode());
        JsonNode storedPayload = objectMapper.readTree(eventsResponse.getBody()).get(1).path("payload");
        assertEquals(refusalCode, storedPayload.path("refusalCode").asText(),
                "a shape-valid refusal code must survive the durable sanitizer");
        assertEquals("failed", storedPayload.path("status").asText());

        JsonNode messages = getSnapshot(sessionId).get("messages");
        assertEquals(2, messages.size());
        assertEquals("tc-refused-1", messages.get(1).path("tool_call_id").asText(),
                "pairing still holds for a refused call");
        assertEquals("failed", messages.get(1).path("status").asText(),
                "the authoritative status reaches the projection");

        // 反向：正文在两面都不得出现（连 preview/artifactRef 这类正文派生元数据也不行）。
        for (JsonNode carrier : java.util.List.of(storedPayload, messages)) {
            String text = carrier.toString();
            assertFalse(text.contains("REFUSAL-BODY-PRIVATE"), "tool body leaked into a carrier");
            assertFalse(text.contains("z".repeat(64)), "no run of tool output may survive");
        }
        assertTrue(messages.get(1).path("artifact_ref").isMissingNode(),
                "body-derived metadata is withheld with the body");
        assertEquals(ContextEventPayloadSafety.UNSAFE_TOOL_RESULT_PLACEHOLDER,
                messages.get(1).path("content").asText());
    }

    /** PLAN-0649 M4（T4.3 新增，反例）：不合形状的码在入口就被丢弃，连字符串都不留。 */
    @Test
    void malformedRefusalCodeIsDroppedAtIngressInsteadOfBeingPersisted() throws Exception {
        for (String malformed : java.util.List.of(
                "DELEGATION LIMIT EXCEEDED", "DELEGATION:LIMIT", "拒绝", "delegation_limit", "A".repeat(65))) {
            String sessionId = newSession();
            postEvent(sessionId, "tool.result", Map.of(
                    "schemaVersion", 2,
                    "toolCallId", "tc-bad-code",
                    "toolName", "spawn_agent",
                    "status", "failed",
                    "refusalCode", malformed,
                    "result", "placeholder"
            ));

            ResponseEntity<String> eventsResponse = restTemplate.exchange(
                    url("/internal/v1/context/" + sessionId + "/events?afterSequence=0"),
                    HttpMethod.GET, entityWithAuth(null, SERVICE_TOKEN), String.class);
            JsonNode payload = objectMapper.readTree(eventsResponse.getBody()).get(0).path("payload");
            assertFalse(payload.has("refusalCode"),
                    "a malformed code must not be persisted: " + malformed);
            assertFalse(payload.toString().contains(malformed),
                    "not even the rejected string may be stored: " + malformed);
            assertEquals("failed", payload.path("status").asText(),
                    "the failure itself is still recorded — only the code is dropped");
        }
    }

    @Test
    void redeliveredToolEventsDoNotDuplicateSnapshotMessages() throws Exception {
        String sessionId = newSession();
        Map<String, Object> called = Map.of(
                "schemaVersion", 2,
                "toolCallId", "tc-dup-1",
                "toolName", "grep",
                "arguments", Map.of("pattern", "needle")
        );
        Map<String, Object> result = Map.of(
                "schemaVersion", 2,
                "toolCallId", "tc-dup-1",
                "toolName", "grep",
                "status", "completed",
                "result", Map.of("preview", "hit", "truncated", false)
        );
        for (int delivery = 0; delivery < 2; delivery++) { // relay 重投
            postEvent(sessionId, "tool.called", called);
            postEvent(sessionId, "tool.result", result);
        }

        JsonNode messages = getSnapshot(sessionId).get("messages");
        assertEquals(2, messages.size(), "redelivery must not create a second pair (V19)");
        assertEquals("tc-dup-1", messages.get(0).path("tool_calls").get(0).path("call_id").asText());
        assertEquals("tc-dup-1", messages.get(1).path("tool_call_id").asText());
        // 事件层仍是 4 条（append 不去重）——幂等发生在 projection，对账可区分两层。
        ResponseEntity<String> eventsResponse = restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/events?afterSequence=0"),
                HttpMethod.GET, entityWithAuth(null, SERVICE_TOKEN), String.class);
        assertEquals(4, objectMapper.readTree(eventsResponse.getBody()).size());
    }

    @Test
    void oversizedToolArgumentsProjectAsBoundedMarkerOverHttp() throws Exception {
        String sessionId = newSession();
        postEvent(sessionId, "tool.called", Map.of(
                "schemaVersion", 2,
                "toolCallId", "tc-args-1",
                "toolName", "write_file",
                "arguments", Map.of("content", "y".repeat(20000))
        ));

        JsonNode arguments = getSnapshot(sessionId).get("messages").get(0)
                .path("tool_calls").get(0).path("arguments");
        assertTrue(arguments.path("__xihe_truncated__").asBoolean(false),
                "oversized args must degrade to the explicit marker over HTTP");
        assertTrue(objectMapper.writeValueAsString(arguments).length() <= 4096,
                "argument marker must stay within the frozen bound");
    }

    @TestConfiguration
    static class TestMockConfig {

        @Bean
        @Primary
        com.cc01cc.p.xihe.cp.chat.SseEmitterManager testSseEmitterManager() {
            return Mockito.mock(com.cc01cc.p.xihe.cp.chat.SseEmitterManager.class);
        }
    }
}
