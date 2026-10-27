package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.ConfigLockEntity;
import com.cc01cc.p.xihe.cp.repository.ConfigLockRepository;
import jakarta.persistence.EntityManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0556: persistence for administrator config locks.
 *
 * <p>Read side ({@link #lockReasons}) is consumed by {@link ConfigService} for
 * the effective chain and by the meta endpoint; write side is driven by
 * {@link ConfigLockAdminService}, which owns the value+lock transaction. This
 * service never depends on {@link ConfigService}, so no bean cycle exists.</p>
 */
@Service
public class ConfigLockService {

    /** Read model for one lock row; {@code revision} is the optimistic token. */
    public record LockView(UUID id, String domain, String key, String mode, String reason,
                           String updatedBy, Instant updatedAt, long revision) {}

    private final ConfigLockRepository repo;
    private final EntityManager em;

    public ConfigLockService(ConfigLockRepository repo, EntityManager em) {
        this.repo = repo;
        this.em = em;
    }

    public List<LockView> list(String domain) {
        List<ConfigLockEntity> rows = domain == null || domain.isBlank()
                ? repo.findAllByOrderByDomainAscConfigKeyAsc()
                : repo.findByDomainOrderByConfigKeyAsc(domain);
        return rows.stream().map(ConfigLockService::toView).toList();
    }

    public Optional<LockView> find(String domain, String key) {
        return repo.findByDomainAndConfigKey(domain, key).map(ConfigLockService::toView);
    }

    /** domain key -> lock reason (empty when nothing is locked in the domain). */
    public Map<String, String> lockReasons(String domain) {
        Map<String, String> result = new LinkedHashMap<>();
        for (ConfigLockEntity row : repo.findByDomainOrderByConfigKeyAsc(domain)) {
            result.put(row.getConfigKey(), row.getReason());
        }
        return result;
    }

    public long revision(String domain, String key) {
        return repo.findByDomainAndConfigKey(domain, key)
                .map(row -> row.getUpdatedAt().toEpochMilli())
                .orElse(0L);
    }

    /** Creates or updates the lock row and returns the persisted view. */
    @Transactional
    public LockView upsert(String domain, String key, String mode, String reason, String actor) {
        lockDomainKey(domain, key);
        ConfigLockEntity entity = repo.findByDomainAndConfigKey(domain, key)
                .orElseGet(ConfigLockEntity::new);
        entity.setDomain(domain);
        entity.setConfigKey(key);
        entity.setMode(mode);
        entity.setReason(reason);
        entity.setUpdatedBy(actor);
        try {
            return toView(repo.saveAndFlush(entity));
        } catch (org.springframework.dao.DataIntegrityViolationException race) {
            // Two admins locked the same key at once: the unique constraint is
            // the last line of defence, surfaced as the same 409 as a stale
            // revision instead of a 500.
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "CONFIG_LOCK_CONFLICT",
                    "Config lock changed since it was read; reload and retry");
        }
    }

    /** Deletes the lock row; returns the removed row for audit, empty when absent. */
    @Transactional
    public Optional<LockView> delete(String domain, String key) {
        lockDomainKey(domain, key);
        Optional<ConfigLockEntity> existing = repo.findByDomainAndConfigKey(domain, key);
        existing.ifPresent(repo::delete);
        return existing.map(ConfigLockService::toView);
    }

    private static LockView toView(ConfigLockEntity entity) {
        return new LockView(entity.getId(), entity.getDomain(), entity.getConfigKey(),
                entity.getMode(), entity.getReason(), entity.getUpdatedBy(),
                entity.getUpdatedAt(), entity.getUpdatedAt().toEpochMilli());
    }

    /**
     * PostgreSQL-only transaction advisory lock keyed by {@code lock:domain:key}
     * (distinct namespace from {@code ConfigService.lockDomainScope}), so two
     * admins locking the same key serialize; H2 test databases keep the
     * unique-constraint-only semantics, same guard shape as the config writer.
     */
    private void lockDomainKey(String domain, String key) {
        if (em.getEntityManagerFactory().unwrap(org.hibernate.engine.spi.SessionFactoryImplementor.class)
                .getJdbcServices().getDialect() instanceof org.hibernate.dialect.PostgreSQLDialect) {
            String owner = "lock:" + domain + ":" + key;
            em.createNativeQuery("SELECT pg_advisory_xact_lock(hashtextextended(:owner, 0))")
                    .setParameter("owner", owner).getSingleResult();
        }
    }
}
