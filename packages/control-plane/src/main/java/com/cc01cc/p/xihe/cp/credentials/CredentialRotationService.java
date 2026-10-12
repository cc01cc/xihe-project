package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * PLAN-0495 M3 (contract: 0494 #8/#18 + 0495 §方案 3): two-phase key rotation
 * for the credential domain — the ring is extended out of band (old+new,
 * current=new); this service re-encrypts rows still sealed under an older
 * version (decrypt → encrypt under current → compare-and-set write-back,
 * batched and resumable); the retirement check reports per-version counts so
 * an old key may only be removed once its count is zero.
 *
 * <p>The write-back CAS fences against concurrent replaceSecret: only the
 * ciphertext that was actually read is rewritten (0495 决策 4).
 */
@Service
public class CredentialRotationService {

    private static final Logger log = LoggerFactory.getLogger(CredentialRotationService.class);

    public static final int DEFAULT_BATCH_SIZE = 50;
    private static final int MAX_BATCH_SIZE = 500;
    static final String ROTATION_ACTOR = "system";

    private final CredentialRepository credentialRepository;
    private final EnvelopeEncryptionService credentialEncryption;
    private final AuditLogger auditLogger;

    public CredentialRotationService(CredentialRepository credentialRepository,
            @Qualifier("credentialEncryption") EnvelopeEncryptionService credentialEncryption,
            AuditLogger auditLogger) {
        this.credentialRepository = credentialRepository;
        this.credentialEncryption = credentialEncryption;
        this.auditLogger = auditLogger;
    }

    /** Ring/current view plus per-version row counts (retirement evidence). */
    public RotationStatus status() {
        String currentVersion = credentialEncryption.currentVersion();
        Map<String, Long> countsByVersion = new TreeMap<>();
        for (CredentialRepository.KeyVersionCount row : credentialRepository.countGroupedByKeyVersion()) {
            countsByVersion.put(row.getKeyVersion(), row.getTotal());
        }
        Map<String, Long> pendingByVersion = new LinkedHashMap<>(countsByVersion);
        pendingByVersion.remove(currentVersion);
        long pendingTotal = pendingByVersion.values().stream().mapToLong(Long::longValue).sum();
        return new RotationStatus(currentVersion, List.copyOf(new TreeSet<>(credentialEncryption.keyVersions())),
                countsByVersion, pendingByVersion, pendingTotal);
    }

    /** Re-encrypts one batch of rows not yet at the current version; resumable. */
    public BatchResult rotateBatch(int requestedBatchSize) {
        int batchSize = requestedBatchSize <= 0
                ? DEFAULT_BATCH_SIZE
                : Math.min(requestedBatchSize, MAX_BATCH_SIZE);
        String currentVersion = credentialEncryption.currentVersion();
        List<Credential> batch = credentialRepository.findByKeyVersionNot(currentVersion,
                PageRequest.of(0, batchSize, Sort.by(Sort.Direction.ASC, "createdAt")));

        int migrated = 0;
        int conflicts = 0;
        int failures = 0;
        for (Credential row : batch) {
            try {
                String aad = CredentialAad.format(row.getId().toString(), row.getOwnerType(),
                        row.getOwnerId());
                String plaintext = credentialEncryption.decrypt(row.getSecretCiphertext(), aad);
                String reencrypted = credentialEncryption.encrypt(plaintext, aad);
                int updated = credentialRepository.compareAndSetSecret(row.getId(),
                        row.getSecretCiphertext(), reencrypted, currentVersion, Instant.now());
                if (updated == 1) {
                    migrated++;
                } else {
                    conflicts++;
                }
            } catch (IllegalArgumentException e) {
                failures++;
                log.warn("Credential rotation skipped credential id={} errorCode={}",
                        row.getId(), e.getMessage());
            }
        }

        long remaining = credentialRepository.countByKeyVersionNot(currentVersion);
        auditLogger.recordCredentialRotation(ROTATION_ACTOR, migrated, conflicts, failures, remaining,
                currentVersion);
        return new BatchResult(batch.size(), migrated, conflicts, failures, remaining, currentVersion);
    }

    public record RotationStatus(
            String currentVersion,
            List<String> ringVersions,
            Map<String, Long> countsByVersion,
            Map<String, Long> pendingByVersion,
            long pendingTotal) {}

    public record BatchResult(
            int scanned,
            int migrated,
            int conflicts,
            int failures,
            long remaining,
            String targetVersion) {}
}
