package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * BL-279 (A1): the export precheck must refuse a session whose message count exceeds
 * {@link SessionExportService#MAX_MESSAGES} **before any message row is materialised**, and it must
 * use the same constant as the renderer (single source, no drifting second literal).
 *
 * <p>These are controller-level tests: the read surface is a mock so the "never read" assertion is
 * exact ({@code listVisibleMessages} not called), while {@link SessionExportService} is the real
 * renderer so the 200-path document content is the shipped one.
 */
@ExtendWith(MockitoExtension.class)
class SessionExportControllerTest {

    private static final String SESSION = "8f1c2b3d-0000-4000-8000-000000000001";
    private static final String BRANCH = "8f1c2b3d-0000-4000-8000-000000000002";

    @Mock
    private SessionService sessionService;
    @Mock
    private MessageReadService messageReadService;
    @Mock
    private BranchPathService branchPathService;

    private final SessionExportService exportService = new SessionExportService();

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    private SessionExportController controllerWith(String userId, String workspaceId) {
        TenantContext.setUserId(userId);
        TenantContext.setWorkspaceId(workspaceId);
        when(branchPathService.resolveVisibility(SESSION, BRANCH))
                .thenReturn(new BranchPathService.BranchVisibility(BRANCH, Map.of()));
        when(branchPathService.resolvePath(SESSION, BRANCH)).thenReturn(BRANCH);
        return new SessionExportController(sessionService, messageReadService, branchPathService,
                exportService);
    }

    private static Map<String, Object> message(String role, String content) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("role", role);
        dto.put("createdAt", "2026-11-05T00:00:00Z");
        dto.put("content", content);
        return dto;
    }

    @Test
    void exportsBelowTheLimitAndRendersTheShippedDocument() {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        when(messageReadService.countSessionMessages(SESSION)).thenReturn(2L);
        when(messageReadService.listVisibleMessages(anyString(), anyString(), anyString(), any()))
                .thenReturn(List.of(message("user", "hello"), message("assistant", "world")));

        ResponseEntity<?> response = controller.export(SESSION, BRANCH);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        String markdown = String.valueOf(response.getBody());
        assertTrue(markdown.startsWith("# Session export\n"), markdown);
        assertTrue(markdown.contains("- messages: 2"), markdown);
        assertTrue(markdown.contains("## 1. user"), markdown);
        assertTrue(markdown.contains("world"), markdown);
        verify(messageReadService).listVisibleMessages(anyString(), anyString(), anyString(), any());
    }

    @Test
    void acceptsExactlyTheLimitAsTheBoundary() {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        when(messageReadService.countSessionMessages(SESSION))
                .thenReturn((long) SessionExportService.MAX_MESSAGES);
        when(messageReadService.listVisibleMessages(anyString(), anyString(), anyString(), any()))
                .thenReturn(List.of(message("user", "boundary")));

        ResponseEntity<?> response = controller.export(SESSION, BRANCH);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        verify(messageReadService).listVisibleMessages(anyString(), anyString(), anyString(), any());
    }

    @Test
    void refusesOverTheLimitBeforeReadingAnyMessage() {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        long total = SessionExportService.MAX_MESSAGES + 1L;
        when(messageReadService.countSessionMessages(SESSION)).thenReturn(total);

        ResponseEntity<?> response = controller.export(SESSION, BRANCH);

        assertEquals(HttpStatus.PAYLOAD_TOO_LARGE, response.getStatusCode());
        @SuppressWarnings("unchecked")
        Map<String, Object> body = (Map<String, Object>) response.getBody();
        assertEquals("EXPORT_TOO_LARGE", body.get("code"));
        String detail = String.valueOf(body.get("detail"));
        assertTrue(detail.contains(String.valueOf(total)), detail);
        assertTrue(detail.contains(String.valueOf(SessionExportService.MAX_MESSAGES)), detail);
        assertEquals(total, body.get("messages"));
        assertEquals(SessionExportService.MAX_MESSAGES, body.get("limit"));
        verify(messageReadService).countSessionMessages(SESSION);
        verify(messageReadService, never()).listVisibleMessages(anyString(), anyString(), anyString(), any());
    }

    @Test
    void precheckRunsAfterAuthorizationAndBeforeTheRead() {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        when(messageReadService.countSessionMessages(SESSION)).thenReturn(1L);
        when(messageReadService.listVisibleMessages(anyString(), anyString(), anyString(), any()))
                .thenReturn(List.of(message("user", "ordered")));

        controller.export(SESSION, BRANCH);

        InOrder order = inOrder(sessionService, messageReadService);
        order.verify(sessionService).requireCurrent(SESSION, userId, workspaceId);
        order.verify(messageReadService).countSessionMessages(SESSION);
        order.verify(messageReadService).listVisibleMessages(anyString(), anyString(), anyString(), any());
    }

    @Test
    void refusesWithoutWorkspaceContext() {
        SessionExportController controller = new SessionExportController(sessionService,
                messageReadService, branchPathService, exportService);

        ResponseEntity<?> response = controller.export(SESSION, BRANCH);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        @SuppressWarnings("unchecked")
        Map<String, Object> body = (Map<String, Object>) response.getBody();
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", body.get("code"));
        verify(messageReadService, never()).countSessionMessages(anyString());
        assertFalse(body.containsKey("messages"));
        assertNull(body.get("limit"));
    }
}
