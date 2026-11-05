package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * BL-295: export is a <b>bounded artifact</b>, never an error face. These tests pin the four
 * required behaviours at the controller boundary:
 * <ol>
 *   <li>a large session (more visible messages than {@link SessionExportService#MAX_MESSAGES})
 *       answers 200 with {@code messagesTruncated: true} — the removed 413 must not come back;</li>
 *   <li>a session under the cap answers 200 with {@code messagesTruncated: false};</li>
 *   <li>a small branch of a large session exports only the branch-visible messages, with no
 *       truncation disclosure (the exact case the old session-wide count refused);</li>
 *   <li>the streamed bytes are exactly the renderer's Markdown bytes (the 413 removal changes no
 *       successful export payload).</li>
 * </ol>
 *
 * <p>PLAN-0670 M2c/B: the success face is a {@link StreamingResponseBody} (declared return type is
 * required by Spring MVC to dispatch it, so error faces throw {@link CpApiException}). These tests
 * drive the real body into a {@link MockHttpServletResponse}; the truncation decisions themselves are
 * covered by the real-DB renderer tests ({@code SessionExportServiceTest},
 * {@code SessionExportStreamRendererTest}) and the renderer is mocked here only to keep this class a
 * deterministic HTTP-boundary test.
 */
@ExtendWith(MockitoExtension.class)
class SessionExportControllerTest {

    private static final String SESSION = "8f1c2b3d-0000-4000-8000-000000000001";
    private static final String BRANCH = "8f1c2b3d-0000-4000-8000-000000000002";

    @Mock
    private SessionService sessionService;
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
        return new SessionExportController(sessionService, branchPathService, streamRenderer);
    }

    private static Map<String, Object> message(String role, String content) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("role", role);
        dto.put("createdAt", "2026-11-05T00:00:00Z");
        dto.put("content", content);
        return dto;
    }

    private static List<Map<String, Object>> messages(int count) {
        List<Map<String, Object>> rows = new ArrayList<>(count);
        for (int index = 0; index < count; index++) {
            rows.add(message("user", "m-" + index));
        }
        return rows;
    }

    private static String bodyText(StreamingResponseBody body) throws IOException {
        MockHttpServletResponse response = new MockHttpServletResponse();
        body.writeTo(response.getOutputStream());
        return response.getContentAsString(StandardCharsets.UTF_8);
    }

    private static long documentSections(String markdown) {
        return markdown.lines().filter(line -> line.matches("^## \\d+\\. .*")).count();
    }

    @Test
    void largeSessionExportsTheNewestLimitAndDisclosesTruncation() throws IOException {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        // 2001 visible rows -> the renderer keeps 2000 and sets the disclosure (the same branch the
        // old session-wide count refused as soon as ANY branch made the session exceed the limit).
        SessionExportService.ExportResult capped = exportService.render(SESSION,
                messages(SessionExportService.MAX_MESSAGES + 1));
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any()))
                .thenReturn(new SessionExportService.ExportResult(capped.markdown(),
                        SessionExportService.MAX_MESSAGES, true, false));
        MockHttpServletResponse response = new MockHttpServletResponse();

        StreamingResponseBody body = controller.export(SESSION, BRANCH, response);

        assertEquals(200, response.getStatus(), "BL-295: over the cap is 200, never 413");
        String markdown = bodyText(body);
        assertTrue(markdown.contains("- messages: 2000"), markdown);
        assertTrue(markdown.contains("- messagesTruncated: true"), "the cut must be disclosed");
        assertEquals(SessionExportService.MAX_MESSAGES, documentSections(markdown),
                "the document contains exactly the 2000 exported messages");
        verify(streamRenderer).render(eq(SESSION), eq(workspaceId), eq(BRANCH), any());
    }

    @Test
    void underTheLimitHasNoTruncationDisclosure() throws IOException {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        SessionExportService.ExportResult result = exportService.render(SESSION, messages(3));
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any())).thenReturn(result);
        MockHttpServletResponse response = new MockHttpServletResponse();

        String markdown = bodyText(controller.export(SESSION, BRANCH, response));

        assertEquals(200, response.getStatus());
        assertTrue(markdown.contains("- messages: 3"), markdown);
        assertTrue(markdown.contains("- messagesTruncated: false"), "under the cap nothing was cut");
        assertFalse(markdown.contains("- messagesTruncated: true"), markdown);
    }

    @Test
    void smallBranchOfLargeSessionExportsOnlyTheVisibleMessages() throws IOException {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        // The 20k session rows are invisible on this branch; the renderer returns the 50 visible rows.
        SessionExportService.ExportResult branchVisible = exportService.render(SESSION, messages(50));
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any()))
                .thenReturn(branchVisible);
        MockHttpServletResponse response = new MockHttpServletResponse();

        String markdown = bodyText(controller.export(SESSION, BRANCH, response));

        assertEquals(200, response.getStatus(), "BL-295: the old count precheck refused this case");
        assertTrue(markdown.contains("- messages: 50"), markdown);
        assertEquals(50, documentSections(markdown));
        assertTrue(markdown.contains("- messagesTruncated: false"),
                "a branch with 50 visible messages is not a truncated export");
    }

    @Test
    void successfulBytesAreExactlyTheRendererMarkdown() throws IOException {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        SessionExportService.ExportResult result = exportService.render(SESSION,
                List.of(message("user", "hello"), message("assistant", "world")));
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any())).thenReturn(result);
        MockHttpServletResponse response = new MockHttpServletResponse();

        StreamingResponseBody body = controller.export(SESSION, BRANCH, response);
        body.writeTo(response.getOutputStream());

        assertArrayEquals(result.markdown().getBytes(StandardCharsets.UTF_8),
                response.getContentAsByteArray(),
                "removing the 413 path must not alter a successful export byte");
    }

    @Test
    void refusesWithoutWorkspaceContext() {
        SessionExportController controller = new SessionExportController(sessionService,
                branchPathService, streamRenderer);

        CpApiException refused = assertThrows(CpApiException.class,
                () -> controller.export(SESSION, BRANCH, new MockHttpServletResponse()));

        assertEquals(409, refused.getStatus().value());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", refused.getCode());
        verify(streamRenderer, never()).render(anyString(), anyString(), anyString(), any());
    }

    @Test
    void clientDisconnectPropagatesAndStopsTheWrite() throws IOException {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        SessionExportController controller = controllerWith(userId, workspaceId);
        String huge = "x".repeat(SessionExportService.MAX_MESSAGE_CHARS);
        SessionExportService.ExportResult result = exportService.render(SESSION,
                List.of(message("user", huge), message("assistant", huge)));
        when(streamRenderer.render(eq(SESSION), eq(workspaceId), eq(BRANCH), any())).thenReturn(result);
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
