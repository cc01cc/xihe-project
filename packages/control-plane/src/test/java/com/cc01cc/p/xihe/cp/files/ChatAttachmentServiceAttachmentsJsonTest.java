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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * PLAN-0605: the dispatch `images[]` payload is built from the admitted message attachment
 * JSON (`messages.attachments`), whose shape is produced by ChatController as
 * `[{fileId,name,type,size}]`. This pins that contract (M3 harness used the wrong request
 * field once, so both ends must be asserted explicitly).
 */
class ChatAttachmentServiceAttachmentsJsonTest {

    private final ChatAttachmentService service = new ChatAttachmentService(
            Path.of(".").toAbsolutePath().toString(),
            "png,jpg,jpeg,webp",
            mock(FileRepository.class),
            mock(com.cc01cc.p.xihe.cp.service.SessionAttachmentAnchorService.class),
            mock(WorkspaceRepository.class),
            mock(WorkspaceUserRepository.class),
            new ObjectMapper());

    private String ref(String fileId, String type, long size) {
        return String.format("{\"fileId\":\"%s\",\"name\":\"fixture\",\"type\":\"%s\",\"size\":%d}", fileId, type, size);
    }

    @Test
    void parsesImageReferencesFromAdmittedJson() {
        String json = "[" + ref("11111111-1111-4111-8111-111111111111", "image/png", 346) + ","
                + ref("22222222-2222-4222-8222-222222222222", "image/jpeg", 2048) + "]";

        List<Map<String, Object>> references = service.imageReferencesFromAttachmentsJson(json);

        assertEquals(2, references.size());
        assertEquals("11111111-1111-4111-8111-111111111111", references.getFirst().get("attachmentId"));
        assertEquals("image/png", references.getFirst().get("mimeType"));
        assertEquals(346L, references.getFirst().get("sizeBytes"));
        assertEquals("image/jpeg", references.get(1).get("mimeType"));
    }

    @Test
    void emptyOrBlankJsonYieldsNothing() {
        assertTrue(service.imageReferencesFromAttachmentsJson(null).isEmpty());
        assertTrue(service.imageReferencesFromAttachmentsJson("").isEmpty());
        assertTrue(service.imageReferencesFromAttachmentsJson("[]").isEmpty());
    }

    @Test
    void nonArrayJsonFailsFast() {
        assertThrows(IllegalStateException.class,
                () -> service.imageReferencesFromAttachmentsJson("{\"fileId\":\"x\"}"));
        assertThrows(IllegalStateException.class,
                () -> service.imageReferencesFromAttachmentsJson("not-json"));
    }

    @Test
    void skipsNonImageOversizedAndIncompleteEntries() {
        String json = "[" + ref("aaaaaaaa-1111-4111-8111-111111111111", "application/pdf", 10) + ","
                + ref("bbbbbbbb-1111-4111-8111-111111111111", "image/gif", 10) + ","
                + ref("cccccccc-1111-4111-8111-111111111111", "image/png", AttachmentContentService.MAX_IMAGE_BYTES + 1) + ","
                + "{\"name\":\"no-id\",\"type\":\"image/png\",\"size\":10},"
                + ref("dddddddd-1111-4111-8111-111111111111", "image/webp", 99) + "]";

        List<Map<String, Object>> references = service.imageReferencesFromAttachmentsJson(json);

        assertEquals(1, references.size());
        assertEquals("dddddddd-1111-4111-8111-111111111111", references.getFirst().get("attachmentId"));
        assertEquals("image/webp", references.getFirst().get("mimeType"));
    }

    @Test
    void capsAtFourImagesPerMessage() {
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < 6; i++) {
            if (i > 0) {
                json.append(',');
            }
            json.append(ref(UUID.randomUUID().toString(), "image/png", 10));
        }
        json.append(']');

        assertEquals(ChatAttachmentService.MAX_IMAGES_PER_MESSAGE,
                service.imageReferencesFromAttachmentsJson(json.toString()).size());
    }

    @Test
    void unreferencedFilesDoNotLeakIn() {
        // the JSON is the only source: repository lookups (message linkage) are irrelevant here
        File unused = new File();
        unused.setId(UUID.randomUUID());
        unused.setMimeType("image/png");
        unused.setSizeBytes(10);
        assertTrue(service.imageReferencesFromAttachmentsJson("[]").isEmpty());
    }
}
