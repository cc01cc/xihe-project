package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** PLAN-0605: the dispatch payload carries image references only (ids + metadata). */
class ChatAttachmentServiceImageReferencesTest {

    private final FileRepository files = mock(FileRepository.class);
    private final ChatAttachmentService service = new ChatAttachmentService(
            Path.of(".").toAbsolutePath().toString(),
            "png,jpg,jpeg,webp",
            files,
            mock(com.cc01cc.p.xihe.cp.service.SessionAttachmentAnchorService.class),
            mock(WorkspaceRepository.class),
            mock(WorkspaceUserRepository.class),
            new ObjectMapper());

    private File attachment(String mime, long size) {
        File file = new File();
        file.setId(UUID.randomUUID());
        file.setMimeType(mime);
        file.setSizeBytes(size);
        file.setStoragePath("/tmp/" + file.getId());
        return file;
    }

    @Test
    void returnsReferencesWithoutBytes() {
        File png = attachment("image/png", 1024);
        when(files.findByMessageId("message-1")).thenReturn(List.of(png));

        List<Map<String, Object>> references = service.imageReferencesForMessage("message-1");

        assertEquals(1, references.size());
        assertEquals(png.getId().toString(), references.getFirst().get("attachmentId"));
        assertEquals("image/png", references.getFirst().get("mimeType"));
        assertEquals(1024L, references.getFirst().get("sizeBytes"));
        assertTrue(references.getFirst().keySet().stream().noneMatch(k -> k.contains("content") || k.contains("data")));
    }

    @Test
    void skipsNonImageAndOversizedAndUnsupportedFormats() {
        when(files.findByMessageId("message-2")).thenReturn(List.of(
                attachment("application/pdf", 10),
                attachment("image/gif", 10),
                attachment("image/png", AttachmentContentService.MAX_IMAGE_BYTES + 1),
                attachment("image/jpeg", 10)));

        List<Map<String, Object>> references = service.imageReferencesForMessage("message-2");

        assertEquals(1, references.size());
        assertEquals("image/jpeg", references.getFirst().get("mimeType"));
    }

    @Test
    void capsAtFourImagesPerMessage() {
        when(files.findByMessageId("message-3")).thenReturn(List.of(
                attachment("image/png", 1), attachment("image/png", 1), attachment("image/png", 1),
                attachment("image/png", 1), attachment("image/png", 1)));

        assertEquals(ChatAttachmentService.MAX_IMAGES_PER_MESSAGE,
                service.imageReferencesForMessage("message-3").size());
    }

    @Test
    void blankMessageIdYieldsNothing() {
        assertTrue(service.imageReferencesForMessage(null).isEmpty());
        assertTrue(service.imageReferencesForMessage("  ").isEmpty());
    }
}

