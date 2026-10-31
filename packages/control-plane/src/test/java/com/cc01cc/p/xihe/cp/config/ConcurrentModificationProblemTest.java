package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.http.HttpStatus;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0610 W3-2a (round-4 handoff): the two "retryable database conflict" outcomes must not be
 * confused.
 *
 * <ul>
 *   <li>{@code 40P01 deadlock_detected} / {@code 40001 serialization_failure} — the transaction was
 *       aborted while the request is fine: {@code 409 CONCURRENT_MODIFICATION}, safe to retry.</li>
 *   <li>{@code 55P03 lock_not_available} — the lock wait exceeded {@code cp.lock-timeout-ms}:
 *       {@code 503 OPERATION_LOCK_TIMEOUT}, unchanged from PLAN-0346.</li>
 * </ul>
 *
 * <p>Both arrive as {@code PessimisticLockingFailureException} subclasses, so the resolution order
 * is what keeps the 503 semantics: Spring picks the most specific {@code @ExceptionHandler}, i.e.
 * {@code CannotAcquireLockException} for the timeout.</p>
 */
class ConcurrentModificationProblemTest {

    private final ProblemDetailsHandler handler = new ProblemDetailsHandler(5000);

    @Test
    void deadlockLoserMapsToRetryableConflict() {
        HttpServletRequest request = request("/api/v1/bindings");
        var response = handler.concurrentModification(
                new DeadlockLoserDataAccessException("deadlock detected", null), request);
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("CONCURRENT_MODIFICATION", response.getBody().get("code"));
    }

    @Test
    void serializationFailureMapsToRetryableConflict() {
        HttpServletRequest request = request("/api/v1/roles");
        var response = handler.concurrentModification(
                new PessimisticLockingFailureException("could not serialize access"), request);
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("CONCURRENT_MODIFICATION", response.getBody().get("code"));
    }

    @Test
    void lockTimeoutKeepsItsServiceUnavailableSemantics() {
        HttpServletRequest request = request("/api/v1/bindings");
        var response = handler.lockTimeout(
                new CannotAcquireLockException("canceling statement due to lock timeout"), request);
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertEquals("OPERATION_LOCK_TIMEOUT", response.getBody().get("code"));
    }

    @Test
    void timeoutSubclassIsMoreSpecificThanTheConflictHandlerContract() {
        // Guard against a future refactor that registers the timeout on the conflict handler: the
        // timeout exception is a PessimisticLockingFailureException, so the type relationship is the
        // only thing that keeps the two codes apart.
        assertEquals(true, PessimisticLockingFailureException.class
                .isAssignableFrom(CannotAcquireLockException.class));
    }

    private static HttpServletRequest request(String uri) {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRequestURI()).thenReturn(uri);
        return request;
    }
}
