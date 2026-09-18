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
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * PLAN-0344 T1.2：job_state 档案的状态机前进规则、回填来源、orphaned 收敛。
 */
class JobStateServiceIntegrationTest extends AbstractIntegrationTest {

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

    private String userId;
    private String workspaceId;
    private UUID operationId;

    @BeforeEach
    void setUp() {
        String email = "job-state-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "JobStateTest");
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Job State Session");
        session.setId(UUID.randomUUID());
        String sessionId = sessionRepository.save(session).getId().toString();

        operationId = operationService.startOperation(userId, sessionId, workspaceId, null, null,
                "chat", "ui", "user", userId,
                "job-state-" + UUID.randomUUID(), "Job state test").operationId();
    }

    private UUID newItem(String toolName) {
        OperationItem item = operationService.appendItem(operationId, UUID.randomUUID().toString(),
                null, "tool_call", toolName, "mcp", null, null, null);
        return item.getId();
    }

    /** 构造最小 MCP tools/call 成功响应（content[0].text = 工具返回文本）。 */
    private String toolResult(String text, boolean isError) throws Exception {
        var root = objectMapper.createObjectNode();
        var result = root.putObject("result");
        result.putArray("content").addObject().put("type", "text").put("text", text);
        result.put("isError", isError);
        return objectMapper.writeValueAsString(root);
    }

    private String jobInfoJson(String jobId, String status, Integer exitCode, Long timeoutSecs)
            throws Exception {
        Map<String, Object> job = new LinkedHashMap<>();
        job.put("jobId", jobId);
        job.put("status", status);
        if (exitCode != null) {
            job.put("exitCode", exitCode);
        }
        job.put("createdAt", "2026-09-18T00:00:00Z");
        if (timeoutSecs != null) {
            job.put("timeoutSecs", timeoutSecs);
        }
        return objectMapper.writeValueAsString(job);
    }

    private void startJob(UUID itemId, String jobId) throws Exception {
        jobStateService.applyToolResult(itemId, workspaceId, "start_background_process",
                toolResult(jobId, false));
    }

    private void syncJob(UUID itemId, String jobId, String status, Integer exitCode, Long timeoutSecs)
            throws Exception {
        jobStateService.applyToolResult(itemId, workspaceId, "get_background_process",
                toolResult(jobInfoJson(jobId, status, exitCode, timeoutSecs), false));
    }

    @Test
    void startResultCreatesRunningArchiveWithSessionScope() throws Exception {
        UUID item = newItem("start_background_process");
        String jobId = UUID.randomUUID().toString();
        startJob(item, jobId);

        JobStateService.JobArchive archive = jobStateService.find(item).orElseThrow();
        assertEquals(jobId, archive.jobId());
        assertEquals(workspaceId, archive.workspaceId());
        assertEquals("session", archive.scope());
        assertEquals("running", archive.status());
        assertNull(archive.endedAt());
    }

    @Test
    void terminalTransitionFillsExitCodeAndSealsEndedAt() throws Exception {
        UUID item = newItem("start_background_process");
        String jobId = UUID.randomUUID().toString();
        startJob(item, jobId);
        syncJob(item, jobId, "succeeded", 3, 600L);

        JobStateService.JobArchive archive = jobStateService.find(item).orElseThrow();
        assertEquals("succeeded", archive.status());
        assertEquals(3, archive.exitCode());
        assertEquals(600L, archive.timeoutSecs());
        assertNotNull(archive.endedAt());
    }

    @Test
    void terminalStateCannotRegressOrChange() throws Exception {
        UUID item = newItem("start_background_process");
        String jobId = UUID.randomUUID().toString();
        startJob(item, jobId);
        syncJob(item, jobId, "succeeded", 0, null);

        // running 回落被丢弃
        jobStateService.syncJobInfo(item, workspaceId,
                objectMapper.readTree(jobInfoJson(jobId, "running", null, null)));
        assertEquals("succeeded", jobStateService.find(item).orElseThrow().status());

        // 另一终态覆盖被丢弃
        jobStateService.applyToolResult(item, workspaceId, "cancel_background_process",
                toolResult("cancelled", false));
        JobStateService.JobArchive archive = jobStateService.find(item).orElseThrow();
        assertEquals("succeeded", archive.status());
        assertNull(archive.cancelReason());
    }

    @Test
    void cancelResultMarksCancelledWithUserReason() throws Exception {
        UUID item = newItem("cancel_background_process");
        String jobId = UUID.randomUUID().toString();
        startJob(item, jobId);
        jobStateService.applyToolResult(item, workspaceId, "cancel_background_process",
                toolResult("cancelled", false));

        JobStateService.JobArchive archive = jobStateService.find(item).orElseThrow();
        assertEquals("cancelled", archive.status());
        assertEquals("user_cancel", archive.cancelReason());
        assertNotNull(archive.endedAt());
    }

    @Test
    void failedRuntimeStatusConvergesToOrphaned() throws Exception {
        UUID item = newItem("get_background_process");
        String jobId = UUID.randomUUID().toString();
        startJob(item, jobId);
        jobStateService.syncJobInfo(item, workspaceId,
                objectMapper.readTree(jobInfoJson(jobId, "failed", null, null)));

        assertEquals("orphaned", jobStateService.find(item).orElseThrow().status());
    }

    @Test
    void toolErrorDoesNotCreateArchive() throws Exception {
        UUID item = newItem("start_background_process");
        jobStateService.applyToolResult(item, workspaceId, "start_background_process",
                toolResult("boom", true));
        assertTrue(jobStateService.find(item).isEmpty());
    }

    @Test
    void orphanMarkingMarksOnlyRunningArchives() throws Exception {
        UUID runningItem = newItem("start_background_process");
        UUID finishedItem = newItem("start_background_process");
        startJob(runningItem, UUID.randomUUID().toString());
        String finishedJobId = UUID.randomUUID().toString();
        startJob(finishedItem, finishedJobId);
        syncJob(finishedItem, finishedJobId, "succeeded", 0, null);

        int marked = jobStateService.markOrphanedForWorkspace(workspaceId, null);

        assertEquals(1, marked);
        JobStateService.JobArchive orphaned = jobStateService.find(runningItem).orElseThrow();
        assertEquals("orphaned", orphaned.status());
        assertEquals("destroy_orphan", orphaned.cancelReason());
        assertEquals("succeeded", jobStateService.find(finishedItem).orElseThrow().status());
    }

    @Test
    void orphanMarkingRespectsAliveEnumeration() throws Exception {
        UUID aliveItem = newItem("start_background_process");
        UUID otherItem = newItem("start_background_process");
        String aliveJobId = UUID.randomUUID().toString();
        startJob(aliveItem, aliveJobId);
        startJob(otherItem, UUID.randomUUID().toString());

        // Runtime 只枚举到 aliveJobId → 仅它落 orphaned（另一条留给对账）
        int marked = jobStateService.markOrphanedForWorkspace(workspaceId, java.util.Set.of(aliveJobId));

        assertEquals(1, marked);
        assertEquals("orphaned", jobStateService.find(aliveItem).orElseThrow().status());
        assertEquals("running", jobStateService.find(otherItem).orElseThrow().status());
    }

    @Test
    void findRunningSinceReturnsOnlyRunningRefs() throws Exception {
        UUID runningItem = newItem("start_background_process");
        String runningJobId = UUID.randomUUID().toString();
        startJob(runningItem, runningJobId);
        UUID finishedItem = newItem("start_background_process");
        String finishedJobId = UUID.randomUUID().toString();
        startJob(finishedItem, finishedJobId);
        syncJob(finishedItem, finishedJobId, "cancelled", null, null);

        List<JobStateService.JobStateRef> refs =
                jobStateService.findRunningSince(java.time.Instant.now().minus(java.time.Duration.ofDays(1)));

        assertTrue(refs.stream().anyMatch(ref -> runningJobId.equals(ref.jobId())));
        assertTrue(refs.stream().noneMatch(ref -> finishedJobId.equals(ref.jobId())));
    }

    @Test
    void getBackgroundProcessToolBodySyncsFromMcpResponse() throws Exception {
        UUID item = newItem("get_background_process");
        String jobId = UUID.randomUUID().toString();
        startJob(item, jobId);
        jobStateService.applyToolResult(item, workspaceId, "get_background_process",
                toolResult(jobInfoJson(jobId, "timeout", null, 60L), false));

        JobStateService.JobArchive archive = jobStateService.find(item).orElseThrow();
        assertEquals("timeout", archive.status());
        assertEquals(60L, archive.timeoutSecs());
    }
}
