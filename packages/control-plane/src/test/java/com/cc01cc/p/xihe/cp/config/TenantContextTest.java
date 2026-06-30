package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class TenantContextTest {

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void setAndGetUserId() {
        TenantContext.setUserId("user-a");
        assertEquals("user-a", TenantContext.getUserId());
    }

    @Test
    void setAndGetWorkspaceId() {
        TenantContext.setWorkspaceId("ws-a");
        assertEquals("ws-a", TenantContext.getWorkspaceId());
    }

    @Test
    void setAndGetUserRole() {
        TenantContext.setUserRole("MEMBER");
        assertEquals("MEMBER", TenantContext.getUserRole());
    }

    @Test
    void setAndGetWorkspacePath() {
        TenantContext.setWorkspacePath("/data/xihe/workspaces/ws-a");
        assertEquals("/data/xihe/workspaces/ws-a", TenantContext.getWorkspacePath());
    }

    @Test
    void setAndGetWorkspaceRole() {
        TenantContext.setWorkspaceRole("ADMIN");
        assertEquals("ADMIN", TenantContext.getWorkspaceRole());
    }

    @Test
    void returnsNullWhenNotSet() {
        TenantContext.clear();

        assertNull(TenantContext.getUserId());
        assertNull(TenantContext.getWorkspaceId());
        assertNull(TenantContext.getWorkspacePath());
        assertNull(TenantContext.getUserRole());
        assertNull(TenantContext.getWorkspaceRole());
    }

    @Test
    void clearRemovesAllValues() {
        TenantContext.setUserId("user-1");
        TenantContext.setWorkspaceId("ws-1");
        TenantContext.setWorkspacePath("/data/ws-1");
        TenantContext.setUserRole("USER");
        TenantContext.setWorkspaceRole("MEMBER");

        assertNotNull(TenantContext.getUserId());
        assertNotNull(TenantContext.getWorkspaceId());
        assertNotNull(TenantContext.getWorkspacePath());
        assertNotNull(TenantContext.getUserRole());
        assertNotNull(TenantContext.getWorkspaceRole());

        TenantContext.clear();

        assertNull(TenantContext.getUserId());
        assertNull(TenantContext.getWorkspaceId());
        assertNull(TenantContext.getWorkspacePath());
        assertNull(TenantContext.getUserRole());
        assertNull(TenantContext.getWorkspaceRole());
    }

    @Test
    void threadLocalIsolationBetweenThreads() throws InterruptedException {
        TenantContext.setUserId("main-thread");
        TenantContext.setWorkspaceId("ws-main");
        TenantContext.setWorkspacePath("/data/ws-main");
        TenantContext.setUserRole("USER");
        TenantContext.setWorkspaceRole("OWNER");

        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> childUserId = new AtomicReference<>();
        AtomicReference<String> childWorkspaceId = new AtomicReference<>();
        AtomicReference<String> childWorkspacePath = new AtomicReference<>();
        AtomicReference<String> childUserRole = new AtomicReference<>();
        AtomicReference<String> childWorkspaceRole = new AtomicReference<>();

        Thread child = new Thread(() -> {
            TenantContext.setUserId("child-thread");
            TenantContext.setWorkspaceId("ws-child");
            TenantContext.setWorkspacePath("/data/ws-child");
            TenantContext.setUserRole("ADMIN");
            TenantContext.setWorkspaceRole("MEMBER");
            childUserId.set(TenantContext.getUserId());
            childWorkspaceId.set(TenantContext.getWorkspaceId());
            childWorkspacePath.set(TenantContext.getWorkspacePath());
            childUserRole.set(TenantContext.getUserRole());
            childWorkspaceRole.set(TenantContext.getWorkspaceRole());
            TenantContext.clear();
            latch.countDown();
        });

        child.start();
        latch.await();
        child.join(2000);

        assertEquals("child-thread", childUserId.get());
        assertEquals("ws-child", childWorkspaceId.get());
        assertEquals("/data/ws-child", childWorkspacePath.get());
        assertEquals("ADMIN", childUserRole.get());
        assertEquals("MEMBER", childWorkspaceRole.get());

        assertEquals("main-thread", TenantContext.getUserId());
        assertEquals("ws-main", TenantContext.getWorkspaceId());
        assertEquals("/data/ws-main", TenantContext.getWorkspacePath());
        assertEquals("USER", TenantContext.getUserRole());
        assertEquals("OWNER", TenantContext.getWorkspaceRole());
    }

    @Test
    void multipleThreadsDoNotShareContext() throws InterruptedException {
        TenantContext.setUserId("main");
        int threadCount = 5;
        CountDownLatch latch = new CountDownLatch(threadCount);
        AtomicReference<Throwable> error = new AtomicReference<>();

        for (int i = 0; i < threadCount; i++) {
            final int threadNum = i;
            Thread t = new Thread(() -> {
                try {
                    TenantContext.setUserId("thread-" + threadNum);
                    assertEquals("thread-" + threadNum, TenantContext.getUserId());
                } catch (Throwable e) {
                    error.set(e);
                } finally {
                    TenantContext.clear();
                    latch.countDown();
                }
            });
            t.start();
        }

        latch.await();

        assertNull(error.get());
        assertEquals("main", TenantContext.getUserId());
    }

    @Test
    void valuesAreIsolatedAfterClear() {
        TenantContext.setUserId("user-1");
        TenantContext.clear();
        TenantContext.setUserId("user-2");

        assertEquals("user-2", TenantContext.getUserId());
    }
}
