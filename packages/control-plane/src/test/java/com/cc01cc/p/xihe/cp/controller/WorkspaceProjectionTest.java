package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.service.WorkspaceBackendPolicy;
import com.cc01cc.p.xihe.cp.service.WorkspaceImportSourceService;
import com.cc01cc.p.xihe.cp.service.WorkspaceNestedReposService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * task-837 (837b): hostPath is exposed by {@code (action:MANAGE_WORKSPACE_RUNTIME, fs:<workspaceId>)},
 * not by "the caller is the owner or an instance admin".
 *
 * <p>task-859 changed the product; this class pins the <b>criterion migration</b> in two directions —
 * an atom holder sees the path, and an OWNER/admin identity <b>without</b> the atom does not. Keeping
 * only one direction would not prove that {@code userId.equals(ownerId)} stopped deciding.</p>
 */
class WorkspaceProjectionTest {

    private static final String OWNER_ID = "owner-1";
    private static final UUID WORKSPACE_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");

    private WorkspaceService workspaceService;
    private RequesterAuthority requesterAuthority;
    private WorkspaceController controller;

    @BeforeEach
    void setUp() {
        workspaceService = Mockito.mock(WorkspaceService.class);
        requesterAuthority = Mockito.mock(RequesterAuthority.class);
        WorkspaceBackendPolicy backendPolicy = new WorkspaceBackendPolicy("");
        backendPolicy.validate();
        controller = new WorkspaceController(workspaceService, backendPolicy,
                Mockito.mock(WorkspaceNestedReposService.class), requesterAuthority,
                Mockito.mock(WorkspaceImportSourceService.class));
        TenantContext.setUserId(OWNER_ID);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void holder_of_the_hostpath_atom_sees_the_canonical_host_path() {
        Workspace workspace = workspace();
        stubWorkspaceLookup(workspace);
        // The caller holds action:MANAGE_WORKSPACE_RUNTIME on fs:<ws> — the atom decides, and the
        // caller below is deliberately NOT the owner, so ownership cannot be what admits them.
        when(requesterAuthority.allowsForUser(any(PolicyRequest.class), eq(WORKSPACE_ID)))
                .thenReturn(true);
        TenantContext.setUserId("some-workspace-owner");

        ResponseEntity<?> response = controller.get(WORKSPACE_ID.toString());

        assertEquals("C:/work/repo", view(response).get("hostPath"));
        ArgumentCaptor<PolicyRequest> request = ArgumentCaptor.forClass(PolicyRequest.class);
        Mockito.verify(requesterAuthority).allowsForUser(request.capture(), eq(WORKSPACE_ID));
        assertEquals(List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME),
                request.getValue().actionClasses(),
                "the decision must name the runtime-management atom, not a role");
        assertEquals(List.of("fs:" + WORKSPACE_ID), request.getValue().resources(),
                "the decision must be scoped to this workspace's fs: resource");
    }

    @Test
    void owner_or_admin_identity_without_the_atom_does_not_see_the_host_path() {
        Workspace workspace = workspace();
        stubWorkspaceLookup(workspace);
        // Same person as the owner, role OWNER — and still hidden, because the atom did not match.
        when(requesterAuthority.allowsForUser(any(PolicyRequest.class), eq(WORKSPACE_ID)))
                .thenReturn(false);

        ResponseEntity<?> response = controller.get(WORKSPACE_ID.toString());

        assertNull(view(response).get("hostPath"),
                "owner identity alone must no longer expose the host path");
    }

    @Test
    void ordinary_member_does_not_receive_the_raw_host_path() {
        Workspace workspace = workspace();

        Map<String, Object> view = WorkspaceController.toMap(workspace, "owner-1", "member-1", false,
                "EDITOR", null);

        assertNull(view.get("hostPath"));
    }

    @Test
    void projection_renders_the_path_only_when_the_decision_says_so() {
        Workspace workspace = workspace();

        // The projection is now a pure function of the decision flag; identity arguments cannot
        // re-introduce visibility (that is the whole point of the migration).
        assertEquals("C:/work/repo", WorkspaceController
                .toMap(workspace, "owner-1", "member-1", true, "EDITOR", null).get("hostPath"));
        assertNull(WorkspaceController
                .toMap(workspace, "owner-1", "owner-1", false, "OWNER", null).get("hostPath"));

        assertNull(WorkspaceEnvironmentController.visibleHostPath(workspace, "owner-1", "member-1", false));
        assertEquals("C:/work/repo",
                WorkspaceEnvironmentController.visibleHostPath(workspace, true));
        assertNull(WorkspaceEnvironmentController.visibleHostPath(workspace, false));
    }

    private void stubWorkspaceLookup(Workspace workspace) {
        when(workspaceService.requireAccessibleWorkspace(eq(WORKSPACE_ID.toString()), any()))
                .thenReturn(workspace);
        when(workspaceService.ownerIdOf(WORKSPACE_ID)).thenReturn(OWNER_ID);
        when(workspaceService.resolveWorkspaceRole(WORKSPACE_ID.toString(), OWNER_ID)).thenReturn("OWNER");
        when(workspaceService.listRoots(WORKSPACE_ID.toString())).thenReturn(List.of());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> view(ResponseEntity<?> response) {
        assertEquals(200, response.getStatusCode().value());
        assertTrue(response.getBody() instanceof Map<?, ?>, "the workspace view must be a map");
        return (Map<String, Object>) response.getBody();
    }

    private static Workspace workspace() {
        Workspace workspace = new Workspace("workspace");
        workspace.setId(WORKSPACE_ID);
        workspace.setHostPath("C:/work/repo");
        workspace.setStorageMode("direct_attach");
        workspace.setExecutionMode("windows-mxc");
        return workspace;
    }
}
