package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class WorkspaceEventManagerTest {

    private final WorkspaceEventManager manager = new WorkspaceEventManager();

    @AfterEach
    void tearDown() {
        manager.completeWorkspace("ws-1", "test_cleanup");
        manager.completeWorkspace("ws-2", "test_cleanup");
    }

    @Test
    void publishAllocatesSequencePerWorkspaceAndKeepsWorkspaceScope() {
        WorkspaceEvent first = manager.publish(
                "ws-1", "file_changed", "src/main.ts", "modified", "runtime", null, null);
        WorkspaceEvent second = manager.publish(
                "ws-1", "file_changed", "src/main.ts", "modified", "runtime", null, null);
        WorkspaceEvent otherWorkspace = manager.publish(
                "ws-2", "file_changed", "README.md", "created", "runtime", null, null);

        assertEquals(1L, first.sequence());
        assertEquals(2L, second.sequence());
        assertEquals(1L, otherWorkspace.sequence());
        assertEquals(2L, manager.currentSequence("ws-1"));
    }

    @Test
    void subscribeAcceptsLastEventIdAndCanBeClosed() {
        manager.publish("ws-1", "file_changed", "src/main.ts", "modified", "runtime", null, null);
        SseEmitter emitter = manager.subscribe("ws-1", 0L);

        assertNotNull(emitter);
        assertEquals(1L, manager.currentSequence("ws-1"));
        manager.completeWorkspace("ws-1", "workspace_deleted");
        assertEquals(0L, manager.currentSequence("ws-1"));
    }

    @Test
    void invalidHostPathIsRejected() {
        CpApiException exception = assertThrows(
                CpApiException.class,
                () -> manager.publish("ws-1", "file_changed", "C:\\repo\\file.ts", "modified", "runtime", null, null));

        assertEquals("INVALID_WORKSPACE_PATH", exception.getCode());
        assertFalse(exception.getMessage().isBlank());
    }

    @Test
    void scheduledTasksChangedKindIsAcceptedWithWorkspaceScopedEnvelope() {
        WorkspaceEvent event = manager.publishScheduledTasksChanged("ws-1");

        assertEquals(WorkspaceEventManager.KIND_SCHEDULED_TASKS_CHANGED, event.kind());
        assertEquals("scheduled_tasks_changed", event.kind());
        assertEquals("ws-1", event.workspaceId());
        assertEquals(1L, event.sequence());
        assertNull(event.path(), "scheduled_tasks_changed carries no per-row path payload");
        assertNull(event.changeType(), "scheduled_tasks_changed carries no per-row change payload");
        assertNull(event.reason());
        assertNull(event.status());
        assertEquals("control-plane", event.source());
    }

    /**
     * PLAN-0691 T1.6a: the attach/detach helper stays on the pinned kind and carries only the coarse
     * cause ({@code reason}); consecutive catalog changes consume consecutive sequences. The 9-field
     * envelope is deliberately untouched — per-binding payload fields are T1.6b's cross-wire decision.
     */
    @Test
    void pluginBindingChangedHelperAnnouncesKindOnlyChangesInOrder() {
        WorkspaceEvent attached = manager.publishPluginBindingChanged("ws-1", "attach");
        WorkspaceEvent detached = manager.publishPluginBindingChanged("ws-1", "detach");

        assertEquals(WorkspaceEventManager.KIND_PLUGIN_BINDING, attached.kind());
        assertEquals("plugin_binding", attached.kind());
        assertEquals("attach", attached.reason(),
                "the cause is diagnostic text, not an authorization input");
        assertEquals("control-plane", attached.source());
        assertNull(attached.path(), "kind-only: the envelope has no per-binding payload");
        assertNull(attached.changeType());
        assertNull(attached.status());
        assertEquals(1L, attached.sequence());
        assertEquals("detach", detached.reason());
        assertEquals(2L, detached.sequence(), "each catalog change consumes exactly one sequence");
    }

    /**
     * PLAN-0691 T1.6-C1：`plugin_binding` 是跨 lane 的 wire 字面量（UI 分支 + lane A 的
     * binding 端点共用）。这条测试同时钉死字面量与"白名单能收"两个事实——只钉字面量会漏掉
     * 白名单忘加，只钉白名单会漏掉改名。
     */
    @Test
    void pluginBindingKindIsAcceptedAndPinnedToTheCrossLaneLiteral() {
        assertEquals("plugin_binding", WorkspaceEventManager.KIND_PLUGIN_BINDING);

        WorkspaceEvent event = manager.publish(
                "ws-1", WorkspaceEventManager.KIND_PLUGIN_BINDING, null, null, "control-plane", null, null);

        assertEquals("plugin_binding", event.kind());
        assertEquals("ws-1", event.workspaceId());
        assertEquals(1L, event.sequence());
        assertNull(event.path(), "plugin_binding carries no per-row path payload in the 9-field envelope");
        assertEquals("control-plane", event.source());
    }

    /**
     * 反过来的一侧：白名单是白名单，不是通配。漏登记最坏后果是"attach 事务已提交但 SSE 400、
     * UI 不刷新、看着像卡住"，所以"看起来像"的拼写必须仍然被拒。
     */
    @Test
    void pluginBindingKindIsNotAWildcardForLookalikeSpellings() {
        CpApiException exception = assertThrows(
                CpApiException.class,
                () -> manager.publish(
                        "ws-1", "plugin_bindings", null, null, "control-plane", null, null));

        assertEquals("INVALID_REQUEST", exception.getCode());
        assertEquals(0L, manager.currentSequence("ws-1"), "rejected publish must not consume a sequence");
    }
}
