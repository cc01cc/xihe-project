package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJobHistory;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.client.HttpServerErrorException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0366 T1.4：单 job 取消端点的对外契约（幂等/未确认/失联/不可达/归属/审计）。
 * 覆盖 spec §二「响应与状态映射」全部分支与决策 #14 的 `job.cancel` 事件。
 */
class WorkspaceJobCancelIntegrationTest extends AbstractIntegrationTest {

    @MockitoBean
    private RuntimeJobClient runtimeJobClient;

    @Autowired
    private JobStateService jobStateService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private WorkspaceJobRepository workspaceJobs;

    @Autowired
    private WorkspaceJobHistoryRepository jobHistory;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;

    @BeforeEach
    void setUp() {
        String email = "job-cancel-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "JobCancelTest");
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = response.getBody().getAccessToken();
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Job Cancel Session");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();
        // run_id 有 FK（→ chat_runs），审计 payload 的 runId 必须来自真实 run 行。
        runId = UUID.randomUUID().toString();
        chatRunRepository.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "none", "running"));
    }

    private UUID newJob(String runtimeJobId, String status) {
        UUID jobId = UUID.randomUUID();
        WorkspaceJob job = new WorkspaceJob();
        job.setId(jobId);
        job.setWorkspaceId(UUID.fromString(workspaceId));
        job.setUserId(UUID.fromString(userId));
        job.setSessionId(UUID.fromString(sessionId));
        job.setSource("ui");
        job.setScope("workspace");
        job.setStatus(status);
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("workspaceId", workspaceId);
        state.put("userId", userId);
        state.put("sessionId", sessionId);
        state.put("scope", "workspace");
        state.put("status", status);
        state.put("jobId", runtimeJobId);
        try {
            job.setState(new ObjectMapper().writeValueAsString(state));
        } catch (Exception e) {
            throw new AssertionError("Workspace Job fixture state must serialize", e);
        }
        job.setRuntimeJobId(runtimeJobId);
        workspaceJobs.saveAndFlush(job);
        return jobId;
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private ResponseEntity<Map> postCancel(UUID jobId, String token) {
        return restTemplate.postForEntity(
                baseUrl + "/api/v1/workspaces/" + workspaceId + "/jobs/" + jobId + "/cancel",
                new HttpEntity<>(authHeaders(token)), Map.class);
    }

    private List<WorkspaceJobHistory> jobHistory(UUID jobId) {
        return jobHistory.findByJobIdOrderBySequenceAsc(jobId);
    }

    @Test
    void cancelsRunningJobArchivesTerminalStateAndHistory() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        ResponseEntity<Map> ok = postCancel(domainJobId, authToken);

        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals(domainJobId.toString(), ok.getBody().get("jobId"));
        assertEquals("cancelled", ok.getBody().get("status"));
        assertEquals(true, ok.getBody().get("changed"));

        JobStateService.JobArchive archive = jobStateService.findByJobId(domainJobId).orElseThrow();
        assertEquals("cancelled", archive.status());
        assertEquals("user_cancel", archive.cancelReason());

        List<WorkspaceJobHistory> history = jobHistory(domainJobId);
        assertEquals(1, history.size());
        assertEquals("running", history.get(0).getFromStatus());
        assertEquals("cancelled", history.get(0).getToStatus());
    }

    @Test
    void terminalArchiveIsIdempotentWithoutRuntimeCall() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId, "succeeded");

        ResponseEntity<Map> ok = postCancel(domainJobId, authToken);

        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals("succeeded", ok.getBody().get("status"));
        assertEquals(false, ok.getBody().get("changed"));
        verify(runtimeJobClient, never()).cancelJob(any(), any());
        assertEquals("succeeded", jobStateService.findByJobId(domainJobId).orElseThrow().status());
        assertTrue(jobHistory(domainJobId).isEmpty(), "an idempotent no-op creates no state transition");
    }

    @Test
    void unconfirmedTerminationReturns502AndKeepsArchiveRunning() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "failed"));

        HttpServerErrorException error = assertThrows(HttpServerErrorException.class,
                () -> postCancel(domainJobId, authToken));
        assertEquals(HttpStatus.BAD_GATEWAY, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("JOB_CANCEL_UNCONFIRMED"));

        JobStateService.JobArchive archive = jobStateService.findByJobId(domainJobId).orElseThrow();
        assertEquals("running", archive.status(), "unconfirmed termination must not rewrite the archive");
        assertNull(archive.cancelReason());

        assertTrue(jobHistory(domainJobId).isEmpty(), "an unconfirmed cancellation creates no state transition");
    }

    @Test
    void missingRuntimeJobOrphansArchive() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, false, null));

        ResponseEntity<Map> ok = postCancel(domainJobId, authToken);

        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals("orphaned", ok.getBody().get("status"));
        assertEquals(true, ok.getBody().get("changed"));
        JobStateService.JobArchive archive = jobStateService.findByJobId(domainJobId).orElseThrow();
        assertEquals("orphaned", archive.status());
        assertEquals("job_missing", archive.cancelReason());

        assertEquals("orphaned", jobHistory(domainJobId).getLast().getToStatus());
    }

    @Test
    void unreachableRuntimeReturns502AndKeepsArchiveRunning() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(false, false, null));

        HttpServerErrorException error = assertThrows(HttpServerErrorException.class,
                () -> postCancel(domainJobId, authToken));
        assertEquals(HttpStatus.BAD_GATEWAY, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("RUNTIME_UNAVAILABLE"));
        assertEquals("running", jobStateService.findByJobId(domainJobId).orElseThrow().status());
        assertTrue(jobHistory(domainJobId).isEmpty());
    }

    @Test
    void preservesRuntimeProblemRequestIdAndKeepsArchiveRunning() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(
                        true, true, null, "RUNTIME_ERROR", "cancel rejected", "runtime-request-1", 422));

        ResponseEntity<Map> response = postCancel(domainJobId, authToken);

        assertEquals(422, response.getStatusCode().value());
        assertEquals("RUNTIME_ERROR", response.getBody().get("code"));
        assertEquals("runtime-request-1", response.getBody().get("requestId"));
        assertEquals("running", jobStateService.findByJobId(domainJobId).orElseThrow().status());
        assertTrue(jobHistory(domainJobId).isEmpty());
    }

    @Test
    void hidesForeignAndMissingArchivesWithoutAudit() {
        String jobId = UUID.randomUUID().toString();
        UUID domainJobId = newJob(jobId, "running");

        // 无关用户：404（不泄露存在性），不写审计
        String otherEmail = "job-cancel-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other"), AuthResponse.class);
        String otherToken = restTemplate.postForEntity(baseUrl + "/api/v1/auth/login",
                Map.of("email", otherEmail, "password", TestDataFactory.PASSWORD), Map.class)
                .getBody().get("accessToken").toString();
        ResponseEntity<Map> foreign = postCancel(domainJobId, otherToken);
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode());
         assertEquals("WORKSPACE_NOT_FOUND", foreign.getBody().get("code"));
        verify(runtimeJobClient, never()).cancelJob(any(), any());

        UUID missingId = UUID.randomUUID();
        ResponseEntity<Map> missing = postCancel(missingId, authToken);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("JOB_ARCHIVE_NOT_FOUND", missing.getBody().get("code"));

        assertTrue(jobHistory(domainJobId).isEmpty(), "404 paths must not mutate job state history");
    }

    @Test
    void workspaceMemberCanCancelJob() {
        String email = "job-cancel-member-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        AuthResponse registered = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Member"),
                AuthResponse.class).getBody();
        User member = userRepository.findByEmail(email).orElseThrow();
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId, member.getId().toString(), WorkspaceRole.MEMBER));

        UUID domainJobId = newJob(UUID.randomUUID().toString(), "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobStateService.findByJobId(domainJobId).orElseThrow().jobId()))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        ResponseEntity<Map> response = postCancel(domainJobId, registered.getAccessToken());

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(Boolean.TRUE, response.getBody().get("changed"));
        verify(runtimeJobClient).cancelJob(eq(workspaceId), anyString());
    }

    @Test
    void rejectsNonUuidJobId() {
        ResponseEntity<Map> bad = restTemplate.postForEntity(
                baseUrl + "/api/v1/workspaces/" + workspaceId + "/jobs/not-a-uuid/cancel",
                new HttpEntity<>(authHeaders(authToken)), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, bad.getStatusCode());
        assertEquals("INVALID_REQUEST", bad.getBody().get("code"));
    }

}
