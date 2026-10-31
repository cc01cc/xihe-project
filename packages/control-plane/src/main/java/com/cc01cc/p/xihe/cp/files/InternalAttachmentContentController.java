package com.cc01cc.p.xihe.cp.files;

import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0605: internal byte channel used by the Agent to render image content parts.
 *
 * <p>Service-authenticated (`/internal/v1/**`), run-bound, and never cached: the
 * response carries the stored bytes only, no metadata beyond content type/length.
 */
@RestController
@RequestMapping("/internal/v1/attachments")
public class InternalAttachmentContentController {

    private final AttachmentContentService service;

    public InternalAttachmentContentController(AttachmentContentService service) {
        this.service = service;
    }

    @GetMapping("/{attachmentId}/content")
    public ResponseEntity<Resource> content(
            @PathVariable String attachmentId,
            @RequestParam(name = "runId") String runId,
            @RequestHeader(name = "X-Workspace-Id", required = false) String workspaceId) {
        AttachmentContentService.ResolvedContent resolved = service.resolve(attachmentId, runId, workspaceId);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(resolved.mimeType()))
                .contentLength(resolved.sizeBytes())
                .cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .body(new FileSystemResource(resolved.path()));
    }

}

