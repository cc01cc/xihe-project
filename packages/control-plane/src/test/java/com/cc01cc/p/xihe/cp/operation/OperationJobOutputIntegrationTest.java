package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * PLAN-0344 T1.2：job-output 续看端点的对外契约（LOST/EXPIRED/归属/分页）。
 */
class OperationJobOutputIntegrationTest extends AbstractIntegrationTest {

    @MockitoBean
    private RuntimeJobClient runtimeJobClient;

    @Autowired
    private JobStateService jobStateService;

    @Autowired
    private OperationService operationService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private ObjectMapper objectMapper;

    private String authToken;
    private String userId;
    private String workspaceId;
    private UUID operationId;

    @BeforeEach
    void setUp() {
        String email = "job-out-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "JobOutputTest");
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = response.getBody().getAccessToken();
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Job Output Session");
        session.setId(UUID.randomUUID());
        String sessionId = sessionRepository.save(session).getId().toString();
        operationId = operationService.startOperation(userId, sessionId, workspaceId, null, null,
                "chat", "ui", "user", userId, "job-out-" + UUID.randomUUID(),
                "Job output test").operationId();
    }

    private UUID newJobItem(String jobId) {
        OperationItem item = operationService.appendItem(operationId, UUID.randomUUID().toString(),
                null, "tool_call", "start_background_process", "mcp", null, null, null);
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("jobId", jobId);
        incoming.put("workspaceId", workspaceId);
        incoming.put("status", "running");
        jobStateService.upsert(item.getId(), incoming);
        return item.getId();
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private ResponseEntity<Map> getOutput(UUID itemId, String token, String query) {
        return restTemplate.exchange(
                baseUrl + "/api/v1/operations/items/" + itemId + "/job-output" + query,
                HttpMethod.GET, new HttpEntity<>(authHeaders(token)), Map.class);
    }

    private RuntimeJobClient.JobOutputResult chunk(long offset, long nextOffset, long size,
                                                   boolean truncated, String data) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("available", true);
        body.put("offset", offset);
        body.put("nextOffset", nextOffset);
        body.put("sizeBytes", size);
        body.put("truncated", truncated);
        body.put("data", data);
        body.put("jobStatus", "running");
        return new RuntimeJobClient.JobOutputResult(true, false, objectMapper.valueToTree(body));
    }

    @Test
    void returnsChunkAndAppliesDefaultAndMaxLimit() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId);
        when(runtimeJobClient.jobOutput(eq(workspaceId), eq(jobId), eq("stdout"), any(), any()))
                .thenReturn(chunk(0, 6, 12, false, "你好"));

        ResponseEntity<Map> ok = getOutput(itemId, authToken, "");
        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals(jobId, ok.getBody().get("jobId"));
        assertEquals(6, ok.getBody().get("nextOffset"));
        assertEquals(12, ok.getBody().get("sizeBytes"));
        assertEquals("你好", ok.getBody().get("data"));
        assertEquals("running", ok.getBody().get("jobStatus"));

        ArgumentCaptor<Long> limit = ArgumentCaptor.forClass(Long.class);
        verify(runtimeJobClient).jobOutput(eq(workspaceId), eq(jobId), eq("stdout"),
                eq(0L), limit.capture());
        assertEquals(64 * 1024L, limit.getValue(), "默认 64KiB");

        // 超上限请求被夹到 1MiB
        when(runtimeJobClient.jobOutput(eq(workspaceId), eq(jobId), eq("stderr"), any(), any()))
                .thenReturn(chunk(3, 9, 12, true, "好"));
        ResponseEntity<Map> clamped = getOutput(itemId, authToken, "?stream=stderr&offset=3&limit=99999999");
        assertEquals(HttpStatus.OK, clamped.getStatusCode());
        ArgumentCaptor<Long> clampedLimit = ArgumentCaptor.forClass(Long.class);
        verify(runtimeJobClient).jobOutput(eq(workspaceId), eq(jobId), eq("stderr"),
                eq(3L), clampedLimit.capture());
        assertEquals(1024 * 1024L, clampedLimit.getValue(), "上限 1MiB");
    }

    @Test
    void mapsLostAndExpiredExplicitly() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId);
        when(runtimeJobClient.jobOutput(eq(workspaceId), eq(jobId), anyString(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobOutputResult(false, false, null));

        ResponseEntity<Map> lost = getOutput(itemId, authToken, "");
        assertEquals(HttpStatus.CONFLICT, lost.getStatusCode());
        assertEquals("JOB_OUTPUT_LOST", lost.getBody().get("code"));

        // 终态档案 + 输出缺失 → EXPIRED
        Map<String, Object> terminal = new LinkedHashMap<>();
        terminal.put("status", "succeeded");
        jobStateService.upsert(itemId, terminal);
        ResponseEntity<Map> expired = getOutput(itemId, authToken, "");
        assertEquals(HttpStatus.CONFLICT, expired.getStatusCode());
        assertEquals("JOB_OUTPUT_EXPIRED", expired.getBody().get("code"));
    }

    @Test
    void hidesForeignAndMissingArchives() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId);

        // 无关用户：404（不泄露存在性）
        String otherEmail = "job-out-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other"), AuthResponse.class);
        String otherToken = restTemplate.postForEntity(baseUrl + "/api/v1/auth/login",
                Map.of("email", otherEmail, "password", TestDataFactory.PASSWORD), Map.class)
                .getBody().get("accessToken").toString();
        ResponseEntity<Map> foreign = getOutput(itemId, otherToken, "");
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode());

        // 无档案的 item：404
        OperationItem plain = operationService.appendItem(operationId,
                UUID.randomUUID().toString(), null, "tool_call", "read_file", "mcp", null, null, null);
        ResponseEntity<Map> missing = getOutput(plain.getId(), authToken, "");
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("JOB_ARCHIVE_NOT_FOUND", missing.getBody().get("code"));
    }

    @Test
    void rejectsUnreachableRuntimeAndBadStream() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId);
        when(runtimeJobClient.jobOutput(eq(workspaceId), eq(jobId), anyString(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobOutputResult(false, true, null));

        // 测试基础 restTemplate 把 5xx 视为异常（生产行为一致）
        try {
            getOutput(itemId, authToken, "");
            fail("502 must be raised for an unreachable Runtime");
        } catch (org.springframework.web.client.HttpServerErrorException e) {
            assertEquals(HttpStatus.BAD_GATEWAY, e.getStatusCode());
        }

        ResponseEntity<Map> badStream = getOutput(itemId, authToken, "?stream=merged");
        assertEquals(HttpStatus.BAD_REQUEST, badStream.getStatusCode());
    }
}
