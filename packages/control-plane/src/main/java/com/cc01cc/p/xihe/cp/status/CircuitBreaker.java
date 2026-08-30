package com.cc01cc.p.xihe.cp.status;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;

public class CircuitBreaker {

    private static final Logger logger = LoggerFactory.getLogger(CircuitBreaker.class);

    public enum State { CLOSED, OPEN, HALF_OPEN }

    private final String serviceName;
    private final int failureThreshold;
    private final Duration openTimeout;
    private final int halfOpenMaxProbes;

    private volatile State state = State.CLOSED;
    private volatile int failureCount = 0;
    private volatile Instant openedAt = Instant.now();
    private volatile int halfOpenProbes = 0;

    public CircuitBreaker(String serviceName, int failureThreshold, Duration openTimeout) {
        this(serviceName, failureThreshold, openTimeout, 1);
    }

    public CircuitBreaker(String serviceName, int failureThreshold, Duration openTimeout, int halfOpenMaxProbes) {
        this.serviceName = serviceName;
        this.failureThreshold = failureThreshold;
        this.openTimeout = openTimeout;
        this.halfOpenMaxProbes = halfOpenMaxProbes;
    }

    public boolean allowRequest() {
        if (state == State.CLOSED) {
            return true;
        }
        if (state == State.OPEN) {
            if (Duration.between(openedAt, Instant.now()).compareTo(openTimeout) >= 0) {
                transitionTo(State.HALF_OPEN);
                return true;
            }
            return false;
        }
        // HALF_OPEN: allow limited probes
        return halfOpenProbes < halfOpenMaxProbes;
    }

    public void recordSuccess() {
        if (state == State.HALF_OPEN) {
            halfOpenProbes++;
            if (halfOpenProbes >= halfOpenMaxProbes) {
                reset();
                logger.info("[LIFECYCLE] service=cp event=circuitBreakerClose service={}", serviceName);
            }
        } else if (state == State.CLOSED) {
            failureCount = 0;
        }
    }

    public void recordFailure() {
        if (state == State.HALF_OPEN) {
            transitionTo(State.OPEN);
            return;
        }
        failureCount++;
        if (failureCount >= failureThreshold) {
            transitionTo(State.OPEN);
        }
    }

    private void transitionTo(State newState) {
        State oldState = this.state;
        this.state = newState;
        if (newState == State.OPEN) {
            this.openedAt = Instant.now();
            this.halfOpenProbes = 0;
            logger.info("[LIFECYCLE] service=cp event=circuitBreakerOpen service={} failureCount={} timeoutSeconds={}",
                serviceName, failureCount, openTimeout.getSeconds());
        } else if (newState == State.HALF_OPEN) {
            this.halfOpenProbes = 0;
            logger.info("[LIFECYCLE] service=cp event=circuitBreakerHalfOpen service={}", serviceName);
        }
    }

    private void reset() {
        this.state = State.CLOSED;
        this.failureCount = 0;
        this.halfOpenProbes = 0;
    }

    public State getState() { return state; }
    public int failureCount() { return failureCount; }
    public String getServiceName() { return serviceName; }
}
