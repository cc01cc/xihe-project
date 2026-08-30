package com.cc01cc.p.xihe.cp.status;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.*;

class CircuitBreakerTest {

    @Test
    void closedStateAllowsRequests() {
        CircuitBreaker cb = new CircuitBreaker("test", 3, Duration.ofSeconds(30));
        assertTrue(cb.allowRequest());
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
    }

    @Test
    void opensAfterThresholdFailures() {
        CircuitBreaker cb = new CircuitBreaker("test", 3, Duration.ofSeconds(30));
        cb.recordFailure();
        cb.recordFailure();
        assertTrue(cb.allowRequest()); // still closed, 2 failures
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());

        cb.recordFailure(); // 3rd failure → open
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
        assertFalse(cb.allowRequest());
    }

    @Test
    void resetOnSuccess() {
        CircuitBreaker cb = new CircuitBreaker("test", 3, Duration.ofSeconds(30));
        cb.recordFailure();
        cb.recordFailure();
        cb.recordSuccess(); // resets failure count
        assertEquals(0, cb.failureCount());
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
    }

    @Test
    void halfOpenAfterTimeout() throws InterruptedException {
        CircuitBreaker cb = new CircuitBreaker("test", 2, Duration.ofMillis(100));
        cb.recordFailure();
        cb.recordFailure(); // opens
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());

        Thread.sleep(150); // wait for timeout
        assertTrue(cb.allowRequest()); // transitions to half-open
        assertEquals(CircuitBreaker.State.HALF_OPEN, cb.getState());
    }

    @Test
    void halfOpenClosesOnProbeSuccess() throws InterruptedException {
        CircuitBreaker cb = new CircuitBreaker("test", 2, Duration.ofMillis(100));
        cb.recordFailure();
        cb.recordFailure();
        Thread.sleep(150);
        cb.allowRequest(); // half-open
        cb.recordSuccess(); // probe success → close
        assertEquals(CircuitBreaker.State.CLOSED, cb.getState());
        assertEquals(0, cb.failureCount());
    }

    @Test
    void halfOpenReopensOnProbeFailure() throws InterruptedException {
        CircuitBreaker cb = new CircuitBreaker("test", 2, Duration.ofMillis(100));
        cb.recordFailure();
        cb.recordFailure();
        Thread.sleep(150);
        cb.allowRequest(); // half-open
        cb.recordFailure(); // probe failure → reopen
        assertEquals(CircuitBreaker.State.OPEN, cb.getState());
    }
}
