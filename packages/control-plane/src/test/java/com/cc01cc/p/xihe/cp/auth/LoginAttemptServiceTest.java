package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

class LoginAttemptServiceTest {

    private static final Instant START = Instant.parse("2026-10-27T00:00:00Z");

    private static LoginAttemptService service(MutableClock clock, int accountMax, int ipMax,
            int accountConcurrent, int globalMax, int maxKeys, int registerMax,
            AuditLogger auditLogger) {
        return new LoginAttemptService(accountMax, 900, 60, accountConcurrent,
                ipMax, 900, 60, globalMax, maxKeys, registerMax, 3600, 1800, true,
                clock, auditLogger);
    }

    @Test
    void accountThreshold_locksAndEmitsAudit() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 2, 100, 2, 4, 100, 0, audit);

        failTimes(service, "a@test.com", "203.0.113.10", 2);

        LoginThrottledException throttled = assertThrows(LoginThrottledException.class,
                () -> service.beginLogin("a@test.com", "203.0.113.10"));
        assertTrue(throttled.getRetryAfterSeconds() > 0);
        verify(audit, times(1)).recordAuthEvent(eq("login_locked"), anyString(), anyString(),
                anyString(), eq("account"), any());
    }

    @Test
    void windowExpiry_unlocksAfterLockSeconds() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 1, 100, 2, 4, 100, 0, audit);

        failTimes(service, "a@test.com", "203.0.113.10", 1);
        assertThrows(LoginThrottledException.class,
                () -> service.beginLogin("a@test.com", "203.0.113.10"));

        clock.advance(Duration.ofSeconds(61));
        assertDoesNotThrow(() -> service.beginLogin("a@test.com", "203.0.113.10"));
    }

    @Test
    void successResetsAccountButNotIp() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 2, 2, 2, 4, 100, 0, audit);

        failTimes(service, "a@test.com", "203.0.113.10", 1);
        LoginAttemptService.Lease success = service.beginLogin("a@test.com", "203.0.113.10");
        service.recordSuccess(success);
        service.release(success);

        failTimes(service, "a@test.com", "203.0.113.10", 1);
        // Account failures were reset by the success, but the IP bucket still locks.
        assertThrows(LoginThrottledException.class,
                () -> service.beginLogin("a@test.com", "203.0.113.10"));
    }

    @Test
    void accountConcurrency_limitsParallelAttempts() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 100, 100, 1, 4, 100, 0, audit);

        LoginAttemptService.Lease lease = service.beginLogin("a@test.com", "203.0.113.10");
        assertThrows(LoginThrottledException.class,
                () -> service.beginLogin("a@test.com", "203.0.113.10"));
        service.release(lease);
        assertDoesNotThrow(() -> service.beginLogin("a@test.com", "203.0.113.10"));
    }

    @Test
    void globalBcryptSemaphore_limitsAndReleases() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 100, 100, 2, 1, 100, 0, audit);

        assertTrue(service.tryAcquireBcryptSlot());
        assertFalse(service.tryAcquireBcryptSlot());
        service.releaseBcryptSlot();
        assertTrue(service.tryAcquireBcryptSlot());
    }

    @Test
    void release_isIdempotent() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 100, 100, 1, 4, 100, 0, audit);

        LoginAttemptService.Lease lease = service.beginLogin("a@test.com", "203.0.113.10");
        service.release(lease);
        service.release(lease);
        assertDoesNotThrow(() -> service.beginLogin("a@test.com", "203.0.113.10"));
    }

    @Test
    void successAfterExpiry_emitsUnlockOnce() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 1, 100, 2, 4, 100, 0, audit);

        failTimes(service, "a@test.com", "203.0.113.10", 1);
        clock.advance(Duration.ofSeconds(61));

        LoginAttemptService.Lease lease = service.beginLogin("a@test.com", "203.0.113.10");
        service.recordSuccess(lease);
        service.release(lease);
        LoginAttemptService.Lease second = service.beginLogin("a@test.com", "203.0.113.10");
        service.recordSuccess(second);
        service.release(second);

        verify(audit, times(1)).recordAuthEvent(eq("login_unlocked"), anyString(), anyString(),
                anyString(), eq("account"), any());
    }

    @Test
    void sweep_emitsUnlockOnce() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 1, 100, 2, 4, 100, 0, audit);

        failTimes(service, "a@test.com", "203.0.113.10", 1);
        clock.advance(Duration.ofSeconds(61));
        service.sweep();
        service.sweep();
        verify(audit, times(1)).recordAuthEvent(eq("login_unlocked"), anyString(), anyString(),
                anyString(), eq("account"), any());
    }

    @Test
    void fullTable_neverEvictsLockedRecord() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 2, 100, 2, 4, 1, 0, audit);

        failTimes(service, "a@test.com", "203.0.113.10", 2);
        // A new account key cannot be tracked while the only slot holds a lock,
        // but the request itself is not rejected by the account dimension.
        LoginAttemptService.Lease other = assertDoesNotThrow(
                () -> service.beginLogin("b@test.com", "203.0.113.10"));
        service.release(other);
        // The locked account must still be locked.
        assertThrows(LoginThrottledException.class,
                () -> service.beginLogin("a@test.com", "203.0.113.10"));
    }

    @Test
    void accountKey_isTrimmedAndLowercased() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 2, 100, 2, 4, 100, 0, audit);

        failTimes(service, " A@X.COM ", "203.0.113.10", 1);
        failTimes(service, "a@x.com", "203.0.113.10", 1);
        assertThrows(LoginThrottledException.class,
                () -> service.beginLogin("A@x.com", "203.0.113.10"));
    }

    @Test
    void registerLoopbackExempt_butPublicIpLimited() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        LoginAttemptService service = service(clock, 100, 100, 2, 4, 100, 2, audit);

        assertDoesNotThrow(() -> service.checkAndRecordRegister("127.0.0.1"));
        assertDoesNotThrow(() -> service.checkAndRecordRegister("203.0.113.10"));
        assertThrows(LoginThrottledException.class,
                () -> service.checkAndRecordRegister("203.0.113.10"));
    }

    @Test
    void auditFailure_doesNotBreakCredentialFailure() {
        MutableClock clock = new MutableClock(START);
        AuditLogger audit = mock(AuditLogger.class);
        doThrow(new IllegalStateException("audit sink down"))
                .when(audit).recordAuthEvent(anyString(), anyString(), anyString(),
                        anyString(), anyString(), any());
        LoginAttemptService service = service(clock, 5, 100, 2, 4, 100, 0, audit);

        LoginAttemptService.Lease lease = service.beginLogin("a@test.com", "203.0.113.10");
        assertDoesNotThrow(() -> service.recordCredentialFailure(lease));
        service.release(lease);
    }

    private static void failTimes(LoginAttemptService service, String email, String ip, int times) {
        for (int i = 0; i < times; i++) {
            LoginAttemptService.Lease lease = service.beginLogin(email, ip);
            service.recordCredentialFailure(lease);
            service.release(lease);
        }
    }

    private static final class MutableClock extends Clock {

        private Instant now;

        private MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}

