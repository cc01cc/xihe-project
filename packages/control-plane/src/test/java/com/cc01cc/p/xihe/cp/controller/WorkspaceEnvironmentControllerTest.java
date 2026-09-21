package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0396：environment 的 {@code jobCapability} 三态映射（无需 Spring 上下文）。
 *
 * <p>冻结口径：能力只从 Runtime 回包白名单透传；不可达与「容器 Job 由 Docker
 * 服务」都输出显式 unavailable + reason，禁止猜测可用；禁止键不得出现。
 */
class WorkspaceEnvironmentControllerTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    private RuntimeJobClient.JobCapabilityResult capability(String json) {
        try {
            return new RuntimeJobClient.JobCapabilityResult(true, false, objectMapper.readTree(json), null);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    @Test
    void passesThroughRuntimeCapabilityWithIsolationMarker() {
        Map<String, Object> view = WorkspaceEnvironmentController.jobCapabilityView(
                "windows-mxc",
                capability("{\"backendKind\":\"windows-mxc\",\"backendRevision\":\"builtin\","
                        + "\"maturity\":\"experimental\",\"executionMode\":\"windows-mxc\","
                        + "\"canStart\":true,\"canCancel\":true,\"canStreamOutput\":true,"
                        + "\"canIsolateFilesystem\":true,\"available\":true,"
                        + "\"unavailableReason\":null}"));

        assertEquals("windows-mxc", view.get("backendKind"));
        assertEquals("experimental", view.get("maturity"));
        assertEquals(true, view.get("canStart"));
        assertEquals(true, view.get("canIsolateFilesystem"));
        assertEquals(true, view.get("available"));
        assertNull(view.get("unavailableReason"));
        assertNotNull(view.get("checkedAt"));
    }

    @Test
    void hostCapabilityCarriesTheUnrestrictedMarker() {
        Map<String, Object> view = WorkspaceEnvironmentController.jobCapabilityView(
                "windows-host",
                capability("{\"backendKind\":\"windows-host\",\"canStart\":true,"
                        + "\"canIsolateFilesystem\":false,\"available\":true}"));

        assertEquals(false, view.get("canIsolateFilesystem"));
        assertEquals(true, view.get("available"));
    }

    @Test
    void containerJobsAndUnreachableRuntimeBothStayUnavailable() {
        Map<String, Object> container = WorkspaceEnvironmentController.jobCapabilityView(
                "docker", new RuntimeJobClient.JobCapabilityResult(true, true, null, null));
        assertEquals("docker", container.get("backendKind"));
        assertEquals(false, container.get("available"));
        assertEquals("CONTAINER_JOBS_SERVED_BY_DOCKER", container.get("unavailableReason"));

        Map<String, Object> unreachable = WorkspaceEnvironmentController.jobCapabilityView(
                "windows-host", new RuntimeJobClient.JobCapabilityResult(false, false, null, null));
        assertEquals("windows-host", unreachable.get("backendKind"));
        assertEquals(false, unreachable.get("available"));
        assertEquals("RUNTIME_UNREACHABLE", unreachable.get("unavailableReason"));
    }

    @Test
    void forbiddenTransportKeysNeverReachTheResponse() {
        Map<String, Object> view = WorkspaceEnvironmentController.jobCapabilityView(
                "windows-mxc",
                capability("{\"backendKind\":\"windows-mxc\",\"canStart\":true,\"available\":true,"
                        + "\"policyPath\":\"C:/secret/policy.json\",\"pid\":42,"
                        + "\"wrapperPid\":7,\"mxcTier\":\"tier1\"}"));

        for (String forbidden : new String[]{"policyPath", "pid", "wrapperPid", "mxcTier"}) {
            assertFalse(view.containsKey(forbidden), "leaked " + forbidden + ": " + view);
        }
        // 白名单之外一律不出现（含 checkedAt 共 11 个键）。
        assertTrue(
                java.util.Set.of(
                        "backendKind", "backendRevision", "maturity", "executionMode", "canStart",
                        "canCancel", "canStreamOutput", "canIsolateFilesystem", "available",
                        "unavailableReason", "checkedAt")
                        .containsAll(view.keySet()),
                "unexpected keys: " + view.keySet());
    }

    @Test
    void runtimeProblemCodeIsSurfacedInsteadOfUnreachable() {
        Map<String, Object> view = WorkspaceEnvironmentController.jobCapabilityView(
                "windows-host",
                RuntimeJobClient.JobCapabilityResult.problemResult("DIRECTORY_NOT_FOUND"));

        assertEquals(false, view.get("available"));
        assertEquals("DIRECTORY_NOT_FOUND", view.get("unavailableReason"));
    }

    /**
     * PLAN-0379 T3.7：创建后 Runtime 启动/状态失败时，Workspace 保留并投影为
     * blocked（不删除 Workspace，也不伪装 ready）。
     */
    @Test
    void runtimeFailureProjectsAsBlockedAndKeepsTheWorkspaceView() {
        Map<String, Object> unavailable = WorkspaceEnvironmentController.runtimeStatusUnavailableView();
        assertEquals("blocked", unavailable.get("status"));
        assertEquals("Runtime status unavailable", unavailable.get("lastError"));

        assertEquals("blocked", WorkspaceEnvironmentController.mapRuntimeState("failed"));
        assertEquals("materializing", WorkspaceEnvironmentController.mapRuntimeState("creating"));
        assertEquals("ready", WorkspaceEnvironmentController.mapRuntimeState("ready"));
    }
}