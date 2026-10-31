package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.ProviderCredentialLease;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0605: run-bound byte channel for image attachments.
 *
 * <p>The Agent never receives image bytes through the dispatch payload; it pulls them
 * back over the internal route, and every pull must prove three-way ownership
 * {@code (runId, workspaceId, attachmentId)} plus an already redeemed lease. Bytes are
 * streamed from the stored path, never logged, and capped per image.
 */
@Service
public class AttachmentContentService {

    private static final Logger logger = LoggerFactory.getLogger(AttachmentContentService.class);

    /** Per-image ceiling for the vision channel (PLAN-0605 D6). */
    public static final long MAX_IMAGE_BYTES = 10L * 1024 * 1024;

    private static final Set<String> SUPPORTED_IMAGE_MIMES =
            Set.of("image/png", "image/jpeg", "image/webp");

    private final ChatRunRepository chatRuns;
    private final ProviderCredentialLeaseRepository leases;
    private final FileRepository files;

    public AttachmentContentService(
            ChatRunRepository chatRuns,
            ProviderCredentialLeaseRepository leases,
            FileRepository files) {
        this.chatRuns = chatRuns;
        this.leases = leases;
        this.files = files;
    }

    public record ResolvedContent(Path path, String mimeType, long sizeBytes) {
    }

    /**
     * Resolves the stored bytes for {@code attachmentId} only when the caller proves it
     * is acting for an active, lease-redeemed run in the same workspace.
     *
     * @param tenantWorkspaceId workspace from the service caller (may be null in tests);
     *                          when present it must match the run's workspace
     */
    public ResolvedContent resolve(String attachmentId, String runId, String tenantWorkspaceId) {
        if (runId == null || runId.isBlank() || attachmentId == null || attachmentId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "runId and attachmentId are required");
        }

        ChatRun run = chatRuns.findById(parseUuid(runId, "CHAT_RUN_NOT_FOUND"))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "CHAT_RUN_NOT_FOUND",
                        "Chat run not found"));
        if (tenantWorkspaceId != null && !tenantWorkspaceId.isBlank()
                && !tenantWorkspaceId.equals(run.getWorkspaceId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "ATTACHMENT_FORBIDDEN",
                    "Attachment is outside this workspace");
        }

        Optional<ProviderCredentialLease> lease = leases
                .findFirstByRunIdAndRedeemedAtIsNotNullAndRevokedAtIsNullOrderByCreatedAtDesc(runId);
        ProviderCredentialLease active = lease.orElseThrow(() -> new CpApiException(
                HttpStatus.FORBIDDEN, "ATTACHMENT_LEASE_REQUIRED",
                "Run has no redeemed provider credential lease"));
        if (active.getExpiresAt() != null && !active.getExpiresAt().isAfter(Instant.now())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "ATTACHMENT_LEASE_EXPIRED",
                    "Run credential lease has expired");
        }

        File attachment = files.findById(parseUuid(attachmentId, "ATTACHMENT_NOT_FOUND"))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "ATTACHMENT_NOT_FOUND",
                        "Attachment not found"));
        if (!run.getWorkspaceId().equals(attachment.getWorkspaceId())
                || !run.getSessionId().equals(attachment.getSessionId())) {
            // covers "attachment does not belong to this run" and foreign sessions alike
            throw new CpApiException(HttpStatus.FORBIDDEN, "ATTACHMENT_FORBIDDEN",
                    "Attachment does not belong to this run");
        }

        String mime = attachment.getMimeType() == null
                ? "" : attachment.getMimeType().toLowerCase(Locale.ROOT);
        if (!SUPPORTED_IMAGE_MIMES.contains(mime)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "LLM_VISION_ATTACHMENT_UNSUPPORTED",
                    "Attachment type is not supported for image input");
        }
        if (attachment.getSizeBytes() > MAX_IMAGE_BYTES) {
            throw new CpApiException(HttpStatus.PAYLOAD_TOO_LARGE, "LLM_VISION_ATTACHMENT_TOO_LARGE",
                    "Attachment exceeds the per-image limit");
        }

        Path path = Paths.get(attachment.getStoragePath());
        if (!Files.isReadable(path)) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "ATTACHMENT_NOT_FOUND",
                    "Attachment content is unavailable");
        }
        // structured log: ids/metadata only, never bytes or storage paths
        logger.info("[LIFECYCLE] service=cp event=attachment_content_served runId={} attachmentId={} mime={} size={}",
                runId, attachmentId, mime, attachment.getSizeBytes());
        return new ResolvedContent(path, mime, attachment.getSizeBytes());
    }

    private UUID parseUuid(String value, String errorCode) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.NOT_FOUND, errorCode, "Resource not found");
        }
    }
}
