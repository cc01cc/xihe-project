package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import com.cc01cc.p.xihe.cp.service.WorkspaceExecutionSpecService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * BL-415: the Runtime indexes {@code roots[0]}; sending {@code roots: []} for a legacy
 * spec (V104 added the column without backfilling) panicked there and surfaced as 503.
 */
class RuntimeExecutionSpecControllerTest {

    private static final String WORKSPACE_ID = "00000000-0000-0000-0000-0000000000a1";

    @Test
    void synthesizesPrimaryRootFromHostPathWhenRootsColumnIsNull() {
        WorkspaceExecutionSpecService executionSpecService = mock(WorkspaceExecutionSpecService.class);
        WorkspaceService workspaceService = mock(WorkspaceService.class);
        RuntimeExecutionSpecController controller =
                new RuntimeExecutionSpecController(executionSpecService, workspaceService, new ObjectMapper());
        when(executionSpecService.findCurrentExecutionSpec(WORKSPACE_ID)).thenReturn(legacySpec(null));
        when(workspaceService.requireActiveWorkspace(WORKSPACE_ID)).thenReturn(workspace());

        RuntimeExecutionSpecController.WorkspaceExecutionSpecResponse response =
                controller.getCurrentSpec(WORKSPACE_ID);

        assertEquals(
                List.of(Map.of("rootId", WORKSPACE_ID, "hostPath", "C:/ws/legacy")),
                response.roots());
        assertEquals("C:/ws/legacy", response.hostPath());
    }

    /** An empty JSON array is the same "never backfilled" shape and must not be forwarded either. */
    @Test
    void synthesizesPrimaryRootWhenRootsArrayIsEmpty() {
        WorkspaceExecutionSpecService executionSpecService = mock(WorkspaceExecutionSpecService.class);
        WorkspaceService workspaceService = mock(WorkspaceService.class);
        RuntimeExecutionSpecController controller =
                new RuntimeExecutionSpecController(executionSpecService, workspaceService, new ObjectMapper());
        when(executionSpecService.findCurrentExecutionSpec(WORKSPACE_ID)).thenReturn(legacySpec("[]"));
        when(workspaceService.requireActiveWorkspace(WORKSPACE_ID)).thenReturn(workspace());

        RuntimeExecutionSpecController.WorkspaceExecutionSpecResponse response =
                controller.getCurrentSpec(WORKSPACE_ID);

        assertEquals(
                List.of(Map.of("rootId", WORKSPACE_ID, "hostPath", "C:/ws/legacy")),
                response.roots());
    }

    @Test
    void keepsDeclaredRootsVerbatimWhenPopulated() {
        WorkspaceExecutionSpecService executionSpecService = mock(WorkspaceExecutionSpecService.class);
        WorkspaceService workspaceService = mock(WorkspaceService.class);
        RuntimeExecutionSpecController controller =
                new RuntimeExecutionSpecController(executionSpecService, workspaceService, new ObjectMapper());
        when(executionSpecService.findCurrentExecutionSpec(WORKSPACE_ID))
                .thenReturn(legacySpec("[{\"rootId\":\"root-b\",\"hostPath\":\"D:/ws/root-b\"}]"));
        when(workspaceService.requireActiveWorkspace(WORKSPACE_ID)).thenReturn(workspace());

        RuntimeExecutionSpecController.WorkspaceExecutionSpecResponse response =
                controller.getCurrentSpec(WORKSPACE_ID);

        assertEquals(
                List.of(Map.of("rootId", "root-b", "hostPath", "D:/ws/root-b")),
                response.roots());
    }

    private static WorkspaceExecutionSpec legacySpec(String rootsJson) {
        WorkspaceExecutionSpec spec = new WorkspaceExecutionSpec();
        spec.setWorkspaceId(WORKSPACE_ID);
        spec.setGeneration(2);
        spec.setSandboxSpecHash("a".repeat(64));
        spec.setSandboxSpec("{\"profile\":\"strict\"}");
        spec.setStorageBackend("host_directory");
        spec.setStorageRef(WORKSPACE_ID);
        spec.setRoots(rootsJson);
        return spec;
    }

    private static Workspace workspace() {
        Workspace workspace = new Workspace();
        workspace.setId(UUID.fromString(WORKSPACE_ID));
        workspace.setHostPath("C:/ws/legacy");
        workspace.setStorageMode("direct_attach");
        workspace.setExecutionMode("windows-host");
        return workspace;
    }
}
