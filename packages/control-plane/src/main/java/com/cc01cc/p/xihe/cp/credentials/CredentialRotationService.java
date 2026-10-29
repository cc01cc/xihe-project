package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;

/**
 * PLAN-0495 M3 (contract: 0494 #8/#18 + 0495 §方案 3) two-phase key rotation,
 * extended by PLAN-0576 M3 into the credential crypto migration job.
 *
 * <p>One {@link #rotateBatch(int)} call loops an id cursor until the scan is
 * exhausted (PLAN-0576 决策 #10): each active row whose key version, AAD version
 * or fingerprint version is not current is decrypted through
 * {@link CredentialEnvelope}, re-encrypted under the current key version with
 * AAD v2, re-fingerprinted with the keyed HMAC, and written back by
 * compare-and-set (read ciphertext + still active). Soft-deleted rows are never
 * scanned. A row that cannot be decrypted (corrupted ciphertext, unknown AAD
 * version) or loses the CAS race is logged with its id and crossed by the
 * cursor; there is no failure limit, so later rows are not blocked and the next
 * run retries the failed rows. Only the internal {@code POST
 * /internal/v1/credentials/rotation/runs} entry drives this job (not
 * {@code xihe credential rotate}, whose {@code pendingTotal} counts key
 * versions only).
 *
 * <p>The {@link RotationStatus}/{@link BatchResult} wire shapes are unchanged:
 * {@code pendingTotal}/{@code remaining} still report key-version backlog only;
 * migration backlog is logged as {@code pendingMigration} evidence.
 */
@Service
public class CredentialRotationService {

    private static final Logger log = LoggerFactory.getLogger(CredentialRotationService.class);

    public static final int DEFAULT_BATCH_SIZE = 50;
    private static final int MAX_BATCH_SIZE = 500;
    static final String ROTATION_ACTOR = "system";
    /** Below every generated (version 4) UUID, so the first page starts at row 0. */
    private static final UUID CURSOR_START = new UUID(0L, 0L);

    private final CredentialRepository credentialRepository;
    private final EnvelopeEncryptionService credentialEncryption;
    private final CredentialEnvelope credentialEnvelope;
    private final CredentialFingerprint credentialFingerprint;
    private final AuditLogger auditLogger;

    public CredentialRotationService(CredentialRepository credentialRepository,
            @Qualifier("credentialEncryption") EnvelopeEncryptionService credentialEncryption,
            CredentialEnvelope credentialEnvelope,
            @Qualifier("credentialFingerprint") CredentialFingerprint credentialFingerprint,
            AuditLogger auditLogger) {
        this.credentialRepository = credentialRepository;
        this.credentialEncryption = credentialEncryption;
        this.credentialEnvelope = credentialEnvelope;
        this.credentialFingerprint = credentialFingerprint;
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

    /**
     * Migrates every pending row in this run (id cursor, no failure limit).
     * Failures/conflicts are crossed and reported, never retried in-run.
     */
    public BatchResult rotateBatch(int requestedBatchSize) {
        int batchSize = requestedBatchSize <= 0
                ? DEFAULT_BATCH_SIZE
                : Math.min(requestedBatchSize, MAX_BATCH_SIZE);
        String currentVersion = credentialEncryption.currentVersion();

        int scanned = 0;
        int migrated = 0;
        int conflicts = 0;
        int failures = 0;
        List<UUID> unmigratable = new ArrayList<>();
        UUID cursor = CURSOR_START;

        while (true) {
            List<Credential> batch = credentialRepository.findMigrationBatchAfter(
                    cursor, currentVersion, PageRequest.of(0, batchSize));
            if (batch.isEmpty()) {
                break;
            }
            for (Credential row : batch) {
                scanned++;
                cursor = row.getId();
                try {
                    String plaintext = credentialEnvelope.decrypt(row);
                    String reencrypted = credentialEnvelope.encryptV2(row.getId().toString(),
                            row.getOwnerType(), row.getOwnerId(), row.getKind(), row.getRevision(),
                            currentVersion, plaintext);
                    String fingerprint = credentialFingerprint.fingerprint(
                            CredentialSecretCodec.canonical(row.getKind(), plaintext));
                    int updated = credentialRepository.compareAndSetSecret(row.getId(),
                            row.getSecretCiphertext(), reencrypted, currentVersion,
                            Credential.AAD_VERSION_V2, fingerprint,
                            Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, Instant.now());
                    if (updated == 1) {
                        migrated++;
                    } else {
                        conflicts++;
                        unmigratable.add(row.getId());
                        log.warn("[MIGRATION] credential_unmigratable id={} reason=cas_conflict",
                                row.getId());
                    }
                } catch (IllegalArgumentException e) {
                    failures++;
                    unmigratable.add(row.getId());
                    log.warn("[MIGRATION] credential_unmigratable id={} reason={}",
                            row.getId(), e.getMessage());
                }
            }
            if (batch.size() < batchSize) {
                break;
            }
        }

        long remaining = credentialRepository.countByKeyVersionNot(currentVersion);
        long pendingMigration = credentialRepository.countPendingMigration(currentVersion);
        log.info("[MIGRATION] run_complete scanned={} migrated={} conflicts={} failures={} "
                        + "unmigratable={} pendingMigration={} pendingKeyVersion={} targetVersion={}",
                scanned, migrated, conflicts, failures, unmigratable.size(), pendingMigration,
                remaining, currentVersion);
        auditLogger.recordCredentialRotation(ROTATION_ACTOR, migrated, conflicts, failures, remaining,
                currentVersion);
        return new BatchResult(scanned, migrated, conflicts, failures, remaining, currentVersion);
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
