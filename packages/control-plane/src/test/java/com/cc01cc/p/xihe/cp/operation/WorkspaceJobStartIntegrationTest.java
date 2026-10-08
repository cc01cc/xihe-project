package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.chat.ChatRunTerminalService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJobHistory;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.client.HttpServerErrorException;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0390 M2 T2.2/T1.3/T2.3 + PLAN-0465 T1.1–T1.4：Workspace Job start 的 durable
 * 契约（`workspace_jobs` 域）、幂等（含并发同 key）、scope 收口触发与 Runtime
 * 重启 interrupted 收口；wire 以 domain jobId 为身份（decision #7）。
 */
class WorkspaceJobStartIntegrationTest extends AbstractIntegrationTest {

    @MockitoBean
    private RuntimeJobClient runtimeJobClient;

    @Autowired
    private JobStateService jobStateService;

    @Autowired
    private ChatRunTerminalService chatRunTerminalService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceJobRepository workspaceJobs;


    @Autowired
    private WorkspaceJobHistoryRepository jobHistory;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "ws-job-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "WsJobTest");
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = response.getBody().getAccessToken();
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Workspace Job Session");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();
    }

    private HttpHeaders headers(String idempotencyKey) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (idempotencyKey != null) {
            headers.set("Idempotency-Key", idempotencyKey);
        }
        return headers;
    }

    private UUID createWorkspaceJob(String scope, String scopedSessionId, String runId,
                                    String runtimeJobId, String runtimeBootId) {
        UUID jobId = UUID.randomUUID();
        WorkspaceJob row = new WorkspaceJob();
        row.setId(jobId);
        row.setWorkspaceId(UUID.fromString(workspaceId));
        row.setUserId(UUID.fromString(userId));
        row.setSessionId(scopedSessionId == null ? null : UUID.fromString(scopedSessionId));
        row.setRunId(runId == null ? null : UUID.fromString(runId));
        row.setSource("ui");
        row.setScope(scope);
        row.setIdempotencyKey("fixture-" + jobId);
        row.setInputHash("fixture-hash");
        row.setStatus(JobStateService.STATUS_RUNNING);
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("workspaceId", workspaceId);
        state.put("userId", userId);
        state.put("scope", scope);
        state.put("status", JobStateService.STATUS_RUNNING);
        state.put("jobId", runtimeJobId);
        if (scopedSessionId != null) {
            state.put("sessionId", scopedSessionId);
        }
        if (runId != null) {
            state.put("runId", runId);
        }
        if (runtimeBootId != null) {
            state.put("runtimeBootId", runtimeBootId);
        }
        try {
            row.setState(new ObjectMapper().writeValueAsString(state));
        } catch (Exception e) {
            throw new AssertionError("Workspace Job fixture state must serialize", e);
        }
        row.setRuntimeJobId(runtimeJobId);
        row.setStartedAt(Instant.now());
        workspaceJobs.saveAndFlush(row);
        return jobId;
    }

    private Map<String, Object> body(String command, String scope) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("command", command);
        body.put("args", List.of("hi"));
        body.put("scope", scope);
        if ("session".equals(scope)) {
            body.put("sessionId", sessionId);
        }
        return body;
    }

    private ResponseEntity<Map> postStart(String idempotencyKey, Map<String, Object> body) {
        return restTemplate.exchange(
                baseUrl + "/api/v1/workspaces/" + workspaceId + "/jobs",
                HttpMethod.POST, new HttpEntity<>(body, headers(idempotencyKey)), Map.class);
    }

    private void stubDispatch(String runtimeJobHandle) {
        when(runtimeJobClient.startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, true, false, runtimeJobHandle, null));
        when(runtimeJobClient.runtimeBootId()).thenReturn("boot-1");
    }

    @Test
    void startCreatesDurableJobWithScopeAndBackendAndDispatches() {
        stubDispatch("job-1");

        ResponseEntity<Map> response = postStart("key-1", body("echo", "workspace"));

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        Map<?, ?> job = response.getBody();
        assertNotNull(job);
        // PLAN-0465 decision #7：wire 身份 = domain jobId；Runtime handle 落 runtimeJobId。
        String jobId = (String) job.get("jobId");
        assertNotNull(jobId);
        assertEquals("workspace", job.get("scope"));
        assertEquals("docker", job.get("backendKind"));
        assertEquals("docker", job.get("executionMode"));
        assertEquals("running", job.get("status"));
        assertEquals("job-1", job.get("runtimeJobId"));
        assertNull(job.get("sessionId"));
        assertFalse(job.containsKey("operationItemId"), "the wire has no retired Ledger alias");

        JobStateService.JobArchive archive =
                jobStateService.findByJobId(UUID.fromString(jobId)).orElseThrow();
        assertEquals("running", archive.status());
        assertEquals("workspace", archive.scope());
        assertEquals("docker", archive.backendKind());
        assertEquals("docker", archive.executionMode());
        assertEquals("ui", archive.source());
        assertEquals("user", archive.actorType());
        assertEquals("not_started", archive.cleanupStatus());
        assertEquals("boot-1", archive.runtimeBootId());
        assertNotNull(archive.createdAt());
        assertEquals("job-1", archive.jobId());
        assertEquals(jobId, workspaceJobs.findById(UUID.fromString(jobId)).orElseThrow()
                .getId().toString());

        List<Map<String, Object>> listed = jobStateService.listView(workspaceId);
        assertTrue(listed.stream().anyMatch(row -> jobId.equals(row.get("jobId"))));
    }

    @Test
    void replayWithSameKeyReturnsExistingJobWithoutSecondDispatch() {
        stubDispatch("job-2");

        ResponseEntity<Map> first = postStart("key-2", body("echo", "workspace"));
        ResponseEntity<Map> second = postStart("key-2", body("echo", "workspace"));

        assertEquals(HttpStatus.ACCEPTED, first.getStatusCode());
        assertEquals(HttpStatus.OK, second.getStatusCode());
        assertEquals(first.getBody().get("jobId"), second.getBody().get("jobId"));
        assertEquals("job-2", second.getBody().get("runtimeJobId"));
        verify(runtimeJobClient, times(1))
                .startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any());
    }

    @Test
    void sameKeyWithDifferentCommandIsRejected() {
        stubDispatch("job-3");
        postStart("key-3", body("echo", "workspace"));

        ResponseEntity<Map> response = postStart("key-3", body("npm", "workspace"));

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertTrue(String.valueOf(response.getBody()).contains("JOB_IDEMPOTENCY_CONFLICT"));
    }

    @Test
    void missingIdempotencyKeyIsRejected() {
        stubDispatch("job-4");

        ResponseEntity<Map> response = postStart(null, body("echo", "workspace"));

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertTrue(String.valueOf(response.getBody()).contains("IDEMPOTENCY_KEY_REQUIRED"));
        verify(runtimeJobClient, never()).startJob(any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void windowsHostWorkspaceDispatchesRuntimeJob() {
        var workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        workspace.setExecutionMode("windows-host");
        workspaceRepository.save(workspace);
        stubDispatch("host-job");

        ResponseEntity<Map> response = postStart("key-5", body("echo", "workspace"));

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        assertEquals("host-job", response.getBody().get("runtimeJobId"));
        verify(runtimeJobClient).startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any());
    }

    @Test
    void windowsMxcWorkspaceDispatchesRuntimeJob() {
        var workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        workspace.setExecutionMode("windows-mxc");
        workspaceRepository.save(workspace);
        stubDispatch("mxc-job");

        ResponseEntity<Map> response = postStart("key-5-mxc", body("echo", "workspace"));

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        assertEquals("mxc-job", response.getBody().get("runtimeJobId"));
        verify(runtimeJobClient).startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any());
    }

    @Test
    void runtime501ForWindowsWorkspaceFailsClosedWithoutFallback() {
        var workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        workspace.setExecutionMode("windows-mxc");
        workspaceRepository.save(workspace);
        when(runtimeJobClient.startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, false, true, null,
                        "JOB_BACKEND_LAUNCH_PENDING"));

        HttpServerErrorException error = org.junit.jupiter.api.Assertions.assertThrows(
                HttpServerErrorException.class,
                () -> postStart("key-5-pending", body("echo", "workspace")));

        assertEquals(HttpStatus.NOT_IMPLEMENTED, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("JOB_BACKEND_LAUNCH_PENDING"));
        verify(runtimeJobClient, times(1)).startJob(any(), any(), any(), any(), any(), any(), any());
        assertEquals("interrupted", jobStateService.listView(workspaceId).get(0).get("status"));
    }

    @Test
    void unreachableRuntimeLeavesInterruptedDurableJobAndReports502() {
        when(runtimeJobClient.startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(false, false, false, null, null));

        HttpServerErrorException error = org.junit.jupiter.api.Assertions.assertThrows(
                HttpServerErrorException.class,
                () -> postStart("key-6", body("echo", "workspace")));

        assertEquals(HttpStatus.BAD_GATEWAY, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("RUNTIME_UNAVAILABLE"));
        List<Map<String, Object>> listed = jobStateService.listView(workspaceId);
        assertEquals(1, listed.size());
        assertEquals("interrupted", listed.get(0).get("status"));
        assertEquals("RUNTIME_UNAVAILABLE", listed.get(0).get("errorCode"));
    }

    @Test
    void concurrentSameKeyCreatesExactlyOneDurableJob() throws Exception {
        stubDispatch("job-7");
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<ResponseEntity<Map>> a = pool.submit(() -> {
                start.await();
                return postStart("key-7", body("echo", "workspace"));
            });
            Future<ResponseEntity<Map>> b = pool.submit(() -> {
                start.await();
                return postStart("key-7", body("echo", "workspace"));
            });
            start.countDown();
            ResponseEntity<Map> first = a.get(30, TimeUnit.SECONDS);
            ResponseEntity<Map> second = b.get(30, TimeUnit.SECONDS);

            assertEquals(first.getBody().get("jobId"), second.getBody().get("jobId"));
            List<Map<String, Object>> listed = jobStateService.listView(workspaceId);
            assertEquals(1, listed.size(), "concurrent same-key start must yield one durable Job");
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void startWritesDomainHistoryStartAndRunning() {
        stubDispatch("job-hist");

        ResponseEntity<Map> response = postStart("key-hist", body("echo", "workspace"));
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        UUID jobId = UUID.fromString((String) response.getBody().get("jobId"));

        List<WorkspaceJobHistory> history = jobHistory.findByJobIdOrderBySequenceAsc(jobId);
        assertEquals(2, history.size(), "start + running 两条 transition history");
        assertEquals(WorkspaceJobHistory.EVENT_START, history.get(0).getEventType());
        assertNull(history.get(0).getFromStatus());
        assertEquals(JobStateService.STATUS_PENDING, history.get(0).getToStatus());
        assertEquals(WorkspaceJobHistory.EVENT_RUNNING, history.get(1).getEventType());
        assertEquals(JobStateService.STATUS_PENDING, history.get(1).getFromStatus());
        assertEquals(JobStateService.STATUS_RUNNING, history.get(1).getToStatus());
        assertEquals(2L, history.get(1).getSequence());
    }

    /**
     * PLAN-0465 T1.4（0464 review P0 回归断言）：ChatRun 终态的 after-commit 触发器
     * 必须把本 Run 的 active Job 收口在 **`workspace_jobs`** 上，且收口后
     * `hasRunningForWorkspace` 门（WORKSPACE_BUSY / 删除阻塞）解除。
     */
    @Test
    void chatRunTerminalClosesRunScopedJobOnWorkspaceJobsAndUnblocksWorkspace() throws Exception {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "none", "running"));
        UUID jobId = createWorkspaceJob("run", sessionId, runId, "job-run-term-1", null);
        when(runtimeJobClient.cancelJob(workspaceId, "job-run-term-1"))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        assertTrue(jobStateService.hasRunningForWorkspace(workspaceId),
                "run-scope active Job 先占住 workspace 保护门");

        ChatRunTerminalService.TerminalResult result = chatRunTerminalService.terminalize(
                new ChatRunTerminalService.TerminalRequest(runId, List.of("running"),
                        "succeeded", "success", null, null, 0, 0,
                        ChatRunTerminalService.TerminalSource.STREAM, null));
        assertTrue(result.committed());

        JobStateService.JobArchive archive = jobStateService.findByJobId(jobId).orElseThrow();
        assertEquals("cancelled", archive.status(), "Run 终态必须收口本 Run 的 run-scope Job");
        assertEquals(JobStateService.REASON_SCOPE_RUN_END, archive.cancelReason());
        // 收口落在新表上（触发器行为回归断言，0464 接线 + 0465 换表）。
        List<Map<String, Object>> listed = jobStateService.listView(workspaceId);
        assertEquals(1, listed.size());
        assertEquals("cancelled", listed.get(0).get("status"));
        assertFalse(jobStateService.hasRunningForWorkspace(workspaceId),
                "收口后 Workspace 不再被 active Job 阻塞（hasRunningForWorkspace 门解除）");
        verify(runtimeJobClient).cancelJob(workspaceId, "job-run-term-1");
    }

    @Test
    void sessionDeleteClosesSessionScopedJobBeforeCascade() throws Exception {
        UUID jobId = createWorkspaceJob("session", sessionId, null, "job-session-1", null);
        when(runtimeJobClient.cancelJob(workspaceId, "job-session-1"))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        restTemplate.exchange(baseUrl + "/api/v1/sessions/" + sessionId, HttpMethod.DELETE,
                new HttpEntity<>(headers(null)), Void.class);

        verify(runtimeJobClient).cancelJob(workspaceId, "job-session-1");
        // session 级联删除后 durable 行随之消失：会话级 Job 不得跨 Session 存活
        // （workspace_jobs.session_id FK ON DELETE CASCADE）。
        assertTrue(workspaceJobs.findById(jobId).isEmpty());
    }

    @Test
    void runtimeRestartMarksOnlyStaleBootIdJobsInterrupted() throws Exception {
        UUID stale = createWorkspaceJob("workspace", null, null, "job-old", "boot-old");
        UUID fresh = createWorkspaceJob("workspace", null, null, "job-new", "boot-new");

        assertEquals(1, jobStateService.markInterruptedForRuntimeRestart(workspaceId, "boot-new"),
                "only the job recorded by the previous Runtime boot is stale");
        JobStateService.JobArchive interrupted = jobStateService.findByJobId(stale).orElseThrow();
        assertEquals(JobStateService.STATUS_INTERRUPTED, interrupted.status());
        assertEquals(JobStateService.REASON_RUNTIME_RESTART, interrupted.cancelReason());
        assertEquals("RUNTIME_RESTART", interrupted.errorCode());
        assertEquals("running", jobStateService.findByJobId(fresh).orElseThrow().status());
        assertEquals(0, jobStateService.markInterruptedForRuntimeRestart(workspaceId, "boot-new"),
                "re-running reconciliation must be idempotent (no replay, no re-marking)");
    }
}
