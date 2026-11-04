package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

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
 * <p>PLAN-0670 M2c/B: the success face is a {@link StreamingResponseBody} (declared return type is
 * required by Spring MVC to dispatch it, so error faces throw {@link CpApiException}). These tests
 * drive the real body into a {@link MockHttpServletResponse} and assert on the produced Markdown
 * bytes, chunked headers, precheck ordering and disconnect propagation.
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

    private static String bodyText(StreamingResponseBody body) throws IOException {
        MockHttpServletResponse response = new MockHttpServletResponse();
        body.writeTo(response.getOutputStream());
        return response.getContentAsString(StandardCharsets.UTF_8);
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
        MockHttpServletResponse response = new MockHttpServletResponse();

        StreamingResponseBody body = controller.export(SESSION, BRANCH, response);

        assertEquals(200, response.getStatus());
        assertEquals("text/markdown;charset=UTF-8", response.getContentType());
        assertNull(response.getHeader("Content-Length"),
                "streamed export must not announce a Content-Length (chunked transfer)");
        String disposition = response.getHeader("Content-Disposition");
        assertNotNull(disposition);
        assertTrue(disposition.startsWith("attachment;"), disposition);
        assertTrue(disposition.contains("session-" + SESSION + ".md"), disposition);
        String markdown = bodyText(body);
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

        StreamingResponseBody body = controller.export(SESSION, BRANCH, new MockHttpServletResponse());

        assertNotNull(body);
        verify(streamRenderer).render(eq(SESSION), eq(workspaceId), eq(BRANCH), any());
    }

    @Test
    void refusesOverTheLimitBeforeReadingAnyMessage() {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        long total = SessionExportService.MAX_MESSAGES + 1L;
        when(messageReadService.countSessionMessages(SESSION)).thenReturn(total);

        CpApiException refused = assertThrows(CpApiException.class,
                () -> controller.export(SESSION, BRANCH, new MockHttpServletResponse()));

        assertEquals(413, refused.getStatus().value());
        assertEquals("EXPORT_TOO_LARGE", refused.getCode());
        assertTrue(refused.getMessage().contains(String.valueOf(total)), refused.getMessage());
        assertEquals(total, refused.getExtra().get("messages"));
        assertEquals(SessionExportService.MAX_MESSAGES, refused.getExtra().get("limit"));
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

        controller.export(SESSION, BRANCH, new MockHttpServletResponse());

        InOrder order = inOrder(sessionService, messageReadService, streamRenderer);
        order.verify(sessionService).requireCurrent(SESSION, userId, workspaceId);
        order.verify(messageReadService).countSessionMessages(SESSION);
        order.verify(streamRenderer).render(eq(SESSION), eq(workspaceId), eq(BRANCH), any());
    }

    @Test
    void refusesWithoutWorkspaceContext() {
        SessionExportController controller = new SessionExportController(sessionService,
                messageReadService, branchPathService, streamRenderer);

        CpApiException refused = assertThrows(CpApiException.class,
                () -> controller.export(SESSION, BRANCH, new MockHttpServletResponse()));

        assertEquals(409, refused.getStatus().value());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", refused.getCode());
        verify(messageReadService, never()).countSessionMessages(anyString());
        verify(streamRenderer, never()).render(anyString(), anyString(), anyString(), any());
        assertFalse(refused.getExtra().containsKey("messages"));
    }

    @Test
    void clientDisconnectPropagatesAndStopsTheWrite() throws IOException {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        String huge = "x".repeat(SessionExportService.MAX_MESSAGE_CHARS);
        when(messageReadService.countSessionMessages(SESSION)).thenReturn(1L);
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any()))
                .thenReturn(exportService.render(SESSION,
                        List.of(message("user", huge), message("assistant", huge))));
        MockHttpServletResponse response = new MockHttpServletResponse();
        StreamingResponseBody body = controller.export(SESSION, BRANCH, response);

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
        assertNull(response.getHeader("Content-Length"));
    }
}
