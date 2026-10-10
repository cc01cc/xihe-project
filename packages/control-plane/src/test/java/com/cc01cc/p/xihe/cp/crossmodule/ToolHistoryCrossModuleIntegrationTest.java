package com.cc01cc.p.xihe.cp.crossmodule;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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
    private WorkspaceUserRepository workspaceUserRepository;
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
        Workspace ws = workspaceRepository.save(new Workspace("Tool history test", userId));
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        token = jwtTokenProvider.createAccessToken(userId, jwtTokenProvider.getEmailFromToken(token), "USER", workspaceId);

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
        // V5/V15：bounded preview 原样穿透，snapshot 无超限正文。
        assertEquals(preview, messages.get(1).path("content").asText());
        assertTrue(messages.get(1).path("content").asText().length() <= 4096);
        assertTrue(messages.get(1).path("truncated").asBoolean(false));
        assertEquals("art-http-1", messages.get(1).path("artifact_ref").asText());
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
        assertEquals(preview, storedPayload.path("result").path("preview").asText());

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
        assertEquals("legacy bounded output", messages.get(1).path("content").asText());
        // legacy 缺 status → 读者缺省 completed（不得伪造失败）。
        assertEquals("completed", messages.get(1).path("status").asText());
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
