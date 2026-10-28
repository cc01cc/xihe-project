package com.cc01cc.p.xihe.cp.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.logging.RequestIdFilter;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PLAN-0558: login brute-force protection.
 *
 * <p>Account and source-IP failures are counted in fixed windows. A lock blocks
 * new login attempts (but never revokes existing tokens). Counters live in a
 * bounded in-process table: a full table never evicts a locked or failing
 * record, and simply stops tracking a brand-new key (the IP dimension still
 * applies). BCrypt work is bounded by a global fair semaphore so the auth
 * endpoint cannot occupy every carrier thread.</p>
 */
@Service
public class LoginAttemptService {

    private static final Logger logger = LoggerFactory.getLogger(LoginAttemptService.class);
    private static final Set<String> DURABLE_ACTIONS = Set.of("login_locked", "login_unlocked");

    private final int accountMaxFailures;
    private final long accountWindowSeconds;
    private final long accountLockSeconds;
    private final int accountMaxConcurrent;
    private final int ipMaxFailures;
    private final long ipWindowSeconds;
    private final long ipLockSeconds;
    private final int maxTrackedKeys;
    private final int registerMaxAttempts;
    private final long registerWindowSeconds;
    private final long registerLockSeconds;
    private final boolean registerExemptLoopback;
    private final Clock clock;
    private final AuditLogger auditLogger;
    private final Semaphore bcryptSlots;

    private final Object lock = new Object();
    private final LinkedHashMap<String, AttemptRecord> accounts =
            new LinkedHashMap<>(16, 0.75f, true);
    private final LinkedHashMap<String, AttemptRecord> ips =
            new LinkedHashMap<>(16, 0.75f, true);
    private final LinkedHashMap<String, AttemptRecord> registerIps =
            new LinkedHashMap<>(16, 0.75f, true);

    @Autowired
    public LoginAttemptService(
            @Value("${cp.auth.login.account.max-failures:5}") int accountMaxFailures,
            @Value("${cp.auth.login.account.window-seconds:900}") long accountWindowSeconds,
            @Value("${cp.auth.login.account.lock-seconds:900}") long accountLockSeconds,
            @Value("${cp.auth.login.account.max-concurrent:2}") int accountMaxConcurrent,
            @Value("${cp.auth.login.ip.max-failures:20}") int ipMaxFailures,
            @Value("${cp.auth.login.ip.window-seconds:900}") long ipWindowSeconds,
            @Value("${cp.auth.login.ip.lock-seconds:900}") long ipLockSeconds,
            @Value("${cp.auth.login.global-max-concurrent:4}") int globalMaxConcurrent,
            @Value("${cp.auth.login.max-tracked-keys:10000}") int maxTrackedKeys,
            @Value("${cp.auth.login.register.max-attempts:30}") int registerMaxAttempts,
            @Value("${cp.auth.login.register.window-seconds:3600}") long registerWindowSeconds,
            @Value("${cp.auth.login.register.lock-seconds:1800}") long registerLockSeconds,
            @Value("${cp.auth.login.register.exempt-loopback:true}") boolean registerExemptLoopback,
            AuditLogger auditLogger) {
        this(accountMaxFailures, accountWindowSeconds, accountLockSeconds, accountMaxConcurrent,
                ipMaxFailures, ipWindowSeconds, ipLockSeconds, globalMaxConcurrent, maxTrackedKeys,
                registerMaxAttempts, registerWindowSeconds, registerLockSeconds,
                registerExemptLoopback, Clock.systemUTC(), auditLogger);
    }

    LoginAttemptService(int accountMaxFailures, long accountWindowSeconds, long accountLockSeconds,
            int accountMaxConcurrent, int ipMaxFailures, long ipWindowSeconds, long ipLockSeconds,
            int globalMaxConcurrent, int maxTrackedKeys, int registerMaxAttempts,
            long registerWindowSeconds, long registerLockSeconds, boolean registerExemptLoopback,
            Clock clock, AuditLogger auditLogger) {
        this.accountMaxFailures = Math.max(0, accountMaxFailures);
        this.accountWindowSeconds = Math.max(1, accountWindowSeconds);
        this.accountLockSeconds = Math.max(1, accountLockSeconds);
        this.accountMaxConcurrent = Math.max(0, accountMaxConcurrent);
        this.ipMaxFailures = Math.max(0, ipMaxFailures);
        this.ipWindowSeconds = Math.max(1, ipWindowSeconds);
        this.ipLockSeconds = Math.max(1, ipLockSeconds);
        this.maxTrackedKeys = Math.max(0, maxTrackedKeys);
        this.registerMaxAttempts = Math.max(0, registerMaxAttempts);
        this.registerWindowSeconds = Math.max(1, registerWindowSeconds);
        this.registerLockSeconds = Math.max(1, registerLockSeconds);
        this.registerExemptLoopback = registerExemptLoopback;
        this.clock = clock;
        this.auditLogger = auditLogger;
        this.bcryptSlots = globalMaxConcurrent > 0 ? new Semaphore(globalMaxConcurrent, true) : null;
    }

    /** Pre-check for a login attempt; returns a lease that must be released. */
    public Lease beginLogin(String email, String ip) {
        String accountKey = accountKey(email);
        String ipKey = ipKey(ip);
        if (accountMaxFailures == 0 && ipMaxFailures == 0) {
            return new Lease(accountKey, ipKey, false);
        }
        Instant now = clock.instant();
        synchronized (lock) {
            AttemptRecord account = recordFor(accounts, accountKey, now, accountWindowSeconds);
            AttemptRecord ipRecord = recordFor(ips, ipKey, now, ipWindowSeconds);
            refreshWindow(account, now);
            refreshWindow(ipRecord, now);
            long retry = Math.max(retryAfter(account, now), retryAfter(ipRecord, now));
            if (retry > 0) {
                throw new LoginThrottledException((int) retry);
            }
            if (account != null && accountMaxConcurrent > 0
                    && account.inFlight >= accountMaxConcurrent) {
                throw new LoginThrottledException(1);
            }
            if (account != null) {
                account.inFlight++;
            }
            return new Lease(accountKey, ipKey, account != null);
        }
    }

    /** Acquires a global BCrypt slot; false means the caller must return 429. */
    public boolean tryAcquireBcryptSlot() {
        return bcryptSlots == null || bcryptSlots.tryAcquire();
    }

    public void releaseBcryptSlot() {
        if (bcryptSlots != null) {
            bcryptSlots.release();
        }
    }

    /** Counts a credential-only failure and writes the audit events outside the lock. */
    public void recordCredentialFailure(Lease lease) {
        if (lease == null) {
            return;
        }
        Instant now = clock.instant();
        List<AuthAuditEvent> events = new ArrayList<>();
        synchronized (lock) {
            AttemptRecord account = accounts.get(lease.accountKey);
            AttemptRecord ipRecord = ips.get(lease.ipKey);
            countFailure(account, now, accountMaxFailures, accountWindowSeconds,
                    accountLockSeconds, "account", lease.ipKey, events);
            countFailure(ipRecord, now, ipMaxFailures, ipWindowSeconds,
                    ipLockSeconds, "ip", lease.ipKey, events);
        }
        events.add(new AuthAuditEvent("login_failed", AuthLog.maskEmail(lease.accountKey),
                lease.ipKey, "credential"));
        emit(events);
    }

    /** A successful credential check resets the account bucket only. */
    public void recordSuccess(Lease lease) {
        if (lease == null) {
            return;
        }
        Instant now = clock.instant();
        List<AuthAuditEvent> events = new ArrayList<>();
        synchronized (lock) {
            AttemptRecord account = accounts.get(lease.accountKey);
            if (account != null) {
                if (account.lockedUntil != null && !account.unlockAudited) {
                    account.unlockAudited = true;
                    events.add(new AuthAuditEvent("login_unlocked",
                            AuthLog.maskEmail(lease.accountKey), lease.ipKey, "account"));
                }
                account.failures = 0;
                account.lockedUntil = null;
                account.windowStart = now;
                account.lastSeen = now;
            }
        }
        emit(events);
    }

    /** The single release point; idempotent. */
    public void release(Lease lease) {
        if (lease == null || !lease.released.compareAndSet(false, true)) {
            return;
        }
        synchronized (lock) {
            AttemptRecord account = accounts.get(lease.accountKey);
            if (account != null && account.inFlight > 0) {
                account.inFlight--;
            }
        }
    }

    /** Counts every register request from an IP; throws when the limit is reached. */
    public void checkAndRecordRegister(String rawIp, String bucketKeyIp) {
        if (registerMaxAttempts == 0) {
            return;
        }
        String key = ipKey(bucketKeyIp);
        // PLAN-0571: loopback is judged on the raw client address. The /64
        // aggregation bucket of ::1 is the unspecified ::, which is not a
        // loopback address, so judging on the bucket key defeated the
        // register.exempt-loopback knob for IPv6 localhost.
        if (registerExemptLoopback && isLoopback(ipKey(rawIp))) {
            return;
        }
        Instant now = clock.instant();
        synchronized (lock) {
            AttemptRecord record = recordFor(registerIps, key, now, registerWindowSeconds);
            if (record == null) {
                return;
            }
            refreshWindow(record, now);
            long retry = retryAfter(record, now);
            if (retry > 0) {
                throw new LoginThrottledException((int) retry);
            }
            record.failures++;
            record.lastSeen = now;
            if (record.failures >= registerMaxAttempts) {
                record.lockedUntil = now.plusSeconds(registerLockSeconds);
                record.unlockAudited = false;
                throw new LoginThrottledException((int) registerLockSeconds);
            }
        }
    }

    @Scheduled(fixedDelayString = "${cp.auth.login.cleanup-interval-ms:60000}")
    public void sweep() {
        Instant now = clock.instant();
        List<AuthAuditEvent> events = new ArrayList<>();
        synchronized (lock) {
            sweepMap(accounts, now, "account", events);
            sweepMap(ips, now, "ip", events);
            sweepMap(registerIps, now, "register", events);
        }
        emit(events);
    }

    private void countFailure(AttemptRecord record, Instant now, int maxFailures,
            long windowSeconds, long lockSeconds, String reason, String requestIp,
            List<AuthAuditEvent> events) {
        if (record == null) {
            return;
        }
        refreshWindow(record, now);
        record.lastSeen = now;
        record.lastIp = requestIp;
        if (isLocked(record, now)) {
            return;
        }
        record.failures++;
        if (maxFailures > 0 && record.failures >= maxFailures) {
            record.lockedUntil = now.plusSeconds(lockSeconds);
            record.unlockAudited = false;
            events.add(new AuthAuditEvent("login_locked", reason.equals("account")
                    ? AuthLog.maskEmail(record.key) : "***",
                    reason.equals("ip") ? record.key : requestIp, reason));
        }
    }

    private void sweepMap(LinkedHashMap<String, AttemptRecord> map, Instant now,
            String kind, List<AuthAuditEvent> events) {
        Iterator<Map.Entry<String, AttemptRecord>> iterator = map.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, AttemptRecord> entry = iterator.next();
            AttemptRecord record = entry.getValue();
            if (record.lockedUntil != null && !record.lockedUntil.isAfter(now)) {
                if (!record.unlockAudited && !"register".equals(kind)) {
                    record.unlockAudited = true;
                    events.add(new AuthAuditEvent("login_unlocked",
                            "account".equals(kind) ? AuthLog.maskEmail(entry.getKey()) : "***",
                            record.lastIp != null ? record.lastIp : entry.getKey(), kind));
                }
                record.lockedUntil = null;
                record.failures = 0;
                record.windowStart = now;
            }
            if (record.inFlight == 0 && record.lockedUntil == null
                    && windowExpired(record, now)) {
                iterator.remove();
            }
        }
    }

    private AttemptRecord recordFor(LinkedHashMap<String, AttemptRecord> map,
            String key, Instant now, long windowSeconds) {
        AttemptRecord existing = map.get(key);
        if (existing != null) {
            existing.lastSeen = now;
            return existing;
        }
        if (maxTrackedKeys > 0 && map.size() >= maxTrackedKeys) {
            pruneExpired(map, now);
            if (map.size() >= maxTrackedKeys && !evictClean(map)) {
                logger.warn("Login attempt table is full; not tracking a new key (size={})",
                        map.size());
                return null;
            }
        }
        AttemptRecord created = new AttemptRecord(key, windowSeconds);
        map.put(key, created);
        return created;
    }

    private void pruneExpired(LinkedHashMap<String, AttemptRecord> map, Instant now) {
        Iterator<Map.Entry<String, AttemptRecord>> iterator = map.entrySet().iterator();
        while (iterator.hasNext()) {
            AttemptRecord record = iterator.next().getValue();
            if (record.inFlight == 0 && record.lockedUntil == null
                    && windowExpired(record, now)) {
                iterator.remove();
            }
        }
    }

    private boolean evictClean(LinkedHashMap<String, AttemptRecord> map) {
        Iterator<Map.Entry<String, AttemptRecord>> iterator = map.entrySet().iterator();
        while (iterator.hasNext()) {
            AttemptRecord record = iterator.next().getValue();
            if (record.failures == 0 && record.lockedUntil == null && record.inFlight == 0) {
                iterator.remove();
                return true;
            }
        }
        return false;
    }

    private static void refreshWindow(AttemptRecord record, Instant now) {
        if (record == null) {
            return;
        }
        if (record.windowStart == null || !now.isBefore(record.windowStart.plusSeconds(
                record.windowSeconds))) {
            record.windowStart = now;
            record.failures = 0;
        }
    }

    private static boolean windowExpired(AttemptRecord record, Instant now) {
        return record.windowStart == null
                || !now.isBefore(record.windowStart.plusSeconds(record.windowSeconds));
    }

    private static boolean isLocked(AttemptRecord record, Instant now) {
        return record.lockedUntil != null && record.lockedUntil.isAfter(now);
    }

    private static long retryAfter(AttemptRecord record, Instant now) {
        if (record == null || !isLocked(record, now)) {
            return 0;
        }
        Duration remaining = Duration.between(now, record.lockedUntil);
        long seconds = remaining.toMillis() / 1000;
        if (remaining.toMillis() % 1000 != 0) {
            seconds++;
        }
        return Math.max(1, seconds);
    }

    private static String accountKey(String email) {
        return email == null || email.isBlank()
                ? "unknown" : email.trim().toLowerCase(Locale.ROOT);
    }

    private static String ipKey(String ip) {
        return ip == null || ip.isBlank() ? "unknown" : ip;
    }

    private static boolean isLoopback(String ip) {
        try {
            return InetAddress.getByName(ip).isLoopbackAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }

    private void emit(List<AuthAuditEvent> events) {
        if (events.isEmpty()) {
            return;
        }
        String requestId = AuthLog.safeRequestId(MDC.get(RequestIdFilter.MDC_KEY));
        for (AuthAuditEvent event : events) {
            try {
                auditLogger.recordAuthEvent(event.action(), event.email(), event.ip(),
                        requestId, event.reason(), null);
            } catch (RuntimeException e) {
                // Audit failure must not block a login attempt.
                logger.error("Failed to emit auth audit action={}", event.action(), e);
            }
        }
    }

    /** A single-release lease; the caller must call {@link #release(Lease)} in finally. */
    public static final class Lease {

        private final String accountKey;
        private final String ipKey;
        private final boolean accountTracked;
        private final AtomicBoolean released = new AtomicBoolean();

        private Lease(String accountKey, String ipKey, boolean accountTracked) {
            this.accountKey = accountKey;
            this.ipKey = ipKey;
            this.accountTracked = accountTracked;
        }

        boolean isAccountTracked() {
            return accountTracked;
        }
    }

    private static final class AttemptRecord {

        private final String key;
        private final long windowSeconds;
        private Instant windowStart;
        private int failures;
        private Instant lockedUntil;
        private int inFlight;
        private boolean unlockAudited;
        private String lastIp;
        private Instant lastSeen;

        private AttemptRecord(String key, long windowSeconds) {
            this.key = key;
            this.windowSeconds = windowSeconds;
        }
    }

    private record AuthAuditEvent(String action, String email, String ip, String reason) {}
}


