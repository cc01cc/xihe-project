package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
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
 * PLAN-0390 M2 T2.2/T1.3/T2.3：Workspace Job start 的 durable 契约、幂等
 * （含并发同 key）、scope 收口触发与 Runtime 重启 interrupted 收口。
 */
class WorkspaceJobStartIntegrationTest extends AbstractIntegrationTest {

    @MockitoBean
    private RuntimeJobClient runtimeJobClient;

    @Autowired
    private OperationService operationService;

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
    private OperationItemRepository operationItems;

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

    private void stubDispatch(String jobId) {
        when(runtimeJobClient.startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, true, false, jobId, null));
        when(runtimeJobClient.runtimeBootId()).thenReturn("boot-1");
    }

    @Test
    void startCreatesDurableJobWithScopeAndBackendAndDispatches() {
        stubDispatch("job-1");

        ResponseEntity<Map> response = postStart("key-1", body("echo", "workspace"));

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        Map<?, ?> job = response.getBody();
        assertNotNull(job);
        String itemId = (String) job.get("operationItemId");
        assertNotNull(itemId);
        assertEquals("workspace", job.get("scope"));
        assertEquals("docker", job.get("backendKind"));
        assertEquals("docker", job.get("executionMode"));
        assertEquals("running", job.get("status"));
        assertEquals("job-1", job.get("jobId"));
        assertNull(job.get("sessionId"));

        JobStateService.JobArchive archive = jobStateService.find(UUID.fromString(itemId)).orElseThrow();
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

        List<Map<String, Object>> listed = operationService.listWorkspaceJobs(workspaceId);
        assertTrue(listed.stream().anyMatch(row -> itemId.equals(row.get("operationItemId"))));
    }

    @Test
    void replayWithSameKeyReturnsExistingJobWithoutSecondDispatch() {
        stubDispatch("job-2");

        ResponseEntity<Map> first = postStart("key-2", body("echo", "workspace"));
        ResponseEntity<Map> second = postStart("key-2", body("echo", "workspace"));

        assertEquals(HttpStatus.ACCEPTED, first.getStatusCode());
        assertEquals(HttpStatus.OK, second.getStatusCode());
        assertEquals(first.getBody().get("operationItemId"), second.getBody().get("operationItemId"));
        assertEquals("job-2", second.getBody().get("jobId"));
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
    void nonDockerWorkspaceIsRefusedWithoutCreatingDurableJob() {
        var workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        workspace.setExecutionMode("windows-host");
        workspaceRepository.save(workspace);

        HttpServerErrorException error = org.junit.jupiter.api.Assertions.assertThrows(
                HttpServerErrorException.class,
                () -> postStart("key-5", body("echo", "workspace")));

        assertEquals(HttpStatus.NOT_IMPLEMENTED, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("JOB_BACKEND_LAUNCH_PENDING"));
        verify(runtimeJobClient, never()).startJob(any(), any(), any(), any(), any(), any(), any());
        assertTrue(operationService.listWorkspaceJobs(workspaceId).isEmpty(),
                "no durable Job row may be created for an unavailable backend");
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
        List<Map<String, Object>> listed = operationService.listWorkspaceJobs(workspaceId);
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

            assertEquals(first.getBody().get("operationItemId"), second.getBody().get("operationItemId"));
            List<Map<String, Object>> listed = operationService.listWorkspaceJobs(workspaceId);
            assertEquals(1, listed.size(), "concurrent same-key start must yield one durable Job");
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void runTerminalClosesRunScopedJob() throws Exception {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "none", "running"));
        UUID operationId = operationService.startOperation(userId, sessionId, workspaceId, runId, null,
                "chat", "ui", "user", userId, "run-scope-" + UUID.randomUUID(), "run scope").operationId();
        OperationItem item = operationService.appendItem(operationId, UUID.randomUUID().toString(),
                null, "job", null, "system", null, null, null);
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("workspaceId", workspaceId);
        incoming.put("scope", "run");
        incoming.put("runId", runId);
        incoming.put("sessionId", sessionId);
        incoming.put("jobId", "job-run-1");
        incoming.put("status", "running");
        jobStateService.upsert(item.getId(), incoming);
        when(runtimeJobClient.cancelJob(workspaceId, "job-run-1"))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        operationService.transitionOperationForRun(runId, "cancelled", null, null);

        JobStateService.JobArchive archive = jobStateService.find(item.getId()).orElseThrow();
        assertEquals("cancelled", archive.status());
        assertEquals(JobStateService.REASON_SCOPE_RUN_END, archive.cancelReason());
    }

    @Test
    void sessionDeleteClosesSessionScopedJobBeforeCascade() throws Exception {
        UUID operationId = operationService.startOperation(userId, sessionId, workspaceId, null, null,
                "other", "ui", "user", userId, "session-scope-" + UUID.randomUUID(), "session scope")
                .operationId();
        OperationItem item = operationService.appendItem(operationId, UUID.randomUUID().toString(),
                null, "job", null, "system", null, null, null);
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("workspaceId", workspaceId);
        incoming.put("scope", "session");
        incoming.put("sessionId", sessionId);
        incoming.put("jobId", "job-session-1");
        incoming.put("status", "running");
        jobStateService.upsert(item.getId(), incoming);
        when(runtimeJobClient.cancelJob(workspaceId, "job-session-1"))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        restTemplate.exchange(baseUrl + "/api/v1/sessions/" + sessionId, HttpMethod.DELETE,
                new HttpEntity<>(headers(null)), Void.class);

        verify(runtimeJobClient).cancelJob(workspaceId, "job-session-1");
        // session 级联删除后 durable 行随之消失：会话级 Job 不得跨 Session 存活。
        assertTrue(jobStateService.find(item.getId()).isEmpty());
    }

    @Test
    void runtimeRestartMarksOnlyStaleBootIdJobsInterrupted() throws Exception {
        UUID operationId = operationService.startOperation(userId, sessionId, workspaceId, null, null,
                "other", "ui", "user", userId, "restart-" + UUID.randomUUID(), "restart").operationId();
        OperationItem stale = operationService.appendItem(operationId, UUID.randomUUID().toString(),
                null, "job", null, "system", null, null, null);
        Map<String, Object> stalePayload = new LinkedHashMap<>();
        stalePayload.put("workspaceId", workspaceId);
        stalePayload.put("scope", "workspace");
        stalePayload.put("jobId", "job-old");
        stalePayload.put("status", "running");
        stalePayload.put("runtimeBootId", "boot-old");
        jobStateService.upsert(stale.getId(), stalePayload);

        OperationItem fresh = operationService.appendItem(operationId, UUID.randomUUID().toString(),
                null, "job", null, "system", null, null, null);
        Map<String, Object> freshPayload = new LinkedHashMap<>();
        freshPayload.put("workspaceId", workspaceId);
        freshPayload.put("scope", "workspace");
        freshPayload.put("jobId", "job-new");
        freshPayload.put("status", "running");
        freshPayload.put("runtimeBootId", "boot-new");
        jobStateService.upsert(fresh.getId(), freshPayload);

        assertEquals(1, jobStateService.markInterruptedForRuntimeRestart(workspaceId, "boot-new"),
                "only the job recorded by the previous Runtime boot is stale");
        JobStateService.JobArchive interrupted = jobStateService.find(stale.getId()).orElseThrow();
        assertEquals(JobStateService.STATUS_INTERRUPTED, interrupted.status());
        assertEquals(JobStateService.REASON_RUNTIME_RESTART, interrupted.cancelReason());
        assertEquals("RUNTIME_RESTART", interrupted.errorCode());
        assertEquals("running", jobStateService.find(fresh.getId()).orElseThrow().status());
        assertEquals(0, jobStateService.markInterruptedForRuntimeRestart(workspaceId, "boot-new"),
                "re-running reconciliation must be idempotent (no replay, no re-marking)");
    }
}
