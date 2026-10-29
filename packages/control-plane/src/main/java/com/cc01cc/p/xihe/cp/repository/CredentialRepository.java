package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.Credential;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface CredentialRepository extends JpaRepository<Credential, UUID> {

    Optional<Credential> findByIdAndDeletedAtIsNull(UUID id);

    List<Credential> findByOwnerTypeAndOwnerIdAndDeletedAtIsNullOrderByCreatedAtDesc(
            String ownerType, String ownerId);

    /** PLAN-0495 M3 rotation scan: rows not yet at the current key version. */
    List<Credential> findByKeyVersionNot(String keyVersion, Pageable pageable);

    /** PLAN-0495 M3 retirement check: number of rows still sealed under {@code keyVersion}. */
    long countByKeyVersionNot(String keyVersion);

    /**
     * PLAN-0576 T3.1: id-cursor scan for the migration job — active rows whose
     * key version, AAD version or fingerprint version is not the current target.
     * Ordered by id so the caller can resume after the last id and cross failed
     * rows instead of retrying them at the head of the queue.
     */
    @Query("select c from Credential c where c.id > :lastId and c.deletedAt is null "
            + "and (c.keyVersion <> :currentVersion or c.aadVersion <> 2 "
            + "or c.fingerprintVersion <> 'hmac-sha256-v1') order by c.id asc")
    List<Credential> findMigrationBatchAfter(@Param("lastId") UUID lastId,
            @Param("currentVersion") String currentVersion, Pageable pageable);

    /**
     * PLAN-0576 T3.1/T3.3: remaining migration backlog (active rows not at the
     * current key/AAD/fingerprint versions). Internal evidence only — the
     * rotation status wire keeps its key-version-only {@code pendingTotal}.
     */
    @Query("select count(c) from Credential c where c.deletedAt is null "
            + "and (c.keyVersion <> :currentVersion or c.aadVersion <> 2 "
            + "or c.fingerprintVersion <> 'hmac-sha256-v1')")
    long countPendingMigration(@Param("currentVersion") String currentVersion);

    /** PLAN-0495 M3: per-version distribution for the rotation status report. */
    @Query("select c.keyVersion as keyVersion, count(c) as total from Credential c group by c.keyVersion")
    List<KeyVersionCount> countGroupedByKeyVersion();

    /**
     * PLAN-0495 M3 compare-and-set write-back, extended by PLAN-0576 T3.1: only
     * rewrites the row when the ciphertext the rotation read is still the stored
     * one and the row is still active (a concurrent replaceSecret/delete must
     * never be overwritten or revived). Writes the migration target versions
     * and the recomputed fingerprint in the same statement. Returns 0 on
     * conflict.
     */
    @Modifying
    @Transactional
    @Query("update Credential c set c.secretCiphertext = :newCiphertext, c.keyVersion = :newVersion, "
            + "c.aadVersion = :aadVersion, c.fingerprint = :fingerprint, "
            + "c.fingerprintVersion = :fingerprintVersion, c.rotatedAt = :now, c.updatedAt = :now "
            + "where c.id = :id and c.secretCiphertext = :expectedCiphertext "
            + "and c.deletedAt is null")
    int compareAndSetSecret(@Param("id") UUID id, @Param("expectedCiphertext") String expectedCiphertext,
            @Param("newCiphertext") String newCiphertext, @Param("newVersion") String newVersion,
            @Param("aadVersion") short aadVersion, @Param("fingerprint") String fingerprint,
            @Param("fingerprintVersion") String fingerprintVersion, @Param("now") Instant now);

    /**
     * PLAN-0495 review round-4 fix: conditional replace — writes only the
     * replace-owned columns (never rotatedAt/deletedAt/business snapshot) and
     * only when the revision the caller read is still current. A concurrent
     * replace, delete or rotation can therefore never be clobbered by a stale
     * full-row snapshot write. PLAN-0576: the AAD/fingerprint versions are
     * written in the same statement so a v2 caller never relies on column
     * defaults. Returns 0 on fence mismatch.
     */
    @Modifying
    @Transactional
    @Query("update Credential c set c.secretCiphertext = :ciphertext, c.fingerprint = :fingerprint, "
            + "c.keyVersion = :keyVersion, c.aadVersion = :aadVersion, "
            + "c.fingerprintVersion = :fingerprintVersion, c.revision = c.revision + 1, "
            + "c.replacedAt = :now, c.updatedAt = :now "
            + "where c.id = :id and c.revision = :expectedRevision and c.deletedAt is null")
    int replaceSecretIfRevisionMatches(@Param("id") UUID id, @Param("expectedRevision") int expectedRevision,
            @Param("ciphertext") String ciphertext, @Param("fingerprint") String fingerprint,
            @Param("keyVersion") String keyVersion, @Param("aadVersion") short aadVersion,
            @Param("fingerprintVersion") String fingerprintVersion, @Param("now") Instant now);

    /**
     * PLAN-0495 review round-4 fix: conditional soft delete — only marks the
     * row when it is still active (guards against reviving a delete and
     * against overwriting concurrent rotation/replace writes). Returns 0 when
     * the row is already soft-deleted.
     */
    @Modifying
    @Transactional
    @Query("update Credential c set c.deletedAt = :now, c.updatedAt = :now "
            + "where c.id = :id and c.deletedAt is null")
    int softDeleteIfActive(@Param("id") UUID id, @Param("now") Instant now);

    interface KeyVersionCount {
        String getKeyVersion();

        long getTotal();
    }
}
