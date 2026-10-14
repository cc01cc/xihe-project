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

    /** PLAN-0495 M3: per-version distribution for the rotation status report. */
    @Query("select c.keyVersion as keyVersion, count(c) as total from Credential c group by c.keyVersion")
    List<KeyVersionCount> countGroupedByKeyVersion();

    /**
     * PLAN-0495 M3 compare-and-set write-back: only rewrites the row when the
     * ciphertext the rotation read is still the stored one (a concurrent
     * replaceSecret must never be overwritten). Returns 0 on conflict.
     */
    @Modifying
    @Transactional
    @Query("update Credential c set c.secretCiphertext = :newCiphertext, c.keyVersion = :newVersion, "
            + "c.rotatedAt = :now, c.updatedAt = :now "
            + "where c.id = :id and c.secretCiphertext = :expectedCiphertext")
    int compareAndSetSecret(@Param("id") UUID id, @Param("expectedCiphertext") String expectedCiphertext,
            @Param("newCiphertext") String newCiphertext, @Param("newVersion") String newVersion,
            @Param("now") Instant now);

    /**
     * PLAN-0495 review round-4 fix: conditional replace — writes only the
     * replace-owned columns (never rotatedAt/deletedAt/business snapshot) and
     * only when the revision the caller read is still current. A concurrent
     * replace, delete or rotation can therefore never be clobbered by a stale
     * full-row snapshot write. Returns 0 on fence mismatch.
     */
    @Modifying
    @Transactional
    @Query("update Credential c set c.secretCiphertext = :ciphertext, c.fingerprint = :fingerprint, "
            + "c.keyVersion = :keyVersion, c.revision = c.revision + 1, c.replacedAt = :now, "
            + "c.updatedAt = :now "
            + "where c.id = :id and c.revision = :expectedRevision and c.deletedAt is null")
    int replaceSecretIfRevisionMatches(@Param("id") UUID id, @Param("expectedRevision") int expectedRevision,
            @Param("ciphertext") String ciphertext, @Param("fingerprint") String fingerprint,
            @Param("keyVersion") String keyVersion, @Param("now") Instant now);

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
