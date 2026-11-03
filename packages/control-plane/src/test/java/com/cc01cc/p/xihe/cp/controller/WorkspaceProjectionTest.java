package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class WorkspaceProjectionTest {

    @Test
    void ordinaryMemberDoesNotReceiveRawHostPath() {
        Workspace workspace = workspace();

        Map<String, Object> view = WorkspaceController.toMap(workspace, "owner-1", "member-1", false,
                "EDITOR", null);

        assertNull(view.get("hostPath"));
    }

    @Test
    void ownerAndAdminMayReceiveCanonicalHostPath() {
        Workspace workspace = workspace();

        // PLAN-0610 W4b: the owner id is derived from the WS_OWNER binding and passed in.
        assertEquals("C:/work/repo", WorkspaceController
                .toMap(workspace, "owner-1", "owner-1", false, "OWNER", null).get("hostPath"));
        assertEquals("C:/work/repo", WorkspaceController
                .toMap(workspace, "owner-1", "member-1", true, "EDITOR", null).get("hostPath"));
        assertNull(WorkspaceEnvironmentController.visibleHostPath(workspace, "owner-1", "member-1", false));
        assertEquals("C:/work/repo",
                WorkspaceEnvironmentController.visibleHostPath(workspace, "owner-1", "owner-1", false));
    }

    private static Workspace workspace() {
        Workspace workspace = new Workspace("workspace");
        workspace.setHostPath("C:/work/repo");
        workspace.setStorageMode("direct_attach");
        workspace.setExecutionMode("windows-mxc");
        return workspace;
    }
}
