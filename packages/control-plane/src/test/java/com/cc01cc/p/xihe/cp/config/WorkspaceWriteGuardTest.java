package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WorkspaceWriteGuardTest {

    @Test
    void readMethodsAreAllowedForAnyMemberRole() {
        assertEquals(WorkspaceWriteGuard.Requirement.READ,
                WorkspaceWriteGuard.requirement("GET", "/api/v1/chat/approvals"));
        assertTrue(WorkspaceWriteGuard.allows("VIEWER", WorkspaceWriteGuard.Requirement.READ));
        assertTrue(WorkspaceWriteGuard.allows("EDITOR", WorkspaceWriteGuard.Requirement.READ));
        assertTrue(WorkspaceWriteGuard.allows("OWNER", WorkspaceWriteGuard.Requirement.READ));
    }

    @Test
    void workspaceWritesRequireEditorOrOwner() {
        assertEquals(WorkspaceWriteGuard.Requirement.WRITE,
                WorkspaceWriteGuard.requirement("POST", "/api/v1/chat"));
        assertEquals(WorkspaceWriteGuard.Requirement.WRITE,
                WorkspaceWriteGuard.requirement("POST", "/api/v1/workspaces/abc/checkpoints/revert"));
        assertEquals(WorkspaceWriteGuard.Requirement.WRITE,
                WorkspaceWriteGuard.requirement("POST", "/api/v1/rag/ingest"));

        assertFalse(WorkspaceWriteGuard.allows("VIEWER", WorkspaceWriteGuard.Requirement.WRITE));
        assertTrue(WorkspaceWriteGuard.allows("EDITOR", WorkspaceWriteGuard.Requirement.WRITE));
        assertTrue(WorkspaceWriteGuard.allows("OWNER", WorkspaceWriteGuard.Requirement.WRITE));
    }

    @Test
    void workspaceLifecycleRequiresOwner() {
        assertEquals(WorkspaceWriteGuard.Requirement.MANAGE,
                WorkspaceWriteGuard.requirement("PATCH", "/api/v1/workspaces/abc"));
        assertEquals(WorkspaceWriteGuard.Requirement.MANAGE,
                WorkspaceWriteGuard.requirement("DELETE", "/api/v1/workspaces/abc"));
        assertEquals(WorkspaceWriteGuard.Requirement.MANAGE,
                WorkspaceWriteGuard.requirement("PATCH", "/api/v1/workspaces/abc/execution-mode"));
        assertEquals(WorkspaceWriteGuard.Requirement.MANAGE,
                WorkspaceWriteGuard.requirement("POST", "/api/v1/workspaces/abc/runtime/release"));

        assertFalse(WorkspaceWriteGuard.allows("VIEWER", WorkspaceWriteGuard.Requirement.MANAGE));
        assertFalse(WorkspaceWriteGuard.allows("EDITOR", WorkspaceWriteGuard.Requirement.MANAGE));
        assertTrue(WorkspaceWriteGuard.allows("OWNER", WorkspaceWriteGuard.Requirement.MANAGE));
    }

    @Test
    void userScopedWritesAreNotWorkspaceGuarded() {
        assertEquals(WorkspaceWriteGuard.Requirement.READ,
                WorkspaceWriteGuard.requirement("POST", "/api/v1/config/user/llm-provider"));
        assertEquals(WorkspaceWriteGuard.Requirement.READ,
                WorkspaceWriteGuard.requirement("POST", "/api/v1/credentials"));
        assertEquals(WorkspaceWriteGuard.Requirement.READ,
                WorkspaceWriteGuard.requirement("POST", "/api/v1/workspaces"));
        // MCP is classified in the controller by JSON-RPC method, not here.
        assertEquals(WorkspaceWriteGuard.Requirement.READ,
                WorkspaceWriteGuard.requirement("POST", "/api/v1/mcp"));
    }
}
