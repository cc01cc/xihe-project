package com.cc01cc.p.xihe.cp.files;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

@Service
public class OrphanAttachmentCleanupService {

    private static final Logger logger = LoggerFactory.getLogger(OrphanAttachmentCleanupService.class);

    private final ChatAttachmentService chatAttachmentService;
    private final long orphanRetentionHours;

    public OrphanAttachmentCleanupService(
            ChatAttachmentService chatAttachmentService,
            @Value("${cp.attachments.orphan-retention-hours:24}") long orphanRetentionHours) {
        this.chatAttachmentService = chatAttachmentService;
        this.orphanRetentionHours = orphanRetentionHours;
    }

    @Scheduled(fixedRateString = "${cp.attachments.orphan-cleanup-interval-ms:3600000}")
    @Transactional
    public void cleanupOrphanAttachments() {
        Instant cutoff = Instant.now().minus(orphanRetentionHours, ChronoUnit.HOURS);
        logger.info("Starting orphan attachment cleanup before cutoff={}", cutoff);
        int cleaned = chatAttachmentService.cleanupOrphans(cutoff);
        logger.info("Orphan attachment cleanup complete: removed {} files", cleaned);
    }
}
