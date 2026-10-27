package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * PLAN-0556: the admin-facing lock workflow.
 *
 * <p>Owns the single transaction that writes the enforced instance value and
 * the lock row together (A2), the catalog the lock page renders, and the audit
 * trail. {@link ConfigService} stays the only authority on resolution and write
 * guards; this service never re-implements them.</p>
 */
@Service
public class ConfigLockAdminService {

    /** One row of the lock page: catalog entry plus current lock state. */
    public record KeyView(String key, boolean lockable, String notLockableReason,
                          boolean locked, String reason, String mode, String updatedBy,
                          Instant updatedAt, long revision, boolean valuePresent) {}

    public record CatalogView(String domain, long revision, List<KeyView> keys) {}

    private static final String MODE_ENFORCE = "enforce_value";
    private static final int REASON_MAX = 200;

    private final ConfigService configService;
    private final ConfigLockService lockService;
    private final AuditLogger auditLogger;

    public ConfigLockAdminService(ConfigService configService, ConfigLockService lockService,
                                  AuditLogger auditLogger) {
        this.configService = configService;
        this.lockService = lockService;
        this.auditLogger = auditLogger;
    }

    @Transactional(readOnly = true)
    public CatalogView catalog(String domain) {
        if (domain == null || domain.isBlank()) {
            List<KeyView> rows = new ArrayList<>();
            long revision = 0L;
            for (ConfigLockService.LockView lock : lockService.list(null)) {
                revision = Math.max(revision, lock.revision());
                rows.add(new KeyView(lock.key(), true, null, true, lock.reason(),
                        lock.mode(), lock.updatedBy(), lock.updatedAt(), lock.revision(),
                        configService.instanceValue(lock.domain(), lock.key()) != null));
            }
            return new CatalogView(null, revision, rows);
        }
        requireDomain(domain);
        Map<String, ConfigLockService.LockView> locks = new LinkedHashMap<>();
        for (ConfigLockService.LockView lock : lockService.list(domain)) {
            locks.put(lock.key(), lock);
        }
        List<KeyView> keys = new ArrayList<>();
        long revision = 0L;
        for (String key : configService.candidateKeys(domain)) {
            ConfigService.Lockability lockability = configService.lockability(domain, key);
            ConfigLockService.LockView lock = locks.get(key);
            if (lock != null) {
                revision = Math.max(revision, lock.revision());
            }
            keys.add(new KeyView(key, lockability.lockable(), lockability.reason(),
                    lock != null, lock == null ? null : lock.reason(),
                    lock == null ? null : lock.mode(),
                    lock == null ? null : lock.updatedBy(),
                    lock == null ? null : lock.updatedAt(),
                    lock == null ? 0L : lock.revision(),
                    configService.instanceValue(domain, key) != null));
        }
        return new CatalogView(domain, revision, keys);
    }

    /**
     * Locks a key: writes the enforced value to the instance layer and the lock
     * row in one transaction. The value is mandatory (A2) — a lock without a
     * value would silently degrade to the rejected write-guard semantics.
     */
    @Transactional
    public KeyView lock(String domain, String key, String mode, String reason, String value,
                        Long expectedRevision, String actor) {
        requireDomain(domain);
        ConfigService.Lockability lockability = configService.lockability(domain, key);
        if (!lockability.lockable()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "NOT_LOCKABLE",
                    "Config key is not lockable (" + lockability.reason() + "): " + key);
        }
        requireMode(mode);
        String cleanReason = cleanReason(reason);
        long current = lockService.revision(domain, key);
        requireRevision(current, expectedRevision);
        Optional<ConfigLockService.LockView> before = lockService.find(domain, key);
        String enforced = value == null || value.isBlank()
                ? configService.instanceValue(domain, key) : value;
        if (enforced == null || enforced.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "VALUE_REQUIRED",
                    "A locked key needs an enforced value: " + key);
        }
        configService.putInstanceLockValue(domain, key, enforced, "admin");
        ConfigLockService.LockView saved = lockService.upsert(domain, key, modeOf(mode), cleanReason, actor);
        audit(before.isPresent() ? "config_lock_updated" : "config_lock_set", saved, actor, cleanReason);
        return new KeyView(key, true, null, true, saved.reason(), saved.mode(),
                saved.updatedBy(), saved.updatedAt(), saved.revision(), true);
    }

    /** Unlocks a key; {@code clearValue} also removes the pinned instance value. */
    @Transactional
    public void unlock(String domain, String key, Long expectedRevision, boolean clearValue, String actor) {
        requireDomain(domain);
        long current = lockService.revision(domain, key);
        if (current == 0L) {
            return;
        }
        requireRevision(current, expectedRevision);
        Optional<ConfigLockService.LockView> removed = lockService.delete(domain, key);
        if (clearValue) {
            configService.deleteInstanceKeyUnlocked(domain, key, "admin");
        }
        removed.ifPresent(lock -> audit("config_lock_cleared", lock, actor, lock.reason()));
    }

    private void audit(String action, ConfigLockService.LockView lock, String actor, String reason) {
        // audit_logs.user_id is a UUID column: keep the raw actor in the detail
        // (''admin'' for the local/admin fallback) and only bind a real id.
        auditLogger.recordDurableChange(actorId(actor), null, action, "config_lock",
                lock.id().toString(),
                "actor=" + actor + " domain=" + lock.domain() + " key=" + lock.key()
                        + " mode=" + lock.mode() + " reason=" + reason);
    }

    private static String actorId(String actor) {
        try {
            return actor == null ? null : java.util.UUID.fromString(actor).toString();
        } catch (IllegalArgumentException notUuid) {
            return null;
        }
    }

    private static void requireDomain(String domain) {
        if (!ConfigService.UI_DOMAINS.contains(domain)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_DOMAIN",
                    "Config lock domain is not part of the settings UI: " + domain);
        }
    }

    private static void requireMode(String mode) {
        if (mode != null && !mode.isBlank() && !MODE_ENFORCE.equals(mode)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "UNSUPPORTED_MODE",
                    "Only enforce_value locks are supported in v1");
        }
    }

    private static String modeOf(String mode) {
        return mode == null || mode.isBlank() ? MODE_ENFORCE : mode;
    }

    private static void requireRevision(long current, Long expected) {
        long expectedValue = expected == null ? 0L : expected;
        if (expectedValue != current) {
            throw new CpApiException(HttpStatus.CONFLICT, "CONFIG_LOCK_CONFLICT",
                    "Config lock changed since it was read; reload and retry");
        }
    }

    private static String cleanReason(String reason) {
        String cleaned = reason == null ? "" : reason.replaceAll("[\\p{Cntrl}]", " ").trim();
        if (cleaned.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A lock reason is required");
        }
        if (cleaned.length() > REASON_MAX) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Lock reason must be at most " + REASON_MAX + " characters");
        }
        return cleaned;
    }
}
