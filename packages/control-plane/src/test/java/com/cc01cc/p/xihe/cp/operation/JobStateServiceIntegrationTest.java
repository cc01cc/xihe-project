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
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobRepository;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Domain-owned MCP tool result materialization and Workspace Job state transitions. */
class JobStateServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired private JobStateService jobStateService;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceJobRepository workspaceJobs;
    @Autowired private ObjectMapper objectMapper;

    private String userId;
    private String workspaceId;
    private String sessionId;

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
        sessionId = sessionRepository.save(session).getId().toString();
    }

    private JobStateService.ToolJobProvenance provenance(String toolCallId) {
        return new JobStateService.ToolJobProvenance(workspaceId, userId, sessionId, null, toolCallId);
    }

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

    private WorkspaceJob startJob(String toolCallId, String runtimeJobId) throws Exception {
        jobStateService.applyToolResult(provenance(toolCallId), "start_background_process",
                toolResult(runtimeJobId, false));
        return workspaceJobs.findByToolCallId(UUID.fromString(toolCallId)).orElseThrow();
    }

    @Test
    void startResultCreatesRunningArchiveUnderCanonicalWorkspaceJobId() throws Exception {
        String toolCallId = UUID.randomUUID().toString();
        String runtimeJobId = UUID.randomUUID().toString();
        WorkspaceJob row = startJob(toolCallId, runtimeJobId);

        JobStateService.JobArchive archive = jobStateService.findByJobId(row.getId()).orElseThrow();
        assertEquals(runtimeJobId, archive.jobId());
        assertEquals(workspaceId, archive.workspaceId());
        assertEquals("session", archive.scope());
        assertEquals("running", archive.status());
        assertNull(archive.endedAt());
        assertEquals(UUID.fromString(toolCallId), row.getToolCallId());
    }

    @Test
    void terminalTransitionFillsExitCodeAndCannotRegress() throws Exception {
        String toolCallId = UUID.randomUUID().toString();
        String runtimeJobId = UUID.randomUUID().toString();
        WorkspaceJob row = startJob(toolCallId, runtimeJobId);
        jobStateService.applyToolResult(provenance(toolCallId), "get_background_process",
                toolResult(jobInfoJson(runtimeJobId, "succeeded", 3, 600L), false));

        jobStateService.applyToolResult(provenance(toolCallId), "get_background_process",
                toolResult(jobInfoJson(runtimeJobId, "running", null, null), false));
        JobStateService.JobArchive archive = jobStateService.findByJobId(row.getId()).orElseThrow();
        assertEquals("succeeded", archive.status());
        assertEquals(3, archive.exitCode());
        assertEquals(600L, archive.timeoutSecs());
        assertNotNull(archive.endedAt());
    }

    @Test
    void explicitWorkspaceScopeUpdatesTheDomainRowAndProjection() throws Exception {
        WorkspaceJob row = startJob(UUID.randomUUID().toString(), UUID.randomUUID().toString());
        jobStateService.upsertById(row.getId(), Map.of("scope", JobStateService.SCOPE_WORKSPACE));

        WorkspaceJob updated = workspaceJobs.findById(row.getId()).orElseThrow();
        assertEquals("workspace", updated.getScope());
        assertTrue(updated.getState().replace(" ", "").contains("\"scope\":\"workspace\""));
        List<Map<String, Object>> jobs = jobStateService.listView(workspaceId);
        assertTrue(jobs.stream().anyMatch(job -> row.getId().toString().equals(job.get("jobId"))
                && workspaceId.equals(job.get("workspaceId"))
                && "workspace".equals(job.get("scope"))));
    }

    @Test
    void missingDomainOwnerDoesNotMaterializeAJob() throws Exception {
        String toolCallId = UUID.randomUUID().toString();
        JobStateService.ToolJobProvenance incomplete = new JobStateService.ToolJobProvenance(
                workspaceId, null, sessionId, null, toolCallId);

        jobStateService.applyToolResult(incomplete, "start_background_process",
                toolResult(UUID.randomUUID().toString(), false));

        assertTrue(workspaceJobs.findByToolCallId(UUID.fromString(toolCallId)).isEmpty());
    }
}
