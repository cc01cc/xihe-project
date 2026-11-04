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
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * BL-279 (A1): the export precheck must refuse a session whose message count exceeds
 * {@link SessionExportService#MAX_MESSAGES} **before any message row is materialised**, and it must
 * use the same constant as the renderer (single source, no drifting second literal).
 *
 * <p>PLAN-0670 M2c/B: the success path is now a {@link StreamingResponseBody}. These tests execute
 * the body (exactly what the servlet container does) and assert on the produced Markdown bytes, so
 * "streaming" cannot silently change the document; they also assert that the precheck runs before
 * the renderer and that a client disconnect propagates instead of being swallowed.
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
    @Mock
    private SessionExportStreamRenderer streamRenderer;

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
                streamRenderer);
    }

    private static Map<String, Object> message(String role, String content) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("role", role);
        dto.put("createdAt", "2026-11-05T00:00:00Z");
        dto.put("content", content);
        return dto;
    }

    private static String bodyText(ResponseEntity<?> response) throws IOException {
        Object body = response.getBody();
        assertNotNull(body, "successful export must carry a body");
        assertTrue(body instanceof StreamingResponseBody, "export body must be streamed");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ((StreamingResponseBody) body).writeTo(output);
        return output.toString(StandardCharsets.UTF_8);
    }

    @Test
    void exportsBelowTheLimitAndRendersTheShippedDocument() throws IOException {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        when(messageReadService.countSessionMessages(SESSION)).thenReturn(2L);
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any()))
                .thenReturn(exportService.render(SESSION,
                        List.of(message("user", "hello"), message("assistant", "world"))));

        ResponseEntity<?> response = controller.export(SESSION, BRANCH);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(-1L, response.getHeaders().getContentLength(),
                "streamed body must not carry a Content-Length (chunked transfer)");
        assertEquals("text/markdown;charset=UTF-8",
                String.valueOf(response.getHeaders().getContentType()));
        String markdown = bodyText(response);
        assertTrue(markdown.startsWith("# Session export\n"), markdown);
        assertTrue(markdown.contains("- messages: 2"), markdown);
        assertTrue(markdown.contains("## 1. user"), markdown);
        assertTrue(markdown.contains("world"), markdown);
        verify(streamRenderer).render(eq(SESSION), eq(workspaceId), eq(BRANCH), any());
        verify(messageReadService, never()).listVisibleMessages(anyString(), anyString(), anyString(), any(), anyString());
    }

    @Test
    void acceptsExactlyTheLimitAsTheBoundary() {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        when(messageReadService.countSessionMessages(SESSION))
                .thenReturn((long) SessionExportService.MAX_MESSAGES);
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any()))
                .thenReturn(exportService.render(SESSION, List.of(message("user", "boundary"))));

        ResponseEntity<?> response = controller.export(SESSION, BRANCH);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        verify(streamRenderer).render(eq(SESSION), eq(workspaceId), eq(BRANCH), any());
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
        verify(streamRenderer, never()).render(anyString(), anyString(), anyString(), any());
    }

    @Test
    void precheckRunsAfterAuthorizationAndBeforeTheRead() {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        when(messageReadService.countSessionMessages(SESSION)).thenReturn(1L);
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any()))
                .thenReturn(exportService.render(SESSION, List.of(message("user", "ordered"))));

        controller.export(SESSION, BRANCH);

        InOrder order = inOrder(sessionService, messageReadService, streamRenderer);
        order.verify(sessionService).requireCurrent(SESSION, userId, workspaceId);
        order.verify(messageReadService).countSessionMessages(SESSION);
        order.verify(streamRenderer).render(eq(SESSION), eq(workspaceId), eq(BRANCH), any());
    }

    @Test
    void refusesWithoutWorkspaceContext() {
        SessionExportController controller = new SessionExportController(sessionService,
                messageReadService, branchPathService, streamRenderer);

        ResponseEntity<?> response = controller.export(SESSION, BRANCH);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        @SuppressWarnings("unchecked")
        Map<String, Object> body = (Map<String, Object>) response.getBody();
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", body.get("code"));
        verify(messageReadService, never()).countSessionMessages(anyString());
        verify(streamRenderer, never()).render(anyString(), anyString(), anyString(), any());
        assertFalse(body.containsKey("messages"));
        assertNull(body.get("limit"));
    }

    @Test
    void clientDisconnectPropagatesAndStopsTheWrite() {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        String huge = "x".repeat(SessionExportService.MAX_MESSAGE_CHARS);
        when(messageReadService.countSessionMessages(SESSION)).thenReturn(1L);
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any()))
                .thenReturn(exportService.render(SESSION,
                        List.of(message("user", huge), message("assistant", huge))));
        ResponseEntity<?> response = controller.export(SESSION, BRANCH);
        StreamingResponseBody body = (StreamingResponseBody) response.getBody();

        IOException disconnected = assertThrows(IOException.class,
                () -> body.writeTo(new OutputStream() {
                    private int accepted;

                    @Override
                    public void write(int value) throws IOException {
                        accepted += 1;
                        if (accepted > 1024) {
                            throw new IOException("client went away");
                        }
                    }
                }));
        assertEquals("client went away", disconnected.getMessage());
    }
}
