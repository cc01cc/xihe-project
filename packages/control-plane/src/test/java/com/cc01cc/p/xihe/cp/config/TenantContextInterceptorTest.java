package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TenantContextInterceptorTest {

    @Test
    void tenantContext_storesAndClearsUserId() {
        TenantContext.setUserId("user-1");
        assertEquals("user-1", TenantContext.getUserId());
        TenantContext.clear();
        assertNull(TenantContext.getUserId());
    }

    @Test
    void tenantContext_storesAndClearsWorkspaceId() {
        TenantContext.setWorkspaceId("ws-1");
        assertEquals("ws-1", TenantContext.getWorkspaceId());
        TenantContext.clear();
        assertNull(TenantContext.getWorkspaceId());
    }

    @Test
    void tenantContext_storesAndClearsWorkspacePath() {
        TenantContext.setWorkspacePath("/data/xihe/workspaces/test");
        assertEquals("/data/xihe/workspaces/test", TenantContext.getWorkspacePath());
        TenantContext.clear();
        assertNull(TenantContext.getWorkspacePath());
    }

    @Test
    void tenantContext_storesAndClearsUserRole() {
        TenantContext.setUserRole("ADMIN");
        assertEquals("ADMIN", TenantContext.getUserRole());
        TenantContext.clear();
        assertNull(TenantContext.getUserRole());
    }

    @Test
    void tenantContext_clearRemovesAll() {
        TenantContext.setUserId("u1");
        TenantContext.setWorkspaceId("ws1");
        TenantContext.setWorkspacePath("/path");
        TenantContext.setUserRole("VIEWER");
        TenantContext.clear();
        assertAll(
            () -> assertNull(TenantContext.getUserId()),
            () -> assertNull(TenantContext.getWorkspaceId()),
            () -> assertNull(TenantContext.getWorkspacePath()),
            () -> assertNull(TenantContext.getUserRole())
        );
    }

    @Test
    void tenantContext_defaultWorkspacePathIsNull() {
        TenantContext.clear();
        assertNull(TenantContext.getWorkspacePath());
    }

    @Test
    void tenantContext_workspacePathMatchesStorageFormat() {
        TenantContext.setWorkspacePath("/data/xihe/workspaces/a1b2c3d4");
        String path = TenantContext.getWorkspacePath();
        assertTrue(path.startsWith("/data/xihe/workspaces/"));
        String suffix = path.substring("/data/xihe/workspaces/".length());
        assertEquals(8, suffix.length());
        TenantContext.clear();
    }

    @Test
    void tenantContext_workspacePathRoundTrip() {
        TenantContext.setWorkspacePath("/data/xihe/workspaces/abcd1234");
        String path = TenantContext.getWorkspacePath();
        assertNotNull(path);
        TenantContext.clear();
        assertNull(TenantContext.getWorkspacePath());
    }
}
