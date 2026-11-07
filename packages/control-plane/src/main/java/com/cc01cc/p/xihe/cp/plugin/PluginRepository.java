package com.cc01cc.p.xihe.cp.plugin;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import jakarta.persistence.LockModeType;

import java.util.List;
import java.util.Optional;

/**
 * PLAN-0691 T1.1 (V135): the {@code plugins} version rows.
 *
 * <p>Every finder is hand-written because the primary key is composite {@code (id, digest)}
 * (D-65) — a Spring Data {@code findById} would need the {@code @IdClass} key, and callers ask
 * "the current row for this plugin" instead.</p>
 */
@Repository
public interface PluginRepository extends JpaRepository<Plugin, Plugin.PluginKey> {

    @Query("select p from Plugin p where p.id = :id and p.digest = :digest")
    Optional<Plugin> findVersion(@Param("id") String id, @Param("digest") String digest);

    @Query("select count(p) from Plugin p where p.id = :id")
    long countVersions(@Param("id") String id);

    @Query("select p from Plugin p where p.current = true order by p.id")
    List<Plugin> findCurrent();

    @Query("select p from Plugin p where p.id = :id and p.current = true")
    Optional<Plugin> findCurrentById(@Param("id") String id);

    /** D-65: the current row is flipped under the service's per-plugin advisory lock; FOR UPDATE
     * keeps a concurrent reader from observing the half-applied upgrade. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from Plugin p where p.id = :id and p.current = true")
    Optional<Plugin> findCurrentForUpdate(@Param("id") String id);

    @Query("select p from Plugin p where p.id = :id order by p.createdAt desc")
    List<Plugin> findAllVersions(@Param("id") String id);

    @Modifying
    @Query("delete from Plugin p where p.id = :id")
    int deleteAllVersions(@Param("id") String id);
}
