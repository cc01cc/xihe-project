package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * PLAN-0344 T1.2：job-output 续看端点的对外契约（LOST/EXPIRED/归属/分页）。
 */
class WorkspaceJobOutputIntegrationTest extends AbstractIntegrationTest {

    @MockitoBean
    private RuntimeJobClient runtimeJobClient;

    @Autowired
    private JobStateService jobStateService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceJobRepository workspaceJobs;

    @Autowired
    private ObjectMapper objectMapper;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;

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
        sessionId = sessionRepository.save(session).getId().toString();
    }

    private UUID newJob(String runtimeJobId) {
        UUID jobId = UUID.randomUUID();
        WorkspaceJob job = new WorkspaceJob();
        job.setId(jobId);
        job.setWorkspaceId(UUID.fromString(workspaceId));
        job.setUserId(UUID.fromString(userId));
        job.setSessionId(UUID.fromString(sessionId));
        job.setSource("ui");
        job.setScope("workspace");
        job.setIdempotencyKey("output-" + jobId);
        job.setInputHash("output-hash");
        job.setStatus("running");
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("workspaceId", workspaceId);
        state.put("userId", userId);
        state.put("sessionId", sessionId);
        state.put("scope", "workspace");
        state.put("status", "running");
        state.put("jobId", runtimeJobId);
        try {
            job.setState(new ObjectMapper().writeValueAsString(state));
        } catch (Exception e) {
            throw new AssertionError("Workspace Job fixture state must serialize", e);
        }
        job.setRuntimeJobId(runtimeJobId);
        job.setStartedAt(Instant.now());
        workspaceJobs.saveAndFlush(job);
        return jobId;
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private ResponseEntity<Map> getOutput(UUID jobId, String token, String query) {
        return restTemplate.exchange(
                baseUrl + "/api/v1/workspaces/" + workspaceId + "/jobs/" + jobId + "/output" + query,
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
        UUID domainJobId = newJob(jobId);
        when(runtimeJobClient.jobOutput(eq(workspaceId), eq(jobId), eq("stdout"), any(), any()))
                .thenReturn(chunk(0, 6, 12, false, "你好"));

        ResponseEntity<Map> ok = getOutput(domainJobId, authToken, "");
        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals(domainJobId.toString(), ok.getBody().get("jobId"));
        assertEquals(jobId, ok.getBody().get("runtimeJobId"));
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
        ResponseEntity<Map> clamped = getOutput(domainJobId, authToken, "?stream=stderr&offset=3&limit=99999999");
        assertEquals(HttpStatus.OK, clamped.getStatusCode());
        ArgumentCaptor<Long> clampedLimit = ArgumentCaptor.forClass(Long.class);
        verify(runtimeJobClient).jobOutput(eq(workspaceId), eq(jobId), eq("stderr"),
                eq(3L), clampedLimit.capture());
        assertEquals(1024 * 1024L, clampedLimit.getValue(), "上限 1MiB");
    }

    @Test
    void mapsLostAndExpiredExplicitly() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId);
        when(runtimeJobClient.jobOutput(eq(workspaceId), eq(jobId), anyString(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobOutputResult(false, false, null));

        ResponseEntity<Map> lost = getOutput(domainJobId, authToken, "");
        assertEquals(HttpStatus.CONFLICT, lost.getStatusCode());
        assertEquals("JOB_OUTPUT_LOST", lost.getBody().get("code"));

        // 终态档案 + 输出缺失 → EXPIRED
        Map<String, Object> terminal = new LinkedHashMap<>();
        terminal.put("status", "succeeded");
        jobStateService.upsertById(domainJobId, terminal);
        ResponseEntity<Map> expired = getOutput(domainJobId, authToken, "");
        assertEquals(HttpStatus.CONFLICT, expired.getStatusCode());
        assertEquals("JOB_OUTPUT_EXPIRED", expired.getBody().get("code"));
    }

    @Test
    void destroyOrphanedStaysLostNotExpired() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId);
        when(runtimeJobClient.jobOutput(eq(workspaceId), eq(jobId), anyString(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobOutputResult(false, false, null));
        // destroy 流程把 running 档案收口为 orphaned（decision #4/P1-2）；
        // 续看必须报 LOST（job 随容器丢失），而不是 EXPIRED。
        Map<String, Object> orphaned = new LinkedHashMap<>();
        orphaned.put("status", "orphaned");
        orphaned.put("cancelReason", "destroy_orphan");
        jobStateService.upsertById(domainJobId, orphaned);

        ResponseEntity<Map> lost = getOutput(domainJobId, authToken, "");
        assertEquals(HttpStatus.CONFLICT, lost.getStatusCode());
        assertEquals("JOB_OUTPUT_LOST", lost.getBody().get("code"));
    }

    @Test
    void hidesForeignAndMissingArchives() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId);

        // 无关用户：404（不泄露存在性）
        String otherEmail = "job-out-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other"), AuthResponse.class);
        String otherToken = restTemplate.postForEntity(baseUrl + "/api/v1/auth/login",
                Map.of("email", otherEmail, "password", TestDataFactory.PASSWORD), Map.class)
                .getBody().get("accessToken").toString();
        ResponseEntity<Map> foreign = getOutput(domainJobId, otherToken, "");
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode());

        // No domain Job row is exposed as not found.
        ResponseEntity<Map> missing = getOutput(UUID.randomUUID(), authToken, "");
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("JOB_ARCHIVE_NOT_FOUND", missing.getBody().get("code"));
    }

    @Test
    void rejectsUnreachableRuntimeAndBadStream() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId);
        when(runtimeJobClient.jobOutput(eq(workspaceId), eq(jobId), anyString(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobOutputResult(false, true, null));

        // 测试基础 restTemplate 把 5xx 视为异常（生产行为一致）
        try {
            getOutput(domainJobId, authToken, "");
            fail("502 must be raised for an unreachable Runtime");
        } catch (org.springframework.web.client.HttpServerErrorException e) {
            assertEquals(HttpStatus.BAD_GATEWAY, e.getStatusCode());
        }

        ResponseEntity<Map> badStream = getOutput(domainJobId, authToken, "?stream=merged");
        assertEquals(HttpStatus.BAD_REQUEST, badStream.getStatusCode());
    }
}
