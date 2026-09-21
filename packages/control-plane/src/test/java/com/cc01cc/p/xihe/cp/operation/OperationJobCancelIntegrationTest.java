package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationEvent;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
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

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * PLAN-0366 T1.4：单 job 取消端点的对外契约（幂等/未确认/失联/不可达/归属/审计）。
 * 覆盖 spec §二「响应与状态映射」全部分支与决策 #14 的 `job.cancel` 事件。
 */
class OperationJobCancelIntegrationTest extends AbstractIntegrationTest {

    @MockitoBean
    private RuntimeJobClient runtimeJobClient;

    @Autowired
    private JobStateService jobStateService;

    @Autowired
    private OperationService operationService;

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

    private String authToken;
    private String userId;
    private String workspaceId;
    private UUID operationId;
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
        String sessionId = sessionRepository.save(session).getId().toString();
        // run_id 有 FK（→ chat_runs），审计 payload 的 runId 必须来自真实 run 行。
        runId = UUID.randomUUID().toString();
        chatRunRepository.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "none", "running"));
        operationId = operationService.startOperation(userId, sessionId, workspaceId, runId, null,
                "chat", "ui", "user", userId, "job-cancel-" + UUID.randomUUID(),
                "Job cancel test").operationId();
    }

    private UUID newJobItem(String jobId, String status) {
        OperationItem item = operationService.appendItem(operationId, UUID.randomUUID().toString(),
                null, "tool_call", "start_background_process", "mcp", null, null, null);
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("jobId", jobId);
        incoming.put("workspaceId", workspaceId);
        incoming.put("status", status);
        jobStateService.upsert(item.getId(), incoming);
        return item.getId();
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private ResponseEntity<Map> postCancel(UUID itemId, String token) {
        return restTemplate.postForEntity(
                baseUrl + "/api/v1/operations/items/" + itemId + "/cancel",
                new HttpEntity<>(authHeaders(token)), Map.class);
    }

    private List<OperationEvent> jobCancelEvents() {
        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        @SuppressWarnings("unchecked")
        List<OperationEvent> events = (List<OperationEvent>) (Object) trace.get("events");
        return events.stream().filter(event -> "job.cancel".equals(event.getEventType())).toList();
    }

    @Test
    void cancelsRunningJobArchivesTerminalStateAndAudits() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        ResponseEntity<Map> ok = postCancel(itemId, authToken);

        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals(itemId.toString(), ok.getBody().get("itemId"));
        assertEquals(jobId, ok.getBody().get("jobId"));
        assertEquals("cancelled", ok.getBody().get("status"));
        assertEquals(true, ok.getBody().get("changed"));

        JobStateService.JobArchive archive = jobStateService.find(itemId).orElseThrow();
        assertEquals("cancelled", archive.status());
        assertEquals("user_cancel", archive.cancelReason());

        List<OperationEvent> events = jobCancelEvents();
        assertEquals(1, events.size());
        OperationEvent event = events.get(0);
        assertEquals("job.cancel", event.getEventType());
        assertEquals("user", event.getActor());
        assertEquals("cancelled", event.getState());
        assertEquals(itemId.toString(), event.getItemId());
        Map<?, ?> audit = payload(event);
        assertEquals(jobId, audit.get("jobId"));
        assertEquals(workspaceId, audit.get("workspaceId"));
        assertEquals(runId, audit.get("runId"));
        assertEquals("cancelled", audit.get("result"));
        assertEquals(true, audit.get("changed"));
    }

    @Test
    void terminalArchiveIsIdempotentWithoutRuntimeCall() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId, "succeeded");

        ResponseEntity<Map> ok = postCancel(itemId, authToken);

        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals("succeeded", ok.getBody().get("status"));
        assertEquals(false, ok.getBody().get("changed"));
        verify(runtimeJobClient, never()).cancelJob(any(), any());
        assertEquals("succeeded", jobStateService.find(itemId).orElseThrow().status());

        List<OperationEvent> events = jobCancelEvents();
        assertEquals(1, events.size());
        assertEquals("rejected_terminal", payload(events.get(0)).get("result"));
        assertEquals("succeeded", events.get(0).getState());
    }

    @Test
    void unconfirmedTerminationReturns502AndKeepsArchiveRunning() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "failed"));

        HttpServerErrorException error = assertThrows(HttpServerErrorException.class,
                () -> postCancel(itemId, authToken));
        assertEquals(HttpStatus.BAD_GATEWAY, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("JOB_CANCEL_UNCONFIRMED"));

        JobStateService.JobArchive archive = jobStateService.find(itemId).orElseThrow();
        assertEquals("running", archive.status(), "unconfirmed termination must not rewrite the archive");
        assertNull(archive.cancelReason());

        List<OperationEvent> events = jobCancelEvents();
        assertEquals(1, events.size());
        assertEquals("running", events.get(0).getState());
        assertEquals("unconfirmed", payload(events.get(0)).get("result"));
        assertEquals(false, payload(events.get(0)).get("changed"));
    }

    @Test
    void missingRuntimeJobOrphansArchive() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, false, null));

        ResponseEntity<Map> ok = postCancel(itemId, authToken);

        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals("orphaned", ok.getBody().get("status"));
        assertEquals(true, ok.getBody().get("changed"));
        JobStateService.JobArchive archive = jobStateService.find(itemId).orElseThrow();
        assertEquals("orphaned", archive.status());
        assertEquals("job_missing", archive.cancelReason());

        List<OperationEvent> events = jobCancelEvents();
        assertEquals(1, events.size());
        assertEquals("orphaned", events.get(0).getState());
        assertEquals("orphaned", payload(events.get(0)).get("result"));
    }

    @Test
    void unreachableRuntimeReturns502AndKeepsArchiveRunning() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId, "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(false, false, null));

        HttpServerErrorException error = assertThrows(HttpServerErrorException.class,
                () -> postCancel(itemId, authToken));
        assertEquals(HttpStatus.BAD_GATEWAY, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("RUNTIME_UNAVAILABLE"));
        assertEquals("running", jobStateService.find(itemId).orElseThrow().status());

        List<OperationEvent> events = jobCancelEvents();
        assertEquals(1, events.size());
        assertEquals("unreachable", payload(events.get(0)).get("result"));
    }

    @Test
    void hidesForeignAndMissingArchivesWithoutAudit() {
        String jobId = UUID.randomUUID().toString();
        UUID itemId = newJobItem(jobId, "running");

        // 无关用户：404（不泄露存在性），不写审计
        String otherEmail = "job-cancel-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other"), AuthResponse.class);
        String otherToken = restTemplate.postForEntity(baseUrl + "/api/v1/auth/login",
                Map.of("email", otherEmail, "password", TestDataFactory.PASSWORD), Map.class)
                .getBody().get("accessToken").toString();
        ResponseEntity<Map> foreign = postCancel(itemId, otherToken);
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode());
         assertEquals("WORKSPACE_NOT_FOUND", foreign.getBody().get("code"));
        verify(runtimeJobClient, never()).cancelJob(any(), any());

        // 无档案的 item：404 JOB_ARCHIVE_NOT_FOUND，不写审计（R3-2 处置）
        OperationItem plain = operationService.appendItem(operationId,
                UUID.randomUUID().toString(), null, "tool_call", "read_file", "mcp", null, null, null);
        ResponseEntity<Map> missing = postCancel(plain.getId(), authToken);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("JOB_ARCHIVE_NOT_FOUND", missing.getBody().get("code"));

        assertEquals(0, jobCancelEvents().size(), "404 paths must not leave job.cancel events");
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

        UUID itemId = newJobItem(UUID.randomUUID().toString(), "running");
        when(runtimeJobClient.cancelJob(workspaceId, jobStateService.find(itemId).orElseThrow().jobId()))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        ResponseEntity<Map> response = postCancel(itemId, registered.getAccessToken());

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(Boolean.TRUE, response.getBody().get("changed"));
        verify(runtimeJobClient).cancelJob(eq(workspaceId), anyString());
    }

    @Test
    void rejectsNonUuidItem() {
        ResponseEntity<Map> bad = restTemplate.postForEntity(
                baseUrl + "/api/v1/operations/items/not-a-uuid/cancel",
                new HttpEntity<>(authHeaders(authToken)), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, bad.getStatusCode());
        assertEquals("INVALID_REQUEST", bad.getBody().get("code"));
    }

    private static Map<?, ?> payload(OperationEvent event) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper()
                    .readValue(event.getPayload(), Map.class);
        } catch (Exception e) {
            throw new AssertionError("job.cancel payload must be JSON: " + event.getPayload(), e);
        }
    }
}
