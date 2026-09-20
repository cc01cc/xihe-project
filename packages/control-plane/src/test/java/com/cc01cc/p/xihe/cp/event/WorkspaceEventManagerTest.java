package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
}
