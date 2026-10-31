package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.ProviderCredentialLease;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0605: five negative classes + positive for the run-bound attachment byte channel.
 */
class AttachmentContentServiceTest {

    private static final String RUN_ID = "11111111-1111-4111-8111-111111111111";
    private static final String ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
    private static final String WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
    private static final String SESSION_ID = "44444444-4444-4444-8444-444444444444";

    private final ChatRunRepository chatRuns = mock(ChatRunRepository.class);
    private final ProviderCredentialLeaseRepository leases = mock(ProviderCredentialLeaseRepository.class);
    private final FileRepository files = mock(FileRepository.class);
    private final AttachmentContentService service = new AttachmentContentService(chatRuns, leases, files);

    private ChatRun run() {
        ChatRun run = new ChatRun();
        run.setId(UUID.fromString(RUN_ID));
        run.setSessionId(SESSION_ID);
        run.setWorkspaceId(WORKSPACE_ID);
        return run;
    }

    private ProviderCredentialLease lease(Instant expiresAt) {
        ProviderCredentialLease lease = new ProviderCredentialLease();
        lease.setRunId(RUN_ID);
        lease.setRedeemedAt(Instant.now().minusSeconds(5));
        lease.setExpiresAt(expiresAt);
        return lease;
    }

    private File attachment(String mime, long size, String workspaceId, String sessionId, Path path) {
        File file = new File();
        file.setId(UUID.fromString(ATTACHMENT_ID));
        file.setMimeType(mime);
        file.setSizeBytes(size);
        file.setWorkspaceId(workspaceId);
        file.setSessionId(sessionId);
        file.setStoragePath(path.toString());
        return file;
    }

    private Path writeTempPng(Path dir) throws Exception {
        Path png = dir.resolve("fixture.png");
        Files.write(png, new byte[] {(byte) 0x89, 'P', 'N', 'G'});
        return png;
    }

    @Test
    void positiveServesBytesForLeaseRedeemedRun(@TempDir Path dir) throws Exception {
        Path png = writeTempPng(dir);
        when(chatRuns.findById(any())).thenReturn(Optional.of(run()));
        when(leases.findFirstByRunIdAndRedeemedAtIsNotNullAndRevokedAtIsNullOrderByCreatedAtDesc(RUN_ID))
                .thenReturn(Optional.of(lease(Instant.now().plusSeconds(600))));
        when(files.findById(any())).thenReturn(Optional.of(
                attachment("image/png", 4, WORKSPACE_ID, SESSION_ID, png)));

        AttachmentContentService.ResolvedContent resolved =
                service.resolve(ATTACHMENT_ID, RUN_ID, WORKSPACE_ID);
        assertEquals("image/png", resolved.mimeType());
        assertEquals(4, resolved.sizeBytes());
        assertTrue(Files.isReadable(resolved.path()));
    }

    @Test
    void rejectsWhenRunHasNoRedeemedLease() {
        when(chatRuns.findById(any())).thenReturn(Optional.of(run()));
        when(leases.findFirstByRunIdAndRedeemedAtIsNotNullAndRevokedAtIsNullOrderByCreatedAtDesc(RUN_ID))
                .thenReturn(Optional.empty());

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.resolve(ATTACHMENT_ID, RUN_ID, WORKSPACE_ID));
        assertEquals("ATTACHMENT_LEASE_REQUIRED", error.getCode());
    }

    @Test
    void rejectsWhenLeaseExpired() {
        when(chatRuns.findById(any())).thenReturn(Optional.of(run()));
        when(leases.findFirstByRunIdAndRedeemedAtIsNotNullAndRevokedAtIsNullOrderByCreatedAtDesc(RUN_ID))
                .thenReturn(Optional.of(lease(Instant.now().minusSeconds(1))));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.resolve(ATTACHMENT_ID, RUN_ID, WORKSPACE_ID));
        assertEquals("ATTACHMENT_LEASE_EXPIRED", error.getCode());
    }

    @Test
    void rejectsUnknownRun() {
        when(chatRuns.findById(any())).thenReturn(Optional.empty());

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.resolve(ATTACHMENT_ID, RUN_ID, WORKSPACE_ID));
        assertEquals("CHAT_RUN_NOT_FOUND", error.getCode());
    }

    @Test
    void rejectsCrossWorkspaceCaller() {
        when(chatRuns.findById(any())).thenReturn(Optional.of(run()));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.resolve(ATTACHMENT_ID, RUN_ID, "99999999-9999-4999-8999-999999999999"));
        assertEquals("ATTACHMENT_FORBIDDEN", error.getCode());
    }

    @Test
    void rejectsAttachmentFromAnotherSession(@TempDir Path dir) throws Exception {
        Path png = writeTempPng(dir);
        when(chatRuns.findById(any())).thenReturn(Optional.of(run()));
        when(leases.findFirstByRunIdAndRedeemedAtIsNotNullAndRevokedAtIsNullOrderByCreatedAtDesc(RUN_ID))
                .thenReturn(Optional.of(lease(Instant.now().plusSeconds(600))));
        when(files.findById(any())).thenReturn(Optional.of(
                attachment("image/png", 4, WORKSPACE_ID, "55555555-5555-4555-8555-555555555555", png)));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.resolve(ATTACHMENT_ID, RUN_ID, WORKSPACE_ID));
        assertEquals("ATTACHMENT_FORBIDDEN", error.getCode());
    }

    @Test
    void rejectsUnsupportedImageType(@TempDir Path dir) throws Exception {
        Path file = writeTempPng(dir);
        when(chatRuns.findById(any())).thenReturn(Optional.of(run()));
        when(leases.findFirstByRunIdAndRedeemedAtIsNotNullAndRevokedAtIsNullOrderByCreatedAtDesc(RUN_ID))
                .thenReturn(Optional.of(lease(Instant.now().plusSeconds(600))));
        when(files.findById(any())).thenReturn(Optional.of(
                attachment("image/gif", 4, WORKSPACE_ID, SESSION_ID, file)));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.resolve(ATTACHMENT_ID, RUN_ID, WORKSPACE_ID));
        assertEquals("LLM_VISION_ATTACHMENT_UNSUPPORTED", error.getCode());
    }

    @Test
    void rejectsOversizedImage(@TempDir Path dir) throws Exception {
        Path png = writeTempPng(dir);
        when(chatRuns.findById(any())).thenReturn(Optional.of(run()));
        when(leases.findFirstByRunIdAndRedeemedAtIsNotNullAndRevokedAtIsNullOrderByCreatedAtDesc(RUN_ID))
                .thenReturn(Optional.of(lease(Instant.now().plusSeconds(600))));
        when(files.findById(any())).thenReturn(Optional.of(
                attachment("image/png", AttachmentContentService.MAX_IMAGE_BYTES + 1,
                        WORKSPACE_ID, SESSION_ID, png)));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.resolve(ATTACHMENT_ID, RUN_ID, WORKSPACE_ID));
        assertEquals("LLM_VISION_ATTACHMENT_TOO_LARGE", error.getCode());
    }
}
