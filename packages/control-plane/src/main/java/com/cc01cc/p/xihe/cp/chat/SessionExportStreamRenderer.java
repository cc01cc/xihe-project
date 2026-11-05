package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.service.BranchPathService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Iterator;
import java.util.Map;
import java.util.stream.Stream;

/**
 * PLAN-0670 M2c/B: prepares the export document inside a short read-only transaction.
 *
 * <p>Why a separate bean: a {@code @Transactional} method on the controller would keep the JPA
 * transaction open while the servlet container writes the response body (the transaction interceptor
 * unwinds when the controller method returns, but the body is written later by
 * {@code StreamingResponseBody} — mixing the two is the classic streaming deadlock/lazy-load trap).
 * Here the whole read happens and completes before the controller returns; the HTTP layer then
 * streams an in-memory, document-capped Markdown string.
 *
 * <p>The read itself is cursor-backed ({@link MessageReadService#streamSessionMessages}, Hibernate
 * fetch size 200) and the renderer caps both the per-message content and the document
 * ({@link SessionExportService#MAX_DOCUMENT_CHARS}), so heap stays bounded even for the largest
 * session the {@code MAX_MESSAGES} precheck admits.
 */
@Service
public class SessionExportStreamRenderer {

    private final MessageReadService messageReadService;
    private final SessionExportService exportService;

    public SessionExportStreamRenderer(MessageReadService messageReadService,
                                       SessionExportService exportService) {
        this.messageReadService = messageReadService;
        this.exportService = exportService;
    }

    @Transactional(readOnly = true)
    public SessionExportService.ExportResult render(String sessionId, String workspaceId,
                                                     String rootBranchId,
                                                     BranchPathService.BranchVisibility visibility) {
        try (Stream<com.cc01cc.p.xihe.cp.entity.Message> messages =
                     messageReadService.streamSessionMessages(sessionId)) {
            Iterator<Map<String, Object>> visible = messageReadService.visibleMessageIterator(
                    messages.iterator(), sessionId, workspaceId, rootBranchId, visibility, "export");
            return exportService.render(sessionId, visible);
        }
    }
}
